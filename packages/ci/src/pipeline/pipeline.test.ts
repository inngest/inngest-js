/**
 * End-to-end tests of pipelines, jobs, machines, caching and reporting,
 driven through the fake sandbox API.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NonRetriableError } from "inngest";
import { afterEach, describe, expect, test, vi } from "vitest";
import { files } from "../cache/cache.ts";
import { checkout } from "../checkout/checkout.ts";
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
import { writeSnapshotMetaScript } from "../machine/snapshotMeta.ts";
import { report } from "../report.ts";
import { createCiTestClient } from "../testing/client.ts";
import { createFakeGitHub } from "../testing/fakeGitHub.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import { fakeSchema } from "../testing/schema.ts";
import { createCi } from "./createCi.ts";
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

/**
 * The commands a job asked for, without CI's own machine setup and snapshot
 * metadata.
 */
const userCommands = (api: ReturnType<typeof createFakeSandboxApi>) => {
  return api.commands.filter((argv) => {
    return (
      argv[2] !== machineSetupScript && argv[2] !== writeSnapshotMetaScript
    );
  });
};

/**
 * A CI client over a sandbox API. Clients given the same API share nothing
 * else, like two machines running the same app against one environment.
 */
const setup = (
  opts: {
    api?: ReturnType<typeof createFakeSandboxApi>;
    /** The app's ID, for clients that should look like different apps. */
    appId?: string;
  } = {},
) => {
  const api = opts.api ?? createFakeSandboxApi();
  const client = createCiTestClient(api, opts.appId);
  const reporter = consoleReporter();

  const ci = createCi(client, {
    github: reporter,
    runUrl: ({ runId }) => {
      return `http://localhost:8288/run?runID=${runId}`;
    },
  });

  return { api, client, ci, reporter };
};

/** The snapshots cached under a name, by name. */
const namedSnapshots = (api: ReturnType<typeof createFakeSandboxApi>) => {
  return [...api.snapshots.values()].flatMap((snapshot) => {
    return snapshot.name ? [snapshot.name] : [];
  });
};

