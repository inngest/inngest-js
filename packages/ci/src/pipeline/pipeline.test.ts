/**
 * End-to-end tests of pipelines, jobs, machines, caching and reporting,
 driven through the fake sandbox API.
 *
 * @module
 */

import { NonRetriableError } from "inngest";
import { afterEach, describe, expect, test, vi } from "vitest";
import { files, memoryCacheStore } from "../cache/cache.ts";
import {
  CiUsageError,
  CommandFailedError,
  CommandTimeoutError,
} from "../errors.ts";
import { consoleReporter, githubToken } from "../github/auth.ts";
import { github } from "../github/index.ts";
import { $ } from "../machine/command.ts";
import { from } from "../machine/from.ts";
import { destroyRunMachines, machineSetupScript } from "../machine/machine.ts";
import { sandbox } from "../machine/sandbox.ts";
import { report } from "../report.ts";
import { createCiTestClient } from "../testing/client.ts";
import { createFakeGitHub } from "../testing/fakeGitHub.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import { fakeSchema } from "../testing/schema.ts";
import type { CacheStore } from "../types.ts";
import { createCi, createCiWithStore } from "./createCi.ts";
import { destroyOrphans } from "./pipeline.ts";
import { getRunScope } from "./scope.ts";

const prEvent = {
  name: "github/pull_request.opened",
  data: {
    action: "opened",
    number: 7,
    repository: { full_name: "inngest/inngest-js" },
    pull_request: {
      number: 7,
      head: {
        sha: "abc1234",
        ref: "feature",
        repo: { full_name: "inngest/inngest-js" },
      },
      base: { sha: "def5678", ref: "main" },
    },
    _github: { event: "pull_request", installationId: 1 },
  },
};

const prTrigger = [{ event: "github/pull_request.opened" }];

/** The commands a job asked for, without CI's own machine setup. */
const userCommands = (api: ReturnType<typeof createFakeSandboxApi>) => {
  return api.commands.filter((argv) => {
    return argv[2] !== machineSetupScript;
  });
};

const setup = (
  opts: {
    cacheStore?: CacheStore;
    api?: ReturnType<typeof createFakeSandboxApi>;
  } = {},
) => {
  const api = opts.api ?? createFakeSandboxApi();
  const client = createCiTestClient(api);
  const reporter = consoleReporter();

  const ci = createCiWithStore(
    client,
    {
      github: reporter,
      runUrl: ({ runId }) => {
        return `http://localhost:8288/run?runID=${runId}`;
      },
    },
    opts.cacheStore ?? memoryCacheStore(),
  );

  return { api, client, ci, reporter };
};