describe("pipelines and jobs", () => {
  test("a job runs its commands on its own machine", async () => {
    const { api, ci } = setup();

    const test = ci.job("test", async () => {
      await $`pnpm install`;

      await $`pnpm test`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await test();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");

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

    let ran = false;

    const deploy = ci.job("deploy", async () => {
      ran = true;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await deploy();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(ran).toBe(true);
    expect(api.sandboxes.size).toBe(0);
  });

  test("calling a job twice runs it twice", async () => {
    const { api, ci, reporter } = setup();

    const test = ci.job("test", async () => {
      await $`pnpm test`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await test();

      await test();

      await test();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(api.sandboxes.size).toBe(3);

    expect(
      userCommands(api).filter((argv) => {
        return argv[1] === "test";
      }),
    ).toHaveLength(3);

    expect(result.stepIds).toContain("test › machine");
    expect(result.stepIds).toContain("test (2) › machine");
    expect(result.stepIds).toContain("test (3) › machine");

    const completed = reporter.history
      .filter((entry) => {
        return entry.status === "completed";
      })
      .map((entry) => {
        return entry.name;
      });

    expect(completed).toEqual([
      "pr / test",
      "pr / test (2)",
      "pr / test (3)",
      "pr",
    ]);
  });

  test("an explicit check name gets the call number too", async () => {
    const { ci, reporter } = setup();

    const test = ci.job({ id: "test", check: { name: "Unit" } }, async () => {
      await $`pnpm test`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await test();

      await test();
    });

    await runFunction(pipeline, { event: prEvent });

    const names = reporter.history
      .filter((entry) => {
        return entry.status === "completed";
      })
      .map((entry) => {
        return entry.name;
      });

    expect(names).toEqual(["pr / Unit", "pr / Unit (2)", "pr"]);
  });

  test("concurrent calls of a job each run with their own path", async () => {
    const { api, ci, reporter } = setup();

    const build = ci.job("build", async () => {
      await $`pnpm build`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await Promise.all([build(), build()]);
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(api.sandboxes.size).toBe(2);

    expect(
      userCommands(api).filter((argv) => {
        return argv[1] === "build";
      }),
    ).toHaveLength(2);

    expect(result.stepIds).toContain("build › machine");
    expect(result.stepIds).toContain("build (2) › machine");

    const names = reporter.history
      .filter((entry) => {
        return entry.status === "completed";
      })
      .map((entry) => {
        return entry.name;
      });

    expect(names).toEqual(
      expect.arrayContaining(["pr / build", "pr / build (2)"]),
    );
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
    const received = new Set<string>();

    const build = ci.job({ id: "build", input }, async ({ target, minify }) => {
      received.add(JSON.stringify({ target, minify }));

      await $`pnpm build --target ${target}`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return build({ target: "web" });
    });

    await runFunction(pipeline, { event: prEvent });

    // The default was applied.
    expect([...received]).toEqual([
      JSON.stringify({ target: "web", minify: true }),
    ]);
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
    const { api, ci } = setup();

    const base = ci.job({ id: "base", input }, async ({ target }) => {
      await $`pnpm install --target ${target}`;
    });

    const test = ci.job("test", async () => {
      return from(base, { target: "web" });
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return test();
    });

    await runFunction(pipeline, { event: prEvent });

    expect(userCommands(api)).toHaveLength(1);
  });

  test("a job without a schema takes its input as given", async () => {
    const { ci } = setup();
    const received = new Set<string>();

    const greet = ci.job("greet", async (name: string) => {
      received.add(name);
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return greet("jack");
    });

    await runFunction(pipeline, { event: prEvent });

    expect([...received]).toEqual(["jack"]);
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

    let exitCode: number | undefined;

    const job = ci.job("lint", async () => {
      const result = await $`pnpm lint`.nothrow();

      exitCode = result.exitCode;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await job();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(exitCode).toBe(3);
  });

  test("`.text()` reads stdout", async () => {
    const { api, ci } = setup();

    api.script([{ match: "git rev-parse", stdout: "abc1234\n" }]);

    let sha: string | undefined;

    const job = ci.job("sha", async () => {
      sha = await $`git rev-parse HEAD`.text();
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await job();
    });

    await runFunction(pipeline, { event: prEvent });

    expect(sha).toBe("abc1234");
  });

  test("`.lines()` and `.json()` parse stdout", async () => {
    const { api, ci } = setup();

    api.script([
      { match: "list", stdout: "a\nb\n" },
      { match: "config", stdout: '{"ok":true}' },
    ]);

    let parsed: unknown;

    const job = ci.job("read", async () => {
      parsed = {
        lines: await $`list`.lines(),
        json: await $`config`.json<{ ok: boolean }>(),
      };
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await job();
    });

    await runFunction(pipeline, { event: prEvent });

    expect(parsed).toEqual({
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

    let output: string | undefined;

    const job = ci.job("slow", async () => {
      output = await $`slow`.text();
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await job();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(output).toBe("eventually");

    expect(
      result.stepIds.filter((id) => {
        return id.includes("wait #");
      }).length,
    ).toBe(4);
  });

  test("a short command with a timeout runs as one captured step", async () => {
    const { api, ci } = setup();

    api.script([{ match: "quick", stdout: "fast" }]);

    let output: string | undefined;

    const job = ci.job("quick", async () => {
      output = await $`quick`.timeout("30s").text();
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await job();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(output).toBe("fast");

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

    let caught: unknown = "no error";

    const job = ci.job("hang", async () => {
      let lookedAround = false;

      try {
        await $`hang`.timeout("2s").onTimeout(async () => {
          lookedAround = true;
        });
      } catch (error) {
        caught = {
          isTimeout: error instanceof CommandTimeoutError,
          message: (error as Error).message,
          lookedAround,
        };
      }
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await job();
    });

    await runFunction(pipeline, { event: prEvent });

    expect(caught).toEqual({
      isTimeout: true,
      message: "`hang` timed out after 2s",
      lookedAround: true,
    });
  });

  test("withSecret throws instead of persisting the value", async () => {
    const { api, ci } = setup();

    api.script([{ match: "publish", stdout: "published" }]);

    let caught = "no error";

    const job = ci.job("release", async () => {
      try {
        await $`publish`.withSecret("NPM_TOKEN", "npm_s3cret");
      } catch (error) {
        caught = `${(error as Error).name}: ${(error as Error).message}`;
      }
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await job();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(caught).toContain("CiUsageError: `withSecret()` isn't supported");
    expect(JSON.stringify(result)).not.toContain("npm_s3cret");
  });

  test("a background process can be waited on and killed", async () => {
    const { api, ci } = setup();

    api.script([{ match: "serve", ticks: 1, stdout: "listening" }]);

    let output: string | undefined;

    const job = ci.job("e2e", async () => {
      const server = await $`serve`.background();

      output = await server.output();

      await server.kill();
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await job();
    });

    await runFunction(pipeline, { event: prEvent });

    expect(output).toBe("listening");

    expect(
      api.requests.some((request) => {
        return request.includes("/signals");
      }),
    ).toBe(true);
  });

  test("a command with no output reads as empty", async () => {
    const { ci } = setup();

    let seen: unknown;

    const job = ci.job("quiet", async () => {
      const result = await $`true`;

      seen = { exitCode: result.exitCode, stdout: result.stdout };
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await job();
    });

    await runFunction(pipeline, { event: prEvent });

    expect(seen).toEqual({
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

    let seen: unknown;

    const job = ci.job("reconcile", async () => {
      const first = await $`first`.text();
      const second = await $`second`.text();
      const server = await $`server`.background();

      seen = { first, second, server: await server.output() };
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await job();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(seen).toEqual({ first: "one", second: "two", server: "up" });

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
  const ran = (api: ReturnType<typeof createFakeSandboxApi>, text: string) => {
    return userCommands(api).filter((argv) => {
      return argv.join(" ").includes(text);
    }).length;
  };

  test("snapshots the parent once and clones per child", async () => {
    const { api, ci } = setup();

    const install = ci.job("setup", async () => {
      await $`pnpm install`;
    });

    const lint = ci.job("lint", async () => {
      await from(install);

      await $`pnpm lint`;
    });

    const test = ci.job("test", async () => {
      await from(install);

      await $`pnpm test`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await Promise.all([lint(), test()]);
    });

    await runFunction(pipeline, { event: prEvent });

    expect(
      userCommands(api).filter((argv) => {
        return argv[1] === "install";
      }),
    ).toHaveLength(1);

    // The one snapshot was taken for `from()`, and is deleted with the run.
    expect(api.snapshots.size).toBe(0);
    expect(api.sandboxes.size).toBe(3);

    const cloned = [...api.sandboxes.values()].filter((sandbox) => {
      return sandbox.snapshotId;
    });

    expect(cloned).toHaveLength(2);
  });

  test("two children of one uncached parent share one invoke and one build run", async () => {
    const { api, ci } = setup();

    const base = ci.job("base", async () => {
      await $`pnpm install`;
    });

    const lint = ci.job("lint", async () => {
      await from(base);

      await $`pnpm lint`;
    });

    const test = ci.job("test", async () => {
      await from(base);

      await $`pnpm test`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await Promise.all([lint(), test()]);
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");

    // One invoke, planned under the parent's name rather than a child's.
    expect(
      result.stepIds.filter((id) => {
        return id.endsWith("› build");
      }),
    ).toEqual(["base (from) › build"]);

    // One build run: the only machine named for it is `base`'s, and it ran
    // the job once.
    expect(
      [...api.sandboxes.values()].filter((machine) => {
        return /^ci-01TESTINVOKED\d+-base$/.test(machine.name);
      }),
    ).toHaveLength(1);

    expect(ran(api, "pnpm install")).toBe(1);
  });

  test("builds nested in other builds share one build of an uncached parent", async () => {
    const { api, ci } = setup();

    const build = ci.job("build", async () => {
      await $`pnpm install`;
    });

    const pack = ci.job("pack", async () => {
      await from(build);

      await $`pnpm pack`;
    });

    const ship = ci.job("ship", async () => {
      await from(pack);

      await $`pnpm ship`;
    });

    const lint = ci.job("lint", async () => {
      await from(build);

      await $`pnpm lint`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await Promise.all([ship(), lint()]);
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");

    // `build` is built once, however many builds and jobs start from it.
    expect(
      [...api.sandboxes.values()].filter((machine) => {
        return /^ci-01TESTINVOKED\d+-build$/.test(machine.name);
      }),
    ).toHaveLength(1);

    expect(ran(api, "pnpm install")).toBe(1);
    expect(ran(api, "pnpm pack")).toBe(1);

    // Every uncached snapshot is the root run's, and all are deleted with it.
    expect(api.snapshots.size).toBe(0);
  });

  test("an uncached parent's snapshot is named for the run, and deleted with it", async () => {
    const { api, ci } = setup();
    const named = new Set<string>();

    const base = ci.job("base", async () => {
      await $`pnpm install`;
    });

    const lint = ci.job("lint", async () => {
      await from(base);

      await $`pnpm lint`;

      for (const name of namedSnapshots(api)) {
        named.add(name);
      }
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await lint();
    });

    const result = await runFunction(pipeline, {
      event: prEvent,
      runId: "01RUNA",
    });

    expect(result.type).toBe("function-resolved");
    expect([...named]).toEqual(["ci/run:01RUNA/base/"]);
    expect(api.snapshots.size).toBe(0);
  });

  test("another run never starts from an uncached parent's snapshot", async () => {
    const api = createFakeSandboxApi();

    for (const runId of ["01RUNA", "01RUNB"]) {
      const { ci } = setup({ api });

      const base = ci.job("base", async () => {
        await $`pnpm install`;
      });

      const lint = ci.job("lint", async () => {
        await from(base);

        await $`pnpm lint`;
      });

      await runFunction(
        ci.pipeline({ id: "pr", on: prTrigger }, async () => {
          await lint();
        }),
        { event: prEvent, runId },
      );
    }

    expect(ran(api, "pnpm install")).toBe(2);
  });

  test("children with different inputs of one parent build once each", async () => {
    const { api, ci } = setup();

    const build = ci.job(
      {
        id: "build",
        input: fakeSchema<{ target: string }>({ target: "string" }),
      },
      async ({ target }) => {
        await $`pnpm build --target ${target}`;
      },
    );

    const web = ci.job("web", async () => {
      await from(build, { target: "web" });

      await $`pnpm test:web`;
    });

    const web2 = ci.job("web2", async () => {
      await from(build, { target: "web" });

      await $`pnpm test:web2`;
    });

    const api2 = ci.job("api", async () => {
      await from(build, { target: "api" });

      await $`pnpm test:api`;
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await Promise.all([web(), web2(), api2()]);
      }),
      { event: prEvent },
    );

    expect(result.type).toBe("function-resolved");
    expect(ran(api, "pnpm build")).toBe(2);

    expect(
      result.stepIds.filter((id) => {
        return id.endsWith("› build");
      }),
    ).toHaveLength(2);
  });

  test("calling the parent directly and from() it builds it twice", async () => {
    const { api, ci } = setup();

    const base = ci.job("base", async () => {
      await $`pnpm install`;
    });

    const lint = ci.job("lint", async () => {
      await from(base);

      await $`pnpm lint`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await base();

      await lint();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");

    // The direct call runs in the pipeline's run, and the build is another
    // run of the same job.
    expect(
      userCommands(api).filter((argv) => {
        return argv[1] === "install";
      }),
    ).toHaveLength(2);

    expect(result.stepIds).toContain("base › machine");
    expect(result.stepIds).toContain("base (from) › build");
    expect(api.sandboxes.size).toBe(3);

    const cloned = [...api.sandboxes.values()].filter((sandbox) => {
      return sandbox.snapshotId;
    });

    expect(cloned).toHaveLength(1);
  });

  test("a direct call after from() is the job's first direct call", async () => {
    const { api, ci } = setup();

    const base = ci.job("base", async () => {
      await $`pnpm install`;
    });

    const lint = ci.job("lint", async () => {
      await from(base);

      await $`pnpm lint`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await lint();

      await base();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(
      userCommands(api).filter((argv) => {
        return argv[1] === "install";
      }),
    ).toHaveLength(2);

    expect(result.stepIds).toContain("base › machine");
    expect(result.stepIds).not.toContain("base (2) › machine");
  });

  test("a child that from()s a cached parent can checkout() again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inngest-ci-from-checkout-"));

    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
      writeFileSync(join(dir, "a.txt"), "a");

      const { api, ci } = setup();

      const base = ci.job("base", async () => {
        await checkout();

        await $`pnpm install`;
      });

      const lint = ci.job("lint", async () => {
        await from(base);

        await checkout();

        await $`pnpm lint`;
      });

      const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await lint();
      });

      const result = await runFunction(pipeline, {
        event: {
          ...prEvent,
          data: { ...prEvent.data, local: { path: dir, baseRef: "main" } },
        },
      });

      expect(result.type).toBe("function-resolved");
      expect(result.stepIds).toContain("base (from) › build");
      expect(result.stepIds).toContain("lint › checkout");

      expect(
        userCommands(api).filter((argv) => {
          return argv[0] === "pnpm";
        }),
      ).toEqual([
        ["pnpm", "install"],
        ["pnpm", "lint"],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("from() after a command throws", async () => {
    const { ci } = setup();

    const parent = ci.job("parent", async () => {});

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
    });

    const test = ci.job("test", async () => {
      await from(install);

      await $`pnpm test`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await test();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(api.sandboxes.size).toBe(2);

    expect(
      [...api.sandboxes.values()].every((sandbox) => {
        return !sandbox.snapshotId;
      }),
    ).toBe(true);

    // The child re-ran the parent on its own machine before its own commands.
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
    expect(api.sandboxes.size).toBe(4);

    expect(
      userCommands(api).map((argv) => {
        return argv.join(" ");
      }),
    ).toEqual([
      // test's build of `build`: its own build of `install`...
      "pnpm install",
      // ...which `build` couldn't copy, so it ran install again, then build
      "pnpm install",
      "pnpm build",
      // test couldn't copy `build` either: `build` ran again on its machine,
      // which asks for `install` again, then test
      "pnpm install",
      "pnpm install",
      "pnpm build",
      "pnpm test",
    ]);
  });
});

describe("machines", () => {
  test("a finished job's machine is destroyed with the run", async () => {
    const { api, ci } = setup();

    const job = ci.job("test", async () => {
      await $`pnpm test`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return job();
    });

    await runFunction(pipeline, { event: prEvent });

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
      },
    );

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await compat();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(
      userCommands(api).map((argv) => {
        return argv.join(" ");
      }),
    ).toEqual(["pnpm test --node 20", "pnpm test --node 22"]);
    expect(api.sandboxes.size).toBe(2);

    expect(
      result.stepIds.some((id) => {
        return id.startsWith("compat (node:20) › machine");
      }),
    ).toBe(true);
  });

  test("a matrix can run one combination", async () => {
    const { api, ci } = setup();
    const ran = new Set<string>();

    const compat = ci.matrix(
      { id: "compat", axes: { node: ["20", "22"] } },
      async ({ node }) => {
        ran.add(node);

        await $`pnpm test`;
      },
    );

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await compat({ node: "22" });
    });

    await runFunction(pipeline, { event: prEvent });

    expect([...ran]).toEqual(["22"]);
    expect(api.sandboxes.size).toBe(1);
  });
});

describe("cache", () => {
  const pushEvent = {
    name: "github/push",
    data: {
      ref: "refs/heads/main",
      after: "abc1234",
      repository: { full_name: "inngest/inngest-js" },
    },
  };

  const pushTrigger = [{ event: "github/push" }];

  /** How many times a command containing `text` ran. */
  const ran = (api: ReturnType<typeof createFakeSandboxApi>, text: string) => {
    return userCommands(api).filter((argv) => {
      return argv.join(" ").includes(text);
    }).length;
  };

  test("a run on another machine finds the snapshot by name and skips the job", async () => {
    // Two apps that share nothing but the sandbox environment.
    const api = createFakeSandboxApi();

    for (const appId of ["machine-a", "machine-b"]) {
      const { ci } = setup({ api, appId });

      const build = ci.job({ id: "setup", cache: { key: "v1" } }, async () => {
        await $`pnpm install`;
      });

      const result = await runFunction(
        ci.pipeline({ id: "pr", on: prTrigger }, async () => {
          return build();
        }),
        { event: prEvent },
      );

      expect(result.type).toBe("function-resolved");
    }

    // Nothing new ran the second time: no extra commands, and no second machine.
    expect(ran(api, "pnpm install")).toBe(1);
    expect(api.sandboxes.size).toBe(1);
    expect(namedSnapshots(api)).toEqual([
      expect.stringMatching(/^ci\/pr:7\/setup\/[0-9a-f]+$/),
    ]);
  });

  test.each([
    ["the same input again", ["1", "1"], 1],
    ["a different input", ["1", "2"], 2],
  ])("the same key with %s", async (_label, inputs, installs) => {
    const api = createFakeSandboxApi();

    for (const version of inputs) {
      const { ci } = setup({ api });

      const build = ci.job<string>(
        { id: "setup", cache: { key: "v1" } },
        async (input) => {
          await $`pnpm install ${input}`;
        },
      );

      await runFunction(
        ci.pipeline({ id: "pr", on: prTrigger }, async () => {
          return build(version);
        }),
        { event: prEvent },
      );
    }

    expect(ran(api, "pnpm install")).toBe(installs);
  });

  test("a changed key misses and runs again", async () => {
    const api = createFakeSandboxApi();

    for (const key of ["v1", "v2"]) {
      const { ci } = setup({ api });

      const build = ci.job({ id: "setup", cache: { key } }, async () => {
        await $`pnpm install`;
      });

      await runFunction(
        ci.pipeline({ id: "pr", on: prTrigger }, async () => {
          return build();
        }),
        { event: prEvent },
      );
    }

    expect(ran(api, "pnpm install")).toBe(2);
    expect(namedSnapshots(api)).toHaveLength(2);
  });

  test("a cached job with a machine can still be started from", async () => {
    const api = createFakeSandboxApi();

    const define = (ci: ReturnType<typeof setup>["ci"]) => {
      const setupJob = ci.job(
        { id: "setup", cache: { key: "v1" } },
        async () => {
          await $`pnpm install`;
        },
      );

      return { setupJob };
    };

    const first = setup({ api });
    const { setupJob } = define(first.ci);

    await runFunction(
      first.ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await setupJob();
      }),
      { event: prEvent },
    );

    const second = setup({ api });
    const { setupJob: setupJob2 } = define(second.ci);

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
    const [cached] = [...api.snapshots.values()];

    expect(
      [...api.sandboxes.values()].filter((machine) => {
        return machine.snapshotId;
      }),
    ).toEqual([expect.objectContaining({ snapshotId: cached?.id })]);
  });

  describe("a cached snapshot built from a parent that has changed is rebuilt when restored", () => {
    /**
     * `setup` and `build` are cached, `build` starts from `setup`, and `test`
     * starts from `build`.
     */
    const runWith = async (
      api: ReturnType<typeof createFakeSandboxApi>,
      setupKey: string,
    ) => {
      const { ci } = setup({ api });

      const setupJob = ci.job(
        { id: "setup", cache: { key: setupKey } },
        async () => {
          await $`pnpm install`;
        },
      );

      const buildJob = ci.job(
        { id: "build", cache: { key: "b" } },
        async () => {
          await from(setupJob);

          await $`pnpm build`;
        },
      );

      const test = ci.job("test", async () => {
        await from(buildJob);

        await $`pnpm test`;
      });

      const result = await runFunction(
        ci.pipeline({ id: "pr", on: prTrigger }, async () => {
          return test();
        }),
        { event: prEvent },
      );

      expect(result.type).toBe("function-resolved");
    };

    /** The snapshot `build` is cached under now. */
    const buildSnapshot = (api: ReturnType<typeof createFakeSandboxApi>) => {
      return [...api.snapshots.values()].find((snapshot) => {
        return snapshot.name?.startsWith("ci/pr:7/build/");
      })?.id;
    };

    test.each([
      [
        "its key changed",
        (_api: ReturnType<typeof createFakeSandboxApi>) => {
          return "s2";
        },
      ],
      [
        "its snapshot is gone",
        (api: ReturnType<typeof createFakeSandboxApi>) => {
          for (const snapshot of api.snapshots.values()) {
            if (snapshot.name?.startsWith("ci/pr:7/setup/")) {
              api.snapshots.delete(snapshot.id);
            }
          }

          return "s1";
        },
      ],
    ])("when %s", async (_label, change) => {
      const api = createFakeSandboxApi();

      await runWith(api, "s1");
      await runWith(api, "s1");

      // Built once, then reused whole.
      expect(ran(api, "pnpm install")).toBe(1);
      expect(ran(api, "pnpm build")).toBe(1);

      const stale = buildSnapshot(api);

      const key = change(api);

      await runWith(api, key);

      expect(ran(api, "pnpm install")).toBe(2);
      expect(ran(api, "pnpm build")).toBe(2);
      expect(ran(api, "pnpm test")).toBe(3);

      // The stale snapshot is deleted, and `test` started from its rebuild.
      const fresh = buildSnapshot(api);

      expect(api.snapshots.has(stale ?? "")).toBe(false);
      expect(fresh).toBeDefined();
      expect(fresh).not.toBe(stale);
      expect(api.snapshotStarts.at(-1)).toBe(fresh);

      // The rebuild is good again for the next run.
      await runWith(api, key);

      expect(ran(api, "pnpm build")).toBe(2);
    });
  });

  test("a build that loses the name to another build uses the winner's snapshot", async () => {
    const { api, ci } = setup();

    api.loseSnapshotNameRaces();

    const base = ci.job({ id: "base", cache: { key: "v1" } }, async () => {
      await $`pnpm install`;
    });

    const lint = ci.job("lint", async () => {
      await from(base);

      await $`pnpm lint`;
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await lint();

        return getRunScope()?.warnings;
      }),
      { event: prEvent },
    );

    expect(result.type).toBe("function-resolved");
    expect(result.data).toEqual([]);

    const [winner, ...others] = [...api.snapshots.values()];

    expect(others).toEqual([]);
    expect(winner?.name).toMatch(/^ci\/pr:7\/base\//);
    expect(winner?.status).toBe("READY");

    const child = [...api.sandboxes.values()].find((machine) => {
      return machine.name === "ci-01TESTRUN-lint";
    });

    expect(child?.snapshotId).toBe(winner?.id);
  });

  test("a refused snapshot name fails the build clearly, with no unnamed snapshot left", async () => {
    const api = createFakeSandboxApi();

    api.refuseSnapshotNames();

    const { ci } = setup({ api });

    const base = ci.job({ id: "base", cache: { key: "v1" } }, async () => {
      await $`pnpm install`;
    });

    const lint = ci.job("lint", async () => {
      await from(base);

      await $`pnpm lint`;
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger, retries: 0 }, async () => {
        await lint();
      }),
      { event: prEvent },
    );

    expect(result.type).toBe("function-rejected");
    expect(String((result.error as { message?: string })?.message)).toContain(
      "was refused",
    );
    expect(api.snapshots.size).toBe(0);
    expect(ran(api, "pnpm lint")).toBe(0);
  });

  test("a pull request reuses what its base branch built, and caches nothing of its own", async () => {
    const api = createFakeSandboxApi();

    const run = async (
      event: { name: string; data: unknown },
      on: { event: string }[],
    ) => {
      const { ci } = setup({ api });

      const build = ci.job({ id: "setup", cache: { key: "v1" } }, async () => {
        await $`pnpm install`;
      });

      const result = await runFunction(
        ci.pipeline({ id: "ci", on }, async () => {
          return build();
        }),
        { event },
      );

      expect(result.type).toBe("function-resolved");
    };

    await run(pushEvent, pushTrigger);
    await run(prEvent, prTrigger);

    expect(ran(api, "pnpm install")).toBe(1);
    expect(namedSnapshots(api)).toEqual([
      expect.stringMatching(/^ci\/main\/setup\//),
    ]);
  });

  test("a cached job with no commands has nothing to cache, so it runs every time and says so", async () => {
    const api = createFakeSandboxApi();

    let runs = 0;

    for (let i = 0; i < 2; i++) {
      const { ci } = setup({ api });

      const plan = ci.job({ id: "plan", cache: { key: "v1" } }, async () => {
        runs += 1;
      });

      const result = await runFunction(
        ci.pipeline({ id: "pr", on: prTrigger }, async () => {
          await plan();

          return getRunScope()?.warnings;
        }),
        { event: prEvent, runId: `01RUN${i}` },
      );

      expect(result.type).toBe("function-resolved");

      expect(result.data).toEqual([
        expect.stringContaining("not cached: `plan` ran no commands"),
      ]);
    }

    expect(runs).toBeGreaterThanOrEqual(2);
    expect(api.snapshots.size).toBe(0);
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
    const api = createFakeSandboxApi();

    const runWith = async (version: string) => {
      const { ci } = setup({ api });

      const parent = ci.job(
        { id: "setup", cache: { key: "p" } },
        async (input: { version: string }) => {
          await $`pnpm install ${input.version}`;
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
    // The same machines and snapshots across both runs, like a real environment.
    const api = createFakeSandboxApi();

    const first = setup({ api });

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

    const second = setup({ api });

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
    expect(restored?.title).toMatch(/^Cached (just now|.+ ago)$/);
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
const setupGitHub = (
  reporter: "checks" | "statuses" = "statuses",
  existing?: ReturnType<typeof createFakeSandboxApi>,
) => {
  const api = existing ?? createFakeSandboxApi();
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

  const runWithSandboxes = (list: () => Promise<unknown>) => {
    return {
      step: {
        run: (_options: unknown, fn: () => unknown) => {
          return fn();
        },
      },
      runId: "r",
      ci: {
        client: {
          sandboxes: { list },
        },
      },
      // biome-ignore lint/suspicious/noExplicitAny: a partial scope is enough here
    } as any;
  };
  test("the machine cleanup step is planned even when no machine exists yet", async () => {
    const { ci } = setup();

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return "ok";
    });

    const result = await runFunction(pipeline, { event: prEvent });

    // Which machines exist depends on how far each sibling got in a request,
    // so the step can't be left out for a request that sees none.
    expect(result.stepIds).toContain("pipeline › cleanup");
    expect(result.steps["pipeline › cleanup"]).toEqual({ destroyed: 0 });
  });

  test("a machine that is already gone is not an error", async () => {
    const run = runWithSandboxes(async () => {
      return {
        items: [
          {
            name: "ci-r-a",
            destroy: async () => {
              throw notFound;
            },
          },
        ],
        page: { hasMore: false },
      };
    });

    await expect(destroyRunMachines(run)).resolves.toBeUndefined();
  });

  test("any other failure fails the step so it retries", async () => {
    const run = runWithSandboxes(async () => {
      return {
        items: [
          {
            name: "ci-r-a",
            destroy: async () => {
              throw new Error("503 service unavailable");
            },
          },
        ],
        page: { hasMore: false },
      };
    });

    await expect(destroyRunMachines(run)).rejects.toThrow("503");

    const lookup = runWithSandboxes(async () => {
      throw new Error("network down");
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
        return id.startsWith("pipeline › cleanup");
      }),
    ).toHaveLength(2);

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

    expect(result.stepIds).toContain("github › repo:resolve");
  });

  test("a comment run gets its pull request's head commit", async () => {
    const { ci, gh } = setupGitHub();

    gh.route("GET /repos/inngest/inngest-js/pulls/12", {
      number: 12,
      head: {
        sha: "beef5678",
        ref: "feature",
        repo: { full_name: "inngest/inngest-js" },
      },
      base: { sha: "base0001", ref: "main" },
    });

    const pipeline = ci.pipeline(
      {
        id: "prerelease",
        on: github.comment({ command: "/prerelease" }),
        check: false,
      },
      async ({ repo }) => {
        return repo;
      },
    );

    const result = await runFunction(pipeline, {
      event: {
        name: "github/issue_comment.created",
        data: {
          action: "created",
          repository: { full_name: "inngest/inngest-js" },
          issue: { number: 12, pull_request: {} },
          comment: { body: "/prerelease", user: { login: "jack" } },
        },
      },
    });

    expect(result.data).toMatchObject({
      sha: "beef5678",
      ref: "feature",
      baseRef: "main",
      baseSha: "base0001",
      pullRequest: { number: 12, headRef: "feature", fork: false },
    });

    expect(result.stepIds).toContain("github › pr:resolve");
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
      ["pr / build", "failure", "machine didn't start in 2m"],
      ["pr", "failure", "build: machine didn't start in 2m"],
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

    gh.route("GET /repos/inngest/inngest-js/pulls/7", {
      number: 7,
      head: { sha: "abc1234", ref: "feature" },
      base: { sha: "base0001", ref: "main" },
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

describe("the end of a run", () => {
  /** The steps every run ends with, in the order it plans them. */
  const endSteps = (stepIds: string[]) => {
    return stepIds.filter((id) => {
      return (
        id === "github › check:jobs:complete" ||
        id === "github › check:pr:complete" ||
        id.startsWith("pipeline › cleanup")
      );
    });
  };

  const expected = [
    "github › check:jobs:complete",
    "github › check:pr:complete",
    "pipeline › cleanup",
    "pipeline › cleanup:snapshots",
  ];

  test("plans the same steps when a job passed, when one failed and when none ran", async () => {
    const run = async (
      handler: (ci: ReturnType<typeof setup>["ci"]) => Promise<unknown>,
    ) => {
      const { api, ci } = setup();

      api.script([{ match: "pnpm fail", exitCode: 1, stderr: "nope" }]);

      return runFunction(
        ci.pipeline({ id: "pr", on: prTrigger }, async () => {
          return handler(ci);
        }),
        { event: prEvent },
      );
    };

    const passed = await run(async (ci) => {
      await ci.job("test", async () => {
        await $`pnpm test`;
      })();
    });

    const failed = await run(async (ci) => {
      await ci.job("test", async () => {
        await $`pnpm fail`;
      })();
    });

    const none = await run(async () => {
      return "nothing awaited";
    });

    expect(passed.type).toBe("function-resolved");
    expect(failed.type).toBe("function-rejected");
    expect(none.type).toBe("function-resolved");

    for (const result of [passed, failed, none]) {
      expect(endSteps(result.stepIds)).toEqual(expected);
    }
  });

  test("a job left unawaited doesn't delay the run's end, and its check is cancelled", async () => {
    const { api, ci } = setup();

    const slow = ci.job("slow", async () => {
      for (let i = 0; i < 20; i++) {
        await $`pnpm slow ${i}`;
      }
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      slow().catch(() => {
        return undefined;
      });

      return "done";
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(result.data).toBe("done");
    expect(endSteps(result.stepIds)).toEqual(expected);

    // The run ended long before the job could have, and said so.
    expect(userCommands(api).length).toBeLessThan(20);
    expect(result.stepIds).not.toContain("github › check:slow:complete");

    expect(result.steps["github › check:jobs:complete"]).toEqual([
      expect.objectContaining({ jobPath: "slow", conclusion: "cancelled" }),
    ]);
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

describe("cache builds in their own run", () => {
  const buildJob = (ci: ReturnType<typeof setup>["ci"], key = "v1") => {
    return ci.job({ id: "base", cache: { key } }, async () => {
      await $`pnpm install`;
    });
  };

  const childPipeline = (
    ci: ReturnType<typeof setup>["ci"],
    base: ReturnType<typeof buildJob>,
  ) => {
    const lint = ci.job("lint", async () => {
      await from(base);

      await $`pnpm lint`;
    });

    return ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return lint();
    });
  };

  /** A pipeline that calls the cached job itself, so it has a check. */
  const directPipeline = (
    ci: ReturnType<typeof setup>["ci"],
    base: ReturnType<typeof buildJob>,
  ) => {
    return ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return base();
    });
  };

  const installs = (api: ReturnType<typeof createFakeSandboxApi>) => {
    return userCommands(api).filter((argv) => {
      return argv[1] === "install";
    }).length;
  };

  test("a miss invokes the build function, and children start from its snapshot", async () => {
    const { api, ci } = setup();
    const base = buildJob(ci);

    const pipeline = childPipeline(ci, base);

    expect(
      ci.functions().find((fn) => {
        return fn.opts.id === "ci/build";
      })?.opts.name,
    ).toBe("build");

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(result.stepIds).toContain("base (from) › build");

    const machines = [...api.sandboxes.values()];

    // The build's machine belongs to the build's run, not the pipeline's.
    expect(machines[0]?.name).toMatch(/^ci-01TESTINVOKED\d+-base$/);

    const child = machines.find((machine) => {
      return machine.name === "ci-01TESTRUN-lint";
    });

    expect(child?.snapshotId).toBeTruthy();
    expect(installs(api)).toBe(1);
  });

  test("a job called directly completes its check when its build does", async () => {
    const { ci, reporter } = setup();

    const result = await runFunction(directPipeline(ci, buildJob(ci)), {
      event: prEvent,
    });

    expect(result.stepIds).toContain("base › build");

    expect(
      reporter.history.find((entry) => {
        return entry.name === "pr / base" && entry.status === "completed";
      })?.title,
    ).toMatch(/^Passed in /);
  });

  test("a hit builds nothing", async () => {
    const api = createFakeSandboxApi();

    for (let i = 0; i < 2; i++) {
      const { ci } = setup({ api });

      await runFunction(childPipeline(ci, buildJob(ci)), { event: prEvent });
    }

    expect(installs(api)).toBe(1);
  });

  test("two pipelines needing the same key build it once", async () => {
    const api = createFakeSandboxApi();

    // Two runs of one app, against one sandbox environment.
    const { ci } = setup({ api });
    const base = buildJob(ci);

    const first = childPipeline(ci, base);
    const second = ci.pipeline({ id: "push", on: prTrigger }, async () => {
      return base();
    });

    const [a, b] = await Promise.all([
      runFunction(first, { event: prEvent, runId: "01RUNA" }),
      runFunction(second, { event: prEvent, runId: "01RUNB" }),
    ]);

    expect(a.type).toBe("function-resolved");
    expect(b.type).toBe("function-resolved");
    expect(installs(api)).toBe(1);

    const snapshots = [...api.sandboxes.values()].filter((machine) => {
      return machine.snapshotId;
    });

    expect(snapshots.length).toBeGreaterThan(0);
  });

  test("a failed build fails the job with its reason and caches nothing", async () => {
    const { api, ci, reporter } = setup();

    const base = ci.job({ id: "base", cache: { key: "v1" } }, async () => {
      throw new NonRetriableError("registry is down");
    });

    for (const pipeline of [
      directPipeline(ci, base),
      childPipeline(ci, base),
    ]) {
      const result = await runFunction(pipeline, { event: prEvent });

      expect(result.type).toBe("function-rejected");
    }

    const failed = reporter.history.filter((entry) => {
      return entry.status === "completed" && entry.conclusion === "failure";
    });

    // The job that called it and the job that started from it.
    expect(
      failed
        .filter((entry) => {
          return entry.name !== "pr";
        })
        .map((entry) => {
          return entry.name;
        })
        .sort(),
    ).toEqual(["pr / base", "pr / lint"]);

    for (const entry of failed) {
      if (entry.name !== "pr") {
        expect(entry.title).toContain("registry is down");
      }
    }

    expect(namedSnapshots(api)).toEqual([]);
  });

  test("the build run posts no check of its own", async () => {
    const { ci, reporter } = setup();

    await runFunction(directPipeline(ci, buildJob(ci)), { event: prEvent });

    expect(
      new Set(
        reporter.history.map((entry) => {
          return entry.pipeline;
        }),
      ),
    ).toEqual(new Set(["pr"]));

    const started = reporter.history.filter((entry) => {
      return entry.name === "pr / base" && entry.status === "in_progress";
    });

    expect(started).toHaveLength(1);
  });

  test("the job's check says it is building in its own run, with its URL", async () => {
    const { client, ci } = setup();
    const info = vi.spyOn(
      (client as unknown as { logger: { info: (...args: unknown[]) => void } })
        .logger,
      "info",
    );

    await runFunction(directPipeline(ci, buildJob(ci)), { event: prEvent });

    const lines = info.mock.calls.map((call) => {
      return String(call[1]);
    });

    expect(
      lines.some((line) => {
        return (
          line.includes("pr / base") &&
          line.includes("Building in its own run") &&
          /localhost:8288\/run\?runID=01TESTINVOKED\d+/.test(line)
        );
      }),
    ).toBe(true);
  });

  test("one build function serves every job and matrix, however many there are", () => {
    const { ci } = setup();

    ci.job("plain", async () => {});

    ci.job({ id: "cached", cache: { key: "v1" } }, async () => {});

    ci.matrix({ id: "compat", axes: { node: ["20", "22"] } }, async () => {});

    const ids = ci
      .functions()
      .map((fn) => {
        return fn.opts.id;
      })
      .filter((id) => {
        return id.startsWith("ci/build");
      });

    expect(ids.sort()).toEqual(["ci/build", "ci/build/cleanup"]);

    ci.job("another", async () => {});

    expect(
      ci.functions().filter((fn) => {
        return fn.opts.id === "ci/build";
      }),
    ).toHaveLength(1);
  });

  test("a build of a job the worker doesn't know fails without retrying, naming it", async () => {
    const { ci } = setup();

    ci.job("known", async () => {});

    const build = ci.functions().find((fn) => {
      return fn.opts.id === "ci/build";
    });

    const result = await runFunction(build as NonNullable<typeof build>, {
      event: {
        name: "inngest/function.invoked",
        data: {
          jobId: "gone",
          ownKey: "k",
          cacheKey: "ci/pr:7/gone/k",
          rootRunId: "01ROOT",
          parent: {
            runId: "01ROOT",
            pipelineId: "pr",
            jobPath: "gone",
            trigger: "manual",
          },
        },
      },
    });

    expect(result.type).toBe("function-rejected");

    expect(result.type === "function-rejected" && result.error).toMatchObject({
      name: "NonRetriableError",
      message: expect.stringMatching(/No job with the ID "gone".*out of date/),
    });
  });

  test("a cached matrix combination is built by its matrix's function", async () => {
    const { api, ci } = setup();

    const compat = ci.matrix(
      { id: "compat", axes: { node: ["20", "22"] }, cache: { key: "m1" } },
      async ({ node }) => {
        await $`fnm use ${node}`;
      },
    );

    const names = ci
      .functions()
      .map((fn) => {
        return fn.opts.id;
      })
      .filter((id) => {
        return id === "ci/build";
      });

    expect(names).toEqual(["ci/build"]);

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await compat();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(
      userCommands(api).filter((argv) => {
        return argv[0] === "fnm";
      }),
    ).toHaveLength(2);
  });
});

describe("run snapshot cleanup", () => {
  const cleanupSteps = (stepIds: string[]) => {
    return stepIds.filter((id) => {
      return id.includes("cleanup:snapshots");
    });
  };

  /** The snapshots the cleanup step deleted. The step is always planned. */
  const deletedBy = (result: { steps: Record<string, unknown> }) => {
    const step = result.steps["pipeline › cleanup:snapshots"] as
      | { deleted: string[] }
      | undefined;

    return step?.deleted ?? [];
  };

  const cachedChain = (ci: ReturnType<typeof setup>["ci"]) => {
    const setupJob = ci.job({ id: "setup", cache: { key: "v1" } }, async () => {
      await $`pnpm install`;
    });

    const test = ci.job("test", async () => {
      await from(setupJob);

      await $`pnpm test`;
    });

    return ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await test();
    });
  };

  test("a from() chain's snapshots are deleted when the run passes", async () => {
    const { api, ci } = setup();
    let duringRun = 0;

    const base = ci.job("base", async () => {
      await $`pnpm install`;
    });

    const child = ci.job("child", async () => {
      await from(base);

      await $`pnpm build`;
    });

    const grandchild = ci.job("grandchild", async () => {
      await from(child);

      await $`pnpm test`;

      duringRun = Math.max(duringRun, api.snapshots.size);
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await grandchild();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    // Both are the pipeline's to delete: `base`'s was left by `child`'s build
    // run, which hands it up instead of deleting what others may share.
    expect(duringRun).toBe(2);
    expect(api.snapshots.size).toBe(0);
    expect(cleanupSteps(result.stepIds)).toHaveLength(1);
    expect(deletedBy(result)).toHaveLength(2);
  });

  test("a run with no snapshots still plans the cleanup step, which deletes nothing", async () => {
    const { ci } = setup();

    const job = ci.job("test", async () => {
      await $`pnpm test`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await job();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    // Always planned, so a request that sees no snapshots yet can't skip a
    // step another request found.
    expect(cleanupSteps(result.stepIds)).toHaveLength(1);
    expect(deletedBy(result)).toHaveLength(0);
  });

  test("snapshots are deleted when the run fails", async () => {
    const { api, ci } = setup();

    const base = ci.job("base", async () => {
      await $`pnpm install`;
    });

    const child = ci.job("child", async () => {
      await from(base);

      throw new Error("boom");
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, retries: 0 },
      async () => {
        await child();
      },
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-rejected");
    expect(api.snapshots.size).toBe(0);
    expect(cleanupSteps(result.stepIds)).toHaveLength(1);
  });

  test("a named cache snapshot survives cleanup, across two runs", async () => {
    const api = createFakeSandboxApi();

    const runOnce = async () => {
      const { ci } = setup({ api });

      return runFunction(cachedChain(ci), { event: prEvent });
    };

    const first = await runOnce();

    expect(first.type).toBe("function-resolved");
    expect(namedSnapshots(api)).toHaveLength(1);

    const kept = [...api.snapshots.keys()];

    const second = await runOnce();

    expect(second.type).toBe("function-resolved");
    expect([...api.snapshots.keys()]).toEqual(kept);
    expect(deletedBy(first)).toHaveLength(0);
    expect(deletedBy(second)).toHaveLength(0);
  });

  test("a snapshot that lost a name race is adopted and kept", async () => {
    const api = createFakeSandboxApi();

    api.loseSnapshotNameRaces();

    const { ci } = setup({ api });

    const result = await runFunction(cachedChain(ci), { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(namedSnapshots(api)).toHaveLength(1);
    expect(deletedBy(result)).toHaveLength(0);
  });

  test("a build run hands up its run-only snapshots and keeps the named one it built", async () => {
    const api = createFakeSandboxApi();
    const { ci } = setup({ api });

    const base = ci.job("base", async () => {
      await $`pnpm install`;
    });

    const cached = ci.job({ id: "cached", cache: { key: "v1" } }, async () => {
      await from(base);

      await $`pnpm build`;
    });

    const test = ci.job("test", async () => {
      await from(cached);

      await $`pnpm test`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await test();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    // `base`'s was taken in the build run and handed up, so the pipeline
    // deletes it; `cached`'s is the named cache snapshot, which stays.
    expect(namedSnapshots(api)).toHaveLength(1);
    expect(api.snapshots.size).toBe(1);
    expect(deletedBy(result)).toHaveLength(1);
  });

  test("a build run doesn't delete the named snapshot it built", async () => {
    const api = createFakeSandboxApi();
    const { ci } = setup({ api });

    let namedDuringRun: string[] = [];

    const base = ci.job({ id: "base", cache: { key: "v1" } }, async () => {
      await $`pnpm install`;
    });

    const lint = ci.job("lint", async () => {
      await from(base);

      await $`pnpm lint`;

      namedDuringRun = namedSnapshots(api);
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return lint();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(namedDuringRun).toHaveLength(1);
    expect(namedSnapshots(api)).toEqual(namedDuringRun);
    expect(deletedBy(result)).toHaveLength(0);
  });

  test("a keepOnFailure snapshot is kept on the failing run", async () => {
    const { api, ci } = setup();

    const base = ci.job("base", async () => {
      await $`pnpm install`;
    });

    const child = ci.job({ id: "child", keepOnFailure: "1h" }, async () => {
      await from(base);

      await $`pnpm build`;

      throw new Error("boom");
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, retries: 0 },
      async () => {
        await child();
      },
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-rejected");
    // `base`'s snapshot is deleted, the kept one of `child` stays.
    expect(api.snapshots.size).toBe(1);
  });

  test("a delete that throws is logged and doesn't fail the run", async () => {
    const real = createFakeSandboxApi();

    const flaky = {
      ...real,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);

        if (
          request.method === "DELETE" &&
          request.url.includes("/snapshots/")
        ) {
          return new Response(
            JSON.stringify({
              errors: [{ code: "internal_error", message: "try later" }],
            }),
            { status: 503, headers: { "content-type": "application/json" } },
          );
        }

        return real.fetch(input, init);
      }) as typeof real.fetch,
    };

    const { client, ci } = setup({ api: flaky });

    const warn = vi.spyOn(
      client.logger as unknown as { warn: (...args: unknown[]) => void },
      "warn",
    );

    const base = ci.job("base", async () => {
      await $`pnpm install`;
    });

    const child = ci.job("child", async () => {
      await from(base);

      await $`pnpm test`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await child();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(real.snapshots.size).toBe(1);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotId: expect.any(String) }),
      expect.any(String),
    );
  });

  test("a snapshot that's already gone is fine", async () => {
    const { api, ci } = setup();

    const base = ci.job("base", async () => {
      await $`pnpm install`;
    });

    const child = ci.job("child", async () => {
      await from(base);

      api.snapshots.clear();

      await $`pnpm test`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await child();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
  });

  test("nothing is deleted on an attempt that will be retried", async () => {
    const { api, ci } = setup();

    const base = ci.job("base", async () => {
      await $`pnpm install`;
    });

    const child = ci.job("child", async () => {
      await from(base);

      await $`pnpm test`;
    });

    let sizeBeforeRetry = -1;

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, retries: 1 },
      async ({ attempt }) => {
        await child();

        if (attempt === 0) {
          sizeBeforeRetry = api.snapshots.size;

          throw new Error("flaky infrastructure");
        }

        return "ok";
      },
    );

    const result = await runFunction(pipeline, { event: prEvent, retries: 1 });

    expect(result.type).toBe("function-resolved");
    expect(sizeBeforeRetry).toBe(1);
    expect(api.snapshots.size).toBe(0);
    expect(cleanupSteps(result.stepIds)).toHaveLength(1);
  });
});