describe("pipelines and jobs", () => {
  test("a job runs its commands on its own machine", async () => {
    const { api, ci } = setup();

    const test = ci.job("test", async () => {
      await $`pnpm install`;

      await $`pnpm test`;

      return "done";
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return test();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(result.data).toBe("done");

    expect(userCommands(api)).toEqual([
      ["pnpm", "install"],
      ["pnpm", "test"],
    ]);

    expect(api.sandboxes.size).toBe(1);
    expect([...api.sandboxes.values()][0]?.name).toBe("ci-01TESTRUN-test");
  });

  test("a new machine is set up before its first command", async () => {
    const { api, ci } = setup();

    const job = ci.job("build", async () => {
      await $`pnpm build`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return job();
    });

    await runFunction(pipeline, { event: prEvent });

    // Without `checkout()`, nothing else would create `/work`, and a sandbox
    // won't start a process in a directory that doesn't exist. Loopback is
    // brought up too, since sandboxes currently boot with it down.
    expect(api.commands).toEqual([
      ["/bin/sh", "-c", machineSetupScript],
      ["pnpm", "build"],
    ]);

    expect(machineSetupScript).toContain("mkdir -p /work");
    expect(machineSetupScript).toContain("ip link set lo up");
  });

  test("a job with no commands never creates a machine", async () => {
    const { api, ci } = setup();

    const deploy = ci.job("deploy", async () => {
      return { url: "https://preview" };
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return deploy();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(result.data).toEqual({ url: "https://preview" });
    expect(api.sandboxes.size).toBe(0);
  });

  test("two callers share one job run", async () => {
    const { api, ci } = setup();

    const build = ci.job("build", async () => {
      await $`pnpm build`;

      return "built";
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      const [a, b] = await Promise.all([build(), build()]);

      return { a, b };
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.data).toEqual({ a: "built", b: "built" });
    // One machine and one command, however many callers there were.
    expect(api.sandboxes.size).toBe(1);

    expect(
      userCommands(api).filter((argv) => {
        return argv[1] === "build";
      }),
    ).toHaveLength(1);
  });

  test("step IDs inside a job are scoped to it", async () => {
    const { ci } = setup();

    const one = ci.job("one", async () => {
      await $`echo one`;
    });

    const two = ci.job("two", async () => {
      await $`echo two`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await one();

      await two();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.stepIds).toContain("one › machine");
    expect(result.stepIds).toContain("two › machine");

    expect(
      result.stepIds.some((id) => {
        return id.startsWith("one › echo one");
      }),
    ).toBe(true);

    expect(
      result.stepIds.some((id) => {
        return id.startsWith("two › echo two");
      }),
    ).toBe(true);
  });

  test("repeating a command adds a counter to its step ID", async () => {
    const { ci } = setup();

    const job = ci.job("build", async () => {
      await $`pnpm build`;

      await $`pnpm build`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return job();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    const buildSteps = result.stepIds.filter((id) => {
      return id.startsWith("build › pnpm build");
    });

    expect(
      buildSteps.some((id) => {
        return id.includes("#2");
      }),
    ).toBe(true);
  });

  test("`.as()` names the step", async () => {
    const { ci } = setup();

    const job = ci.job("build", async () => {
      await $`pnpm build --filter web`.as("build web");
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return job();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(
      result.stepIds.some((id) => {
        return id.includes("build › build web");
      }),
    ).toBe(true);
  });

  test("a job called outside a pipeline throws", async () => {
    const { ci } = setup();

    const job = ci.job("test", async () => {
      return undefined;
    });

    await expect(job()).rejects.toBeInstanceOf(CiUsageError);
  });

  test("`$` outside a job explains what to do", async () => {
    const { ci } = setup();

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await $`pnpm test`;
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-rejected");

    expect(String((result.error as { message?: string })?.message)).toContain(
      "Wrap it in `ci.job()`",
    );
  });
});

describe("a job's input schema", () => {
  const input = fakeSchema<{ target: string; minify: boolean }>(
    { target: "string", minify: "boolean" },
    { minify: true },
  );

  test("validates the input before the job runs, and gives the handler the result", async () => {
    const { api, ci } = setup();

    const build = ci.job({ id: "build", input }, async ({ target, minify }) => {
      await $`pnpm build --target ${target}`;

      return { target, minify };
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return build({ target: "web" });
    });

    const result = await runFunction(pipeline, { event: prEvent });

    // The default was applied.
    expect(result.data).toEqual({ target: "web", minify: true });
    expect(userCommands(api)).toHaveLength(1);
  });

  test("an input that doesn't match throws a usage error listing each issue, and runs nothing", async () => {
    const { api, ci } = setup();

    const build = ci.job({ id: "build", input }, async () => {
      await $`pnpm build`;
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, retries: 0 },
      async () => {
        return build({ minify: "yes" });
      },
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-rejected");
    expect(result.retriable).toBe(false);

    const message = String((result.error as Error).message);

    expect(message).toContain('"build"');
    expect(message).toContain("target: Required");
    expect(message).toContain("minify: Expected boolean");
    expect(api.sandboxes.size).toBe(0);
  });

  test("is checked when a job is started from, too", async () => {
    const { ci } = setup();

    const base = ci.job({ id: "base", input }, async ({ target }) => {
      await $`pnpm install --target ${target}`;

      return target;
    });

    const test = ci.job("test", async () => {
      return from(base, { target: "web" });
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return test();
    });

    expect((await runFunction(pipeline, { event: prEvent })).data).toBe("web");
  });

  test("a job without a schema takes its input as given", async () => {
    const { ci } = setup();

    const greet = ci.job("greet", async (name: string) => {
      return name;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return greet("jack");
    });

    expect((await runFunction(pipeline, { event: prEvent })).data).toBe("jack");
  });
});

describe("commands", () => {
  test("a non-zero exit fails the job with its output", async () => {
    const { api, ci } = setup();

    api.script([{ match: "pnpm test", exitCode: 1, stderr: "1 test failed" }]);

    const job = ci.job("test", async () => {
      await $`pnpm test`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return job();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-rejected");

    expect(String((result.error as { message?: string })?.message)).toContain(
      "`pnpm test` exited with 1",
    );

    // Retrying the run would only replay the recorded exit code.
    expect(result.retriable).toBe(false);
  });

  test("`.nothrow()` returns the exit code instead", async () => {
    const { api, ci } = setup();

    api.script([{ match: "pnpm lint", exitCode: 3, stdout: "nope" }]);

    const job = ci.job("lint", async () => {
      const result = await $`pnpm lint`.nothrow();

      return result.exitCode;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return job();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(result.data).toBe(3);
  });

  test("`.text()` reads stdout", async () => {
    const { api, ci } = setup();

    api.script([{ match: "git rev-parse", stdout: "abc1234\n" }]);

    const job = ci.job("sha", async () => {
      return $`git rev-parse HEAD`.text();
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return job();
    });

    expect((await runFunction(pipeline, { event: prEvent })).data).toBe(
      "abc1234",
    );
  });

  test("`.lines()` and `.json()` parse stdout", async () => {
    const { api, ci } = setup();

    api.script([
      { match: "list", stdout: "a\nb\n" },
      { match: "config", stdout: '{"ok":true}' },
    ]);

    const job = ci.job("read", async () => {
      return {
        lines: await $`list`.lines(),
        json: await $`config`.json<{ ok: boolean }>(),
      };
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return job();
    });

    expect((await runFunction(pipeline, { event: prEvent })).data).toEqual({
      lines: ["a", "b"],
      json: { ok: true },
    });
  });

  test("`.retries()` reruns a failing command as new steps", async () => {
    const { api, ci } = setup();

    api.script([{ match: "flaky", exitCode: 1, stderr: "flake" }]);

    const job = ci.job("test", async () => {
      await $`flaky`.retries(1);
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return job();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-rejected");

    expect(
      result.stepIds.some((id) => {
        return id.includes("#attempt-1");
      }),
    ).toBe(true);

    expect(
      result.stepIds.some((id) => {
        return id.includes("#attempt-2");
      }),
    ).toBe(true);
  });

  test("a command that needs several polls still completes", async () => {
    const { api, ci } = setup();

    api.script([{ match: "slow", ticks: 3, stdout: "eventually" }]);

    const job = ci.job("slow", async () => {
      return $`slow`.text();
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return job();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.data).toBe("eventually");

    expect(
      result.stepIds.filter((id) => {
        return id.includes("wait #");
      }).length,
    ).toBe(4);
  });

  test("a short command with a timeout runs as one captured step", async () => {
    const { api, ci } = setup();

    api.script([{ match: "quick", stdout: "fast" }]);

    const job = ci.job("quick", async () => {
      return $`quick`.timeout("30s").text();
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return job();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.data).toBe("fast");

    expect(
      api.requests.some((request) => {
        return request.endsWith("/exec");
      }),
    ).toBe(true);

    expect(
      result.stepIds.some((id) => {
        return id.includes("wait #");
      }),
    ).toBe(false);
  });

  test("a captured command that times out throws CommandTimeoutError", async () => {
    const { api, ci } = setup();

    api.script([{ match: "hang", execTimesOut: true }]);

    const job = ci.job("hang", async () => {
      let lookedAround = false;

      try {
        await $`hang`.timeout("2s").onTimeout(async () => {
          lookedAround = true;
        });

        return "no error";
      } catch (error) {
        return {
          isTimeout: error instanceof CommandTimeoutError,
          message: (error as Error).message,
          lookedAround,
        };
      }
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return job();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.data).toEqual({
      isTimeout: true,
      message: "`hang` timed out after 2s",
      lookedAround: true,
    });
  });

  test("withSecret throws instead of persisting the value", async () => {
    const { api, ci } = setup();

    api.script([{ match: "publish", stdout: "published" }]);

    const job = ci.job("release", async () => {
      try {
        await $`publish`.withSecret("NPM_TOKEN", "npm_s3cret");
      } catch (error) {
        return `${(error as Error).name}: ${(error as Error).message}`;
      }

      return "no error";
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return job();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.data).toContain(
      "CiUsageError: `withSecret()` isn't supported",
    );
    expect(JSON.stringify(result)).not.toContain("npm_s3cret");
  });

  test("a background process can be waited on and killed", async () => {
    const { api, ci } = setup();

    api.script([{ match: "serve", ticks: 1, stdout: "listening" }]);

    const job = ci.job("e2e", async () => {
      const server = await $`serve`.background();
      const output = await server.output();

      await server.kill();

      return output;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return job();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.data).toBe("listening");

    expect(
      api.requests.some((request) => {
        return request.includes("/signals");
      }),
    ).toBe(true);
  });

  test("a command with no output reads as empty", async () => {
    const { ci } = setup();

    const job = ci.job("quiet", async () => {
      const result = await $`true`;

      return { exitCode: result.exitCode, stdout: result.stdout };
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return job();
    });

    expect((await runFunction(pipeline, { event: prEvent })).data).toEqual({
      exitCode: 0,
      stdout: "",
    });
  });

  test("an ambiguous start adopts the process that did start", async () => {
    const { api, ci } = setup();

    api.script([
      { match: "first", stdout: "one" },
      { match: "second", stdout: "two", ambiguousStarts: 1 },
      { match: "server", stdout: "up", ambiguousStarts: 1 },
    ]);

    const job = ci.job("reconcile", async () => {
      const first = await $`first`.text();
      const second = await $`second`.text();
      const server = await $`server`.background();

      return { first, second, server: await server.output() };
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return job();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.data).toEqual({ first: "one", second: "two", server: "up" });

    // Each start ran once: reconciling never starts the command again.
    expect(
      userCommands(api).map((argv) => {
        return argv.join(" ");
      }),
    ).toEqual(["first", "second", "server"]);

    expect(
      result.stepIds.filter((id) => {
        return id.endsWith("reconcile");
      }),
    ).toHaveLength(2);
  });

  test("an ambiguous start with nothing to adopt still fails", async () => {
    const api = createFakeSandboxApi();

    api.script([{ match: "gone", ambiguousStarts: 1 }]);

    // The process the 409 was about doesn't show up in the list.
    const fetch = api.fetch;

    api.fetch = async (input, init) => {
      const response = await fetch(input, init);

      if (response.status === 409) {
        api.processes.clear();
      }

      return response;
    };

    const { ci } = setup({ api });

    const job = ci.job("lost", async () => {
      await $`gone`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return job();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-rejected");
    expect(JSON.stringify(result.error)).toContain("operation_ambiguous");
  });
});

describe("from()", () => {
  test("snapshots the parent once and clones per child", async () => {
    const { api, ci } = setup();

    const install = ci.job("setup", async () => {
      await $`pnpm install`;

      return "installed";
    });

    const lint = ci.job("lint", async () => {
      const parent = await from(install);

      await $`pnpm lint`;

      return parent;
    });

    const test = ci.job("test", async () => {
      await from(install);

      await $`pnpm test`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      const [lintResult] = await Promise.all([lint(), test()]);

      return lintResult;
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.data).toBe("installed");
    expect(api.snapshots.size).toBe(1);
    expect(api.sandboxes.size).toBe(3);

    const cloned = [...api.sandboxes.values()].filter((sandbox) => {
      return sandbox.snapshotId;
    });

    expect(cloned).toHaveLength(2);
  });

  test("from() after a command throws", async () => {
    const { ci } = setup();

    const parent = ci.job("parent", async () => {
      return undefined;
    });

    const child = ci.job("child", async () => {
      await $`echo hi`;

      await from(parent);
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return child();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(String((result.error as { message?: string })?.message)).toContain(
      "must come before this job's first command",
    );
  });

  test("from() twice throws", async () => {
    const { ci } = setup();

    const a = ci.job("a", async () => {
      return undefined;
    });

    const b = ci.job("b", async () => {
      return undefined;
    });

    const child = ci.job("child", async () => {
      await from(a);
      await from(b);
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return child();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(String((result.error as { message?: string })?.message)).toContain(
      "can only be called once",
    );
  });

  const runFromWithoutSnapshots = async ({
    api,
    ci,
  }: ReturnType<typeof setup>) => {
    const install = ci.job("setup", async () => {
      await $`pnpm install`;

      return "installed";
    });

    const test = ci.job("test", async () => {
      const parent = await from(install);

      await $`pnpm test`;

      return parent;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return test();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    // The child still gets the parent's original result…
    expect(result.data).toBe("installed");
    expect(api.sandboxes.size).toBe(2);

    expect(
      [...api.sandboxes.values()].every((sandbox) => {
        return !sandbox.snapshotId;
      }),
    ).toBe(true);

    // …and re-ran the parent on its own machine before its own commands.
    expect(
      userCommands(api).map((argv) => {
        return argv.join(" ");
      }),
    ).toEqual(["pnpm install", "pnpm install", "pnpm test"]);
  };

  test("re-runs the parent when snapshots aren't available", async () => {
    const ctx = setup();

    ctx.api.disableSnapshots();

    await runFromWithoutSnapshots(ctx);
  });

  test("re-runs the parent when the snapshot limit is reached", async () => {
    const ctx = setup();

    ctx.api.exhaustSnapshots();

    await runFromWithoutSnapshots(ctx);
  });

  test("re-runs a chain of parents without snapshots", async () => {
    const { api, ci } = setup();

    api.disableSnapshots();

    const install = ci.job("install", async () => {
      await $`pnpm install`;
    });

    const build = ci.job("build", async () => {
      await from(install);

      await $`pnpm build`;
    });

    const test = ci.job("test", async () => {
      await from(build);

      await $`pnpm test`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return test();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(api.sandboxes.size).toBe(3);

    expect(
      userCommands(api).map((argv) => {
        return argv.join(" ");
      }),
    ).toEqual([
      // install
      "pnpm install",
      // build: install again, then build
      "pnpm install",
      "pnpm build",
      // test: install and build again, then test
      "pnpm install",
      "pnpm build",
      "pnpm test",
    ]);
  });
});

describe("machines", () => {
  test("a finished job's machine is paused, and destroyed with the run", async () => {
    const { api, ci } = setup();

    const job = ci.job("test", async () => {
      await $`pnpm test`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return job();
    });

    await runFunction(pipeline, { event: prEvent });

    expect(
      api.requests.some((request) => {
        return request.includes("/pause");
      }),
    ).toBe(true);

    expect(
      [...api.sandboxes.values()].every((sandbox) => {
        return sandbox.status === "TERMINATED";
      }),
    ).toBe(true);
  });

  test("vcpu picks the matching memory", async () => {
    const { api, ci } = setup();

    const job = ci.job({ id: "big", machine: { vcpu: 4 } }, async () => {
      await $`pnpm build`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return job();
    });

    await runFunction(pipeline, { event: prEvent });

    expect([...api.sandboxes.values()][0]).toMatchObject({
      vcpu: 4,
      memoryMb: 4096,
    });
  });

  test("machines resolve job, then pipeline, then client", async () => {
    const api = createFakeSandboxApi();

    const ci = createCi(createCiTestClient(api), {
      github: consoleReporter(),
      machine: { vcpu: 1 },
    });

    const plain = ci.job("plain", async () => {
      await $`pnpm build`;
    });

    const own = ci.job({ id: "own", machine: { vcpu: 2 } }, async () => {
      await $`pnpm build`;
    });

    const inPipeline = ci.pipeline(
      { id: "pr", on: prTrigger, machine: { vcpu: 4 } },
      async () => {
        await plain();

        await own();
      },
    );

    const noMachine = ci.pipeline({ id: "other", on: prTrigger }, async () => {
      return plain();
    });

    await runFunction(inPipeline, { event: prEvent });

    expect(
      [...api.sandboxes.values()].map((box) => {
        return box.vcpu;
      }),
    ).toEqual([4, 2]);

    api.sandboxes.clear();

    await runFunction(noMachine, { event: prEvent });

    expect(
      [...api.sandboxes.values()].map((box) => {
        return box.vcpu;
      }),
    ).toEqual([1]);
  });

  test("an extra machine gets its own sandbox and scope", async () => {
    const { api, ci } = setup();

    const job = ci.job("e2e", async () => {
      const api2 = await sandbox("api");

      await api2.$`pnpm start`;

      await $`pnpm test`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return job();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(api.sandboxes.size).toBe(2);

    expect(
      result.stepIds.some((id) => {
        return id.startsWith("e2e › api › pnpm start");
      }),
    ).toBe(true);
  });
});

describe("matrix", () => {
  test("every combination runs as its own job", async () => {
    const { api, ci } = setup();

    const compat = ci.matrix(
      { id: "compat", axes: { node: ["20", "22"] } },
      async ({ node }) => {
        await $`pnpm test --node ${node}`;

        return node;
      },
    );

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return compat();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.data).toEqual(["20", "22"]);
    expect(api.sandboxes.size).toBe(2);

    expect(
      result.stepIds.some((id) => {
        return id.startsWith("compat (node:20) › machine");
      }),
    ).toBe(true);
  });

  test("a matrix can run one combination", async () => {
    const { api, ci } = setup();

    const compat = ci.matrix(
      { id: "compat", axes: { node: ["20", "22"] } },
      async ({ node }) => {
        await $`pnpm test`;

        return node;
      },
    );

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return compat({ node: "22" });
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.data).toEqual(["22"]);
    expect(api.sandboxes.size).toBe(1);
  });
});

describe("cache", () => {
  test("a second run restores the job and skips its commands", async () => {
    const store = memoryCacheStore();
    // The same machines and snapshots across both runs, like a real environment.
    const api = createFakeSandboxApi();

    const first = setup({ cacheStore: store, api });

    const build = first.ci.job(
      { id: "setup", cache: { key: "v1" } },
      async () => {
        await $`pnpm install`;

        return "built";
      },
    );

    const firstPipeline = first.ci.pipeline(
      { id: "pr", on: prTrigger },
      async () => {
        return build();
      },
    );

    expect((await runFunction(firstPipeline, { event: prEvent })).data).toBe(
      "built",
    );

    expect(userCommands(first.api)).toHaveLength(1);

    const second = setup({ cacheStore: store, api });

    const build2 = second.ci.job(
      { id: "setup", cache: { key: "v1" } },
      async () => {
        await $`pnpm install`;

        return "built again";
      },
    );

    const secondPipeline = second.ci.pipeline(
      { id: "pr", on: prTrigger },
      async () => {
        return build2();
      },
    );

    const result = await runFunction(secondPipeline, { event: prEvent });

    expect(result.data).toBe("built");
    // Nothing new ran: no extra commands, and no second machine.
    expect(userCommands(api)).toHaveLength(1);
    expect(api.sandboxes.size).toBe(1);
  });

  test("the same key with a different input is a different entry", async () => {
    const store = memoryCacheStore();
    const api = createFakeSandboxApi();

    const runWith = async (version: string) => {
      const { ci } = setup({ cacheStore: store, api });

      const build = ci.job<string, string>(
        { id: "setup", cache: { key: "v1" } },
        async (input) => {
          await $`pnpm install`;

          return input;
        },
      );

      const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        return build(version);
      });

      return runFunction(pipeline, { event: prEvent });
    };

    expect((await runWith("1")).data).toBe("1");
    expect((await runWith("2")).data).toBe("2");
    expect(userCommands(api)).toHaveLength(2);

    // The same input again is a hit.
    expect((await runWith("1")).data).toBe("1");
    expect(userCommands(api)).toHaveLength(2);
  });

  test("a changed key misses and runs again", async () => {
    const store = memoryCacheStore();
    // The same machines and snapshots across both runs, like a real environment.
    const api = createFakeSandboxApi();

    const first = setup({ cacheStore: store, api });

    const job1 = first.ci.job(
      { id: "setup", cache: { key: "v1" } },
      async () => {
        await $`pnpm install`;

        return 1;
      },
    );

    await runFunction(
      first.ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        return job1();
      }),
      { event: prEvent },
    );

    const second = setup({ cacheStore: store, api });

    const job2 = second.ci.job(
      { id: "setup", cache: { key: "v2" } },
      async () => {
        await $`pnpm install`;

        return 2;
      },
    );

    const result = await runFunction(
      second.ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        return job2();
      }),
      { event: prEvent },
    );

    expect(result.data).toBe(2);
    expect(userCommands(api)).toHaveLength(2);
  });

  test("a cached job with a machine can still be started from", async () => {
    const store = memoryCacheStore();
    // The same machines and snapshots across both runs, like a real environment.
    const api = createFakeSandboxApi();

    const first = setup({ cacheStore: store, api });

    const setupJob = first.ci.job(
      { id: "setup", cache: { key: "v1" } },
      async () => {
        await $`pnpm install`;

        return "installed";
      },
    );

    await runFunction(
      first.ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        return setupJob();
      }),
      { event: prEvent },
    );

    const second = setup({ cacheStore: store, api });

    const setupJob2 = second.ci.job(
      { id: "setup", cache: { key: "v1" } },
      async () => {
        await $`pnpm install`;

        return "installed";
      },
    );

    const test = second.ci.job("test", async () => {
      await from(setupJob2);

      await $`pnpm test`;
    });

    const result = await runFunction(
      second.ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        return test();
      }),
      { event: prEvent },
    );

    expect(result.type).toBe("function-resolved");

    // `setup` was restored, so only the child job's command ran this time.
    expect(userCommands(api)).toEqual([
      ["pnpm", "install"],
      ["pnpm", "test"],
    ]);

    // …and the child cloned the cached snapshot rather than starting fresh.
    expect(
      [...api.sandboxes.values()].filter((machine) => {
        return machine.snapshotId;
      }),
    ).toHaveLength(1);
  });

  test("a cached job is rebuilt when a job it starts from changes its key", async () => {
    const store = memoryCacheStore();
    const api = createFakeSandboxApi();

    const runWith = async (setupKey: string) => {
      const { ci } = setup({ cacheStore: store, api });

      const setupJob = ci.job(
        { id: "setup", cache: { key: setupKey } },
        async () => {
          await $`pnpm install`;
        },
      );

      const test = ci.job({ id: "test", cache: { key: "t" } }, async () => {
        await from(setupJob);

        await $`pnpm test`;
      });

      await runFunction(
        ci.pipeline({ id: "pr", on: prTrigger }, async () => {
          return test();
        }),
        { event: prEvent },
      );
    };

    const testRuns = () => {
      return userCommands(api).filter((argv) => {
        return argv[1] === "test";
      }).length;
    };

    await runWith("lock-1");

    expect(testRuns()).toBe(1);

    await runWith("lock-1");

    expect(testRuns()).toBe(1);

    await runWith("lock-2");

    expect(testRuns()).toBe(2);
  });

  test("files() keys are resolved through the repository", async () => {
    expect(files("pnpm-lock.yaml", ".nvmrc")).toEqual({
      kind: "inngest/ci.cacheKeyPart",
      type: "files",
      patterns: ["pnpm-lock.yaml", ".nvmrc"],
    });
  });
});

describe("checks", () => {
  test("the pipeline check always completes, even with no jobs", async () => {
    const { ci, reporter } = setup();

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return ci.skip("no relevant changes");
    });

    await runFunction(pipeline, { event: prEvent });

    const completed = reporter.history.filter((entry) => {
      return entry.status === "completed";
    });

    expect(completed).toHaveLength(1);

    expect(completed[0]).toMatchObject({
      name: "pr",
      conclusion: "success",
      title: "Nothing to do: no relevant changes",
    });
  });

  test("a failing job fails its own check and the pipeline check", async () => {
    const { api, ci, reporter } = setup();

    api.script([{ match: "pnpm test", exitCode: 1, stderr: "boom" }]);

    const test = ci.job("test", async () => {
      await $`pnpm test`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return test();
    });

    await runFunction(pipeline, { event: prEvent });

    const completed = reporter.history.filter((entry) => {
      return entry.status === "completed";
    });

    expect(completed).toEqual([
      expect.objectContaining({
        name: "pr / test",
        conclusion: "failure",
        title: "`pnpm test` exited with 1",
      }),
      expect.objectContaining({ name: "pr", conclusion: "failure" }),
    ]);
  });

  test("a cached child of a parent called with an input hits again, and misses when that input changes", async () => {
    const store = memoryCacheStore();
    const api = createFakeSandboxApi();

    const runWith = async (version: string) => {
      const { ci } = setup({ cacheStore: store, api });

      const parent = ci.job(
        { id: "setup", cache: { key: "p" } },
        async (input: { version: string }) => {
          await $`pnpm install ${input.version}`;

          return input.version;
        },
      );

      const child = ci.job(
        { id: "test", cache: { key: "t" } },
        async (input: { version: string }) => {
          await from(parent, input);

          await $`pnpm test`;
        },
      );

      await runFunction(
        ci.pipeline({ id: "pr", on: prTrigger }, async () => {
          return child({ version });
        }),
        { event: prEvent },
      );
    };

    const testRuns = () => {
      return userCommands(api).filter((argv) => {
        return argv[1] === "test";
      }).length;
    };

    await runWith("1");

    expect(testRuns()).toBe(1);

    await runWith("1");

    expect(testRuns()).toBe(1);

    await runWith("2");

    expect(testRuns()).toBe(2);
  });

  test("a cache hit reads as restored, never skipped", async () => {
    const store = memoryCacheStore();
    // The same machines and snapshots across both runs, like a real environment.
    const api = createFakeSandboxApi();

    const first = setup({ cacheStore: store, api });

    const job1 = first.ci.job(
      { id: "setup", cache: { key: "v1" } },
      async () => {
        await $`pnpm install`;
      },
    );

    await runFunction(
      first.ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        return job1();
      }),
      { event: prEvent },
    );

    const second = setup({ cacheStore: store, api });

    const job2 = second.ci.job(
      { id: "setup", cache: { key: "v1" } },
      async () => {
        await $`pnpm install`;
      },
    );

    await runFunction(
      second.ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        return job2();
      }),
      { event: prEvent },
    );

    const restored = second.reporter.history.find((entry) => {
      return entry.name === "pr / setup" && entry.status === "completed";
    });

    expect(restored?.conclusion).toBe("success");
    expect(restored?.title).toMatch(/^Cached snapshot, built .+ by /);
  });

  test("job checks can be turned off for the whole pipeline", async () => {
    const { ci, reporter } = setup();

    const job = ci.job("test", async () => {
      await $`pnpm test`;
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, check: { jobs: false } },
      async () => {
        return job();
      },
    );

    await runFunction(pipeline, { event: prEvent });

    expect(
      reporter.history.every((entry) => {
        return entry.name === "pr";
      }),
    ).toBe(true);
  });

  test("checks can be turned off entirely", async () => {
    const { ci, reporter } = setup();

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, check: false },
      async () => {
        return undefined;
      },
    );

    await runFunction(pipeline, { event: prEvent });

    expect(reporter.history).toHaveLength(0);
  });

  test("report.summary adds to the job's check", async () => {
    const { ci } = setup();

    const job = ci.job("test", async () => {
      await report.summary("Coverage: **91%**");
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return job();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(result.stepIds).toContain("test › report:summary");
  });
});

describe("job durations", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Run a one-command pipeline where every execution request is 10s later. */
  const runTimed = async (check?: false) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const { ci, reporter } = setup();

    const job = ci.job("test", async () => {
      await $`pnpm install`;
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, ...(check === false ? { check } : {}) },
      async () => {
        return job();
      },
    );

    const result = await runFunction(pipeline, {
      event: prEvent,
      beforeRequest: () => {
        vi.setSystemTime(Date.now() + 10_000);
      },
    });

    return { result, reporter };
  };

  test("a job's duration spans its steps, not the last replay", async () => {
    const { result, reporter } = await runTimed();

    expect(result.type).toBe("function-resolved");

    const completed = reporter.history.find((entry) => {
      return entry.status === "completed" && entry.name === "pr / test";
    });

    expect(completed?.title).toMatch(/^Passed in (\d+m )?\d+s$/);
    expect(completed?.title).not.toMatch(/ms$/);
  });

  test("a job without a check still times its steps", async () => {
    const { result } = await runTimed(false);

    expect(result.type).toBe("function-resolved");
    expect(result.stepIds).toContain("start:test");
  });
});

describe("errors", () => {
  test("CommandFailedError carries the command and output", () => {
    const error = new CommandFailedError({
      command: ["pnpm", "test"],
      exitCode: 1,
      stdoutTail: "out",
      stderrTail: "err",
      jobPath: "test",
    });

    expect(error.message).toContain("`pnpm test` exited with 1");
    expect(error.jobPath).toBe("test");
  });
});

/** A CI client whose GitHub calls go to a fake. */
const setupGitHub = (reporter: "checks" | "statuses" = "statuses") => {
  const api = createFakeSandboxApi();
  const client = createCiTestClient(api);
  const gh = createFakeGitHub();

  const ci = createCi(client, {
    github: {
      ...githubToken({
        token: "t",
        baseUrl: "https://api.github.test",
        fetch: gh.fetch,
      }),
      reporter,
    },
    runUrl: ({ runId }) => {
      return `http://localhost:8288/run?runID=${runId}`;
    },
  });

  return { api, client, gh, ci };
};

describe("cleanup", () => {
  const notFound = Object.assign(new Error("sandbox not found"), {
    code: "sandbox_not_found",
  });

  const runWithSandboxes = (sandboxes: {
    get: (id: string) => Promise<unknown>;
  }) => {
    return {
      sandboxes: new Set(["a"]),
      step: {
        run: (_options: unknown, fn: () => unknown) => {
          return fn();
        },
      },
      ci: { client: { sandboxes } },
      // biome-ignore lint/suspicious/noExplicitAny: a partial scope is enough here
    } as any;
  };

  test("a machine that is already gone is not an error", async () => {
    const run = runWithSandboxes({
      get: async () => {
        return {
          destroy: async () => {
            throw notFound;
          },
        };
      },
    });

    await expect(destroyRunMachines(run)).resolves.toBeUndefined();
  });

  test("any other failure fails the step so it retries", async () => {
    const run = runWithSandboxes({
      get: async () => {
        return {
          destroy: async () => {
            throw new Error("503 service unavailable");
          },
        };
      },
    });

    await expect(destroyRunMachines(run)).rejects.toThrow("503");

    const lookup = runWithSandboxes({
      get: async () => {
        throw new Error("network down");
      },
    });

    await expect(destroyRunMachines(lookup)).rejects.toThrow("network down");
  });

  test("orphan recovery only ignores not-found", async () => {
    const page = (destroy: () => Promise<unknown>) => {
      return {
        sandboxes: {
          list: async () => {
            return {
              items: [{ name: "ci-run1-test", destroy }],
              page: { hasMore: false },
            };
          },
        },
        // biome-ignore lint/suspicious/noExplicitAny: a partial client is enough here
      } as any;
    };

    await expect(
      destroyOrphans(
        page(async () => {
          throw notFound;
        }),
        "run1",
      ),
    ).resolves.toEqual({ destroyed: 0 });

    await expect(
      destroyOrphans(
        page(async () => {
          throw new Error("503 service unavailable");
        }),
        "run1",
      ),
    ).rejects.toThrow("503");
  });

  test("a run that will be retried keeps its machines for the retry", async () => {
    const { api, ci } = setup();

    const job = ci.job("test", async () => {
      await $`pnpm test`;
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, retries: 1 },
      async ({ attempt }) => {
        await job();

        if (attempt === 0) {
          // Nothing may have been destroyed before the retry replays.
          expect(
            [...api.sandboxes.values()].some((sandbox) => {
              return sandbox.status === "TERMINATED";
            }),
          ).toBe(false);

          throw new Error("flaky infrastructure");
        }

        return "ok";
      },
    );

    const result = await runFunction(pipeline, { event: prEvent, retries: 1 });

    expect(result.type).toBe("function-resolved");
    expect(result.data).toBe("ok");
    expect(api.sandboxes.size).toBe(1);

    expect(
      result.stepIds.filter((id) => {
        return id === "cleanup";
      }),
    ).toHaveLength(1);

    expect(
      [...api.sandboxes.values()].every((sandbox) => {
        return sandbox.status === "TERMINATED";
      }),
    ).toBe(true);
  });

  test("a usage error isn't retried and cleans up straight away", async () => {
    const { api, ci } = setup();

    const job = ci.job("test", async () => {
      await $`pnpm test`;
      await $`publish`.withSecret("NPM_TOKEN", "npm_s3cret");
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, retries: 1 },
      async () => {
        return job();
      },
    );

    const result = await runFunction(pipeline, { event: prEvent, retries: 1 });

    expect(result.type).toBe("function-rejected");
    expect(result.retriable).toBe(false);

    expect(
      [...api.sandboxes.values()].every((sandbox) => {
        return sandbox.status === "TERMINATED";
      }),
    ).toBe(true);
  });

  test("the last attempt cleans up when it fails", async () => {
    const { api, ci } = setup();

    const job = ci.job("test", async () => {
      await $`pnpm test`;
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, retries: 1 },
      async () => {
        await job();

        throw new Error("flaky infrastructure");
      },
    );

    const result = await runFunction(pipeline, { event: prEvent, retries: 1 });

    expect(result.type).toBe("function-rejected");

    expect(
      [...api.sandboxes.values()].every((sandbox) => {
        return sandbox.status === "TERMINATED";
      }),
    ).toBe(true);
  });
});

describe("repository for repo-less triggers", () => {
  test("the configured repo is resolved to its default branch head", async () => {
    const { ci, gh } = setupGitHub();

    gh.route("GET /repos/inngest/inngest-js", { default_branch: "main" });

    gh.route("GET /repos/inngest/inngest-js/branches/main", {
      commit: { sha: "cafe1234" },
    });

    const pipeline = ci.pipeline(
      {
        id: "nightly",
        on: [{ event: "test/nightly" }],
        repo: "inngest/inngest-js",
        check: false,
      },
      async ({ repo }) => {
        return repo;
      },
    );

    const result = await runFunction(pipeline, {
      event: { name: "test/nightly", data: {} },
    });

    expect(result.data).toMatchObject({
      owner: "inngest",
      name: "inngest-js",
      fullName: "inngest/inngest-js",
      sha: "cafe1234",
      ref: "refs/heads/main",
      baseRef: "main",
    });

    expect(result.stepIds).toContain("repo:resolve");
  });
});

describe("failures that retrying cannot fix", () => {
  test("a failed matrix with failFast off fails once and cleans up", async () => {
    const { api, ci } = setup();

    api.script([{ match: "pnpm test", exitCode: 1, stderr: "nope" }]);

    const compat = ci.matrix(
      { id: "compat", axes: { node: ["20", "22"] } },
      async ({ node }) => {
        await $`pnpm test --node ${node}`;
      },
    );

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return compat();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-rejected");
    expect(result.retriable).toBe(false);

    expect(
      [...api.sandboxes.values()].every((sandbox) => {
        return sandbox.status === "TERMINATED";
      }),
    ).toBe(true);
  });

  test("a non-retriable step error completes the checks with its message", async () => {
    const { ci, reporter } = setup();

    const build = ci.job("build", async () => {
      await getRunScope()?.step.run({ id: "machine:create" }, () => {
        throw new NonRetriableError(
          "Sandbox did not reach RUNNING within 120000 milliseconds",
        );
      });
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await build();
    });

    const result = await runFunction(pipeline, { event: prEvent, retries: 4 });

    expect(result.type).toBe("function-rejected");
    expect(result.retriable).toBe(false);

    const completed = reporter.history.filter((entry) => {
      return entry.status === "completed";
    });

    expect(
      completed.map((entry) => {
        return [entry.name, entry.conclusion, entry.title];
      }),
    ).toEqual([
      [
        "pr / build",
        "failure",
        "Sandbox did not reach RUNNING within 120000 milliseconds",
      ],
      [
        "pr",
        "failure",
        "build: Sandbox did not reach RUNNING within 120000 milliseconds",
      ],
    ]);
  });

  test("a malformed repo fails when the pipeline is defined", () => {
    const { ci } = setup();

    for (const repo of ["my-app", "a/b/c", "/b", "a/"]) {
      expect(() => {
        return ci.pipeline(
          { id: "nightly", on: [{ event: "test/nightly" }], repo },
          async () => {},
        );
      }).toThrow(CiUsageError);
    }
  });
});

describe("pipeline check annotations", () => {
  test("annotations made outside a job reach the pipeline check", async () => {
    vi.stubEnv("INNGEST_CI_GITHUB", "live");

    try {
      const { ci, gh } = setupGitHub("checks");

      gh.route("GET /repos/inngest/inngest-js/commits/abc1234/check-runs", {
        check_runs: [],
      });

      gh.route("POST /repos/inngest/inngest-js/check-runs", { id: 9 });
      gh.route("PATCH /repos/inngest/inngest-js/check-runs/9", { id: 9 });

      const pipeline = ci.pipeline(
        { id: "pr", on: prTrigger, check: { jobs: false } },
        async () => {
          await report.annotate([
            { path: "src/a.ts", line: 4, message: "unused export" },
          ]);
        },
      );

      await runFunction(pipeline, { event: prEvent });

      const completion = gh.requests.find((request) => {
        return (
          request.method === "PATCH" &&
          (request.body as { status?: string })?.status === "completed"
        );
      });

      expect(
        (
          completion?.body as {
            output?: { annotations?: { path: string }[] };
          }
        )?.output?.annotations,
      ).toMatchObject([{ path: "src/a.ts", message: "unused export" }]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("comment permissions", () => {
  const commentEvent = (body: string) => {
    return {
      name: "github/issue_comment.created",
      data: {
        action: "created",
        repository: { full_name: "inngest/inngest-js" },
        issue: { number: 7, pull_request: {} },
        comment: { body, user: { login: "alice" } },
        _github: { event: "issue_comment", installationId: 1 },
      },
    };
  };

  const run = async (body: string) => {
    const { ci, gh } = setupGitHub();

    gh.route("GET /repos/inngest/inngest-js/collaborators/alice/permission", {
      permission: "write",
    });

    gh.route("GET /repos/inngest/inngest-js/issues/7/comments", []);
    gh.route("POST /repos/inngest/inngest-js/issues/7/comments", { id: 1 });

    const pipeline = ci.pipeline(
      {
        id: "commands",
        on: [
          github.comment({ command: "/test", minPermission: "read" }),
          github.comment({ command: "/deploy", minPermission: "admin" }),
        ],
        check: false,
      },
      async () => {
        return "ran";
      },
    );

    return runFunction(pipeline, { event: commentEvent(body) });
  };

  test("a command needs the permission of its own trigger", async () => {
    expect((await run("/test")).data).toBe("ran");

    expect((await run("/deploy now")).data).toEqual({
      skipped: "not permitted",
    });
  });
});

describe("checks across retries", () => {
  test("a retried run's checks end with the last attempt's result", async () => {
    vi.stubEnv("INNGEST_CI_GITHUB", "live");

    try {
      const { ci, gh } = setupGitHub("checks");

      gh.route("GET /repos/inngest/inngest-js/commits/abc1234/check-runs", {
        check_runs: [],
      });

      gh.route("POST /repos/inngest/inngest-js/check-runs", { id: 9 });
      gh.route("PATCH /repos/inngest/inngest-js/check-runs/9", { id: 9 });
      gh.route("GET /repos/inngest/inngest-js/check-runs/9", { id: 9 });

      // Steps replay within an attempt, so the job fails by attempt rather
      // than by how many times it has run.
      let attempt = 0;

      const flaky = ci.job("flaky", async () => {
        if (attempt === 0) {
          throw new Error("flaky infrastructure");
        }

        await $`pnpm test`;
      });

      const pipeline = ci.pipeline(
        { id: "pr", on: prTrigger, retries: 1 },
        async (ctx) => {
          attempt = ctx.attempt;

          await flaky();
        },
      );

      const result = await runFunction(pipeline, {
        event: prEvent,
        retries: 1,
      });

      expect(result.type).toBe("function-resolved");

      const patches = gh.requests
        .filter((request) => {
          return request.method === "PATCH";
        })
        .map((request) => {
          return request.body as {
            status?: string;
            conclusion?: string;
            output?: { title?: string };
          };
        });

      const completed = patches.filter((patch) => {
        return patch.status === "completed";
      });

      // One completion per check, the job's and the pipeline's, both passing.
      expect(
        completed.map((patch) => {
          return patch.conclusion;
        }),
      ).toEqual(["success", "success"]);

      // Until then the checks only said a retry was coming.
      expect(
        patches.some((patch) => {
          return patch.output?.title === "Retrying (attempt 2 of 2)";
        }),
      ).toBe(true);

      const ends = result.metadata.filter((update) => {
        return update.scope === "run" && "conclusion" in update.values;
      });

      expect(ends).toHaveLength(1);
      expect(ends[0]?.values).toMatchObject({ conclusion: "success" });
      expect(ends[0]?.step).toBe("github › check:pr:complete");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("the last attempt completes the checks as failed", async () => {
    const { ci } = setup();

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, retries: 1 },
      async () => {
        throw new Error("still broken");
      },
    );

    const result = await runFunction(pipeline, { event: prEvent, retries: 1 });

    expect(result.type).toBe("function-rejected");

    const ends = result.metadata.filter((update) => {
      return update.scope === "run" && "conclusion" in update.values;
    });

    expect(ends).toHaveLength(1);
    expect(ends[0]?.values).toMatchObject({ conclusion: "failure" });
  });
});
