/**
 * End-to-end tests of pipelines, jobs, machines, caching and reporting,
 * driven through the fake sandbox API.
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
import {
  destroyOrphans,
  destroyRunMachines,
  machineSetupScript,
} from "../machine/machine.ts";
import { sandbox } from "../machine/sandbox.ts";
import { report } from "../report.ts";
import { createCiTestClient } from "../testing/client.ts";
import { prEvent, prTrigger } from "../testing/events.ts";
import { createFakeGitHub } from "../testing/fakeGitHub.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import { createCi } from "./createCi.ts";
import { getRunScope } from "./scope.ts";

/**
 * The commands a job asked for, without CI's own machine setup and snapshot
 * metadata.
 */
const userCommands = (api: ReturnType<typeof createFakeSandboxApi>) => {
  return api.commands.filter((argv) => {
    return argv[2] !== machineSetupScript;
  });
};

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

describe("from", () => {
  test("snapshots the parent once and clones per child", async () => {
    const { api, ci } = setup();

    const install = ci.job("setup", async () => {
      await $`pnpm install`;
    });

    const lint = ci.job({ id: "lint", from: install }, async () => {
      await $`pnpm lint`;
    });

    const test = ci.job({ id: "test", from: install }, async () => {
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

    // The one snapshot was taken for `from`, and is deleted with the run.
    expect(api.snapshots.size).toBe(0);
    expect(api.sandboxes.size).toBe(3);

    const cloned = [...api.sandboxes.values()].filter((sandbox) => {
      return sandbox.snapshotId;
    });

    expect(cloned).toHaveLength(2);
  });

  test("calling the parent directly, then starting from it, runs it once", async () => {
    const { api, ci } = setup();

    const base = ci.job("base", async () => {
      await $`pnpm install`;
    });

    const lint = ci.job({ id: "lint", from: base }, async () => {
      await $`pnpm lint`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await base();

      await lint();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");

    expect(
      userCommands(api).filter((argv) => {
        return argv[1] === "install";
      }),
    ).toHaveLength(1);

    expect(api.sandboxes.size).toBe(2);

    const cloned = [...api.sandboxes.values()].filter((sandbox) => {
      return sandbox.snapshotId;
    });

    expect(cloned).toHaveLength(1);
  });

  test("a direct call after starting from it starts its own run", async () => {
    const { api, ci } = setup();

    const base = ci.job("base", async () => {
      await $`pnpm install`;
    });

    const lint = ci.job({ id: "lint", from: base }, async () => {
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

    expect(result.stepIds).toContain("base (2) › machine");
  });

  test("a child that starts from a cached parent can checkout() again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inngest-ci-from-checkout-"));

    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
      writeFileSync(join(dir, "a.txt"), "a");

      const { api, ci } = setup();

      const base = ci.job("base", async () => {
        await checkout();

        await $`pnpm install`;
      });

      const lint = ci.job({ id: "lint", from: base }, async () => {
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
      expect(result.stepIds).toContain("base › checkout");
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

  test("a `from` naming another client's job throws", async () => {
    const { ci } = setup();
    const other = setup().ci;

    const parent = other.job("parent", async () => {});

    const child = ci.job({ id: "child", from: parent }, async () => {});

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return child();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(String((result.error as { message?: string })?.message)).toContain(
      "isn't defined on this CI client",
    );
  });

  test("a `from` function picks the parent from the job's input", async () => {
    const { api, ci } = setup();

    const build = ci.job("build", async (target: string) => {
      await $`pnpm build --target ${target}`;
    });

    const test = ci.job(
      {
        id: "test",
        from: ({ input }) => {
          return build.with(input);
        },
      },
      async (target: string) => {
        await $`pnpm test --filter ${target}`;
      },
    );

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await test("web");
    });

    await runFunction(pipeline, { event: prEvent });

    expect(
      api.commands
        .filter((argv) => {
          return argv[0] === "pnpm";
        })
        .map((argv) => {
          return argv.join(" ");
        })
        .sort(),
    ).toEqual(["pnpm build --target web", "pnpm test --filter web"]);
  });

  const runFromWithoutSnapshots = async ({
    api,
    ci,
  }: ReturnType<typeof setup>) => {
    const install = ci.job("setup", async () => {
      await $`pnpm install`;
    });

    const test = ci.job({ id: "test", from: install }, async () => {
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

    const build = ci.job({ id: "build", from: install }, async () => {
      await $`pnpm build`;
    });

    const test = ci.job({ id: "test", from: build }, async () => {
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

  test("a second run restores the job and skips its commands", async () => {
    // The same machines and snapshots across both runs, like a real environment.
    const api = createFakeSandboxApi();

    const first = setup({ api });

    const build = first.ci.job(
      { id: "setup", cache: { key: "v1" } },
      async () => {
        await $`pnpm install`;
      },
    );

    const firstPipeline = first.ci.pipeline(
      { id: "pr", on: prTrigger },
      async () => {
        await build();
      },
    );

    await runFunction(firstPipeline, { event: prEvent });

    expect(userCommands(first.api)).toHaveLength(1);

    const second = setup({ api });
    let rebuilt = false;

    const build2 = second.ci.job(
      { id: "setup", cache: { key: "v1" } },
      async () => {
        rebuilt = true;

        await $`pnpm install`;
      },
    );

    const secondPipeline = second.ci.pipeline(
      { id: "pr", on: prTrigger },
      async () => {
        await build2();
      },
    );

    const result = await runFunction(secondPipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(rebuilt).toBe(false);
    // Nothing new ran: no extra commands, and no second machine.
    expect(userCommands(api)).toHaveLength(1);
    expect(api.sandboxes.size).toBe(1);
  });

  test("the same key with a different input is a different entry", async () => {
    const api = createFakeSandboxApi();
    const built: string[] = [];

    const runWith = async (version: string) => {
      const { ci } = setup({ api });

      const build = ci.job<string>(
        { id: "setup", cache: { key: "v1" } },
        async (input) => {
          built.push(input);

          await $`pnpm install`;
        },
      );

      const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await build(version);
      });

      await runFunction(pipeline, { event: prEvent });
    };

    await runWith("1");
    await runWith("2");

    expect(userCommands(api)).toHaveLength(2);

    // The same input again is a hit.
    await runWith("1");

    expect(userCommands(api)).toHaveLength(2);
    expect(new Set(built)).toEqual(new Set(["1", "2"]));
  });

  test("a changed key misses and runs again", async () => {
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
        await job1();
      }),
      { event: prEvent },
    );

    const second = setup({ api });

    const job2 = second.ci.job(
      { id: "setup", cache: { key: "v2" } },
      async () => {
        await $`pnpm install`;
      },
    );

    const result = await runFunction(
      second.ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await job2();
      }),
      { event: prEvent },
    );

    expect(result.type).toBe("function-resolved");
    expect(userCommands(api)).toHaveLength(2);
  });

  test("a cached job with a machine can still be started from", async () => {
    // The same machines and snapshots across both runs, like a real environment.
    const api = createFakeSandboxApi();

    const first = setup({ api });

    const setupJob = first.ci.job(
      { id: "setup", cache: { key: "v1" } },
      async () => {
        await $`pnpm install`;
      },
    );

    await runFunction(
      first.ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await setupJob();
      }),
      { event: prEvent },
    );

    const second = setup({ api });

    const setupJob2 = second.ci.job(
      { id: "setup", cache: { key: "v1" } },
      async () => {
        await $`pnpm install`;
      },
    );

    const test = second.ci.job({ id: "test", from: setupJob2 }, async () => {
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

  describe("a cached job whose parent has changed gets a new name, and builds again", () => {
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
        { id: "build", from: setupJob, cache: { key: "b" } },
        async () => {
          await $`pnpm build`;
        },
      );

      const test = ci.job({ id: "test", from: buildJob }, async () => {
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

    const ran = (
      api: ReturnType<typeof createFakeSandboxApi>,
      command: string,
    ) => {
      return userCommands(api).filter((argv) => {
        return argv.join(" ") === command;
      }).length;
    };

    /** The snapshots `build` is cached under. */
    const buildSnapshots = (api: ReturnType<typeof createFakeSandboxApi>) => {
      return [...api.snapshots.values()].filter((snapshot) => {
        return snapshot.name?.startsWith("ci/pr:7/build/");
      });
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

      const [old] = buildSnapshots(api);

      const startedFromOld = () => {
        return [...api.sandboxes.values()].filter((machine) => {
          return machine.snapshotId === old?.id;
        }).length;
      };

      const before = startedFromOld();

      await runWith(api, change(api));

      // `setup` has a new snapshot, so `build`'s name is new: a miss, found
      // by name alone, and no machine ever started from the old one again.
      expect(ran(api, "pnpm install")).toBe(2);
      expect(ran(api, "pnpm build")).toBe(2);
      expect(ran(api, "pnpm test")).toBe(3);

      const names = buildSnapshots(api).map((snapshot) => {
        return snapshot.name;
      });

      expect(new Set(names).size).toBe(2);

      expect(startedFromOld()).toBe(before);
    });
  });

  test("a job that loses the name to another run uses the winner's snapshot", async () => {
    const { api, ci } = setup();

    api.loseSnapshotNameRaces();

    const base = ci.job({ id: "base", cache: { key: "v1" } }, async () => {
      await $`pnpm install`;
    });

    const lint = ci.job({ id: "lint", from: base }, async () => {
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

  test("a cached snapshot that won't start is deleted, and the job re-runs its parent", async () => {
    const api = createFakeSandboxApi();

    const run = async () => {
      const { ci } = setup({ api });

      const base = ci.job({ id: "base", cache: { key: "v1" } }, async () => {
        await $`pnpm install`;
      });

      const lint = ci.job({ id: "lint", from: base }, async () => {
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

      return result;
    };

    await run();

    const [stale] = [...api.snapshots.values()];

    api.failSnapshotStarts();

    const second = await run();

    expect(second.data).toEqual([
      expect.stringContaining("fell back: snapshot of `base` wouldn't start"),
    ]);

    // The snapshot is gone, `lint` ran on a fresh machine that re-ran `base`,
    // and the machine that wouldn't start isn't left running.
    expect(api.snapshots.has(stale?.id ?? "")).toBe(false);
    expect(ran(api, "pnpm install")).toBe(2);
    expect(ran(api, "pnpm lint")).toBe(2);

    expect(
      [...api.sandboxes.values()].filter((machine) => {
        return machine.stuck && machine.status !== "TERMINATED";
      }),
    ).toEqual([]);
  });

  test("without snapshot names, every run builds, starts children from the snapshot, and passes", async () => {
    const api = createFakeSandboxApi();

    api.withoutSnapshotNames();

    const runs = [];

    for (let i = 0; i < 2; i++) {
      const { ci } = setup({ api });

      const base = ci.job({ id: "base", cache: { key: "v1" } }, async () => {
        await $`pnpm install`;
      });

      const lint = ci.job({ id: "lint", from: base }, async () => {
        await $`pnpm lint`;
      });

      runs.push(
        await runFunction(
          ci.pipeline({ id: "pr", on: prTrigger }, async () => {
            await lint();

            return getRunScope()?.warnings;
          }),
          { event: prEvent },
        ),
      );
    }

    for (const run of runs) {
      expect(run.type).toBe("function-resolved");
      expect(run.data).toEqual([expect.stringContaining("not cached")]);
    }

    expect(ran(api, "pnpm install")).toBe(2);
    expect(namedSnapshots(api)).toEqual([]);

    // Each run's child still started from that run's snapshot of `base`, and
    // nothing can find those later, so each run deleted its own.
    expect(api.snapshotStarts).toHaveLength(2);
    expect(api.snapshots.size).toBe(0);
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
        { event: prEvent },
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
        {
          id: "test",
          cache: { key: "t" },
          from: ({ input }) => {
            return parent.with(input);
          },
        },
        async (_input: { version: string }) => {
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

describe("slow parent hints", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  /**
   * Run a pipeline where `base` and some jobs that start from it run, with
   * every execution request `requestMs` later, and return the pipeline
   * check's summary.
   */
  const runHint = async ({
    requestMs,
    children = 2,
    cache,
    fromBase = true,
    laterRequestMs,
  }: {
    requestMs: number;
    children?: number;
    cache?: boolean;
    fromBase?: boolean;
    /** When set, a stage after the jobs runs with requests this far apart. */
    laterRequestMs?: number;
  }) => {
    let later = false;

    vi.stubEnv("INNGEST_CI_GITHUB", "live");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const { ci, gh } = setupGitHub("checks");

    gh.route("GET /repos/inngest/inngest-js/commits/abc1234/check-runs", {
      check_runs: [],
    });

    gh.route("POST /repos/inngest/inngest-js/check-runs", { id: 9 });
    gh.route("PATCH /repos/inngest/inngest-js/check-runs/9", { id: 9 });

    const base = ci.job(
      { id: "base", ...(cache ? { cache: { key: "v1" } } : {}) },
      async () => {
        await $`pnpm install`;

        await $`pnpm build`;
      },
    );

    const childJobs = Array.from({ length: children }, (_, index) => {
      return ci.job(
        { id: `child-${index}`, ...(fromBase ? { from: base } : {}) },
        async () => {
          await $`pnpm test`;
        },
      );
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, check: { jobs: false } },
      async () => {
        await Promise.all(
          childJobs.map((child) => {
            return child();
          }),
        );

        if (!fromBase) {
          await base();
        }

        if (laterRequestMs !== undefined) {
          later = true;

          const tail = ci.job("tail", async () => {
            await $`pnpm lint`;

            await $`pnpm e2e`;
          });

          await tail();
        }
      },
    );

    const result = await runFunction(pipeline, {
      event: prEvent,
      beforeRequest: () => {
        vi.setSystemTime(
          Date.now() + (later ? (laterRequestMs ?? requestMs) : requestMs),
        );
      },
    });

    expect(result.type).toBe("function-resolved");

    const completion = gh.requests.find((request) => {
      return (
        request.method === "PATCH" &&
        (request.body as { status?: string })?.status === "completed"
      );
    });

    return (
      (completion?.body as { output?: { summary?: string } })?.output
        ?.summary ?? ""
    );
  };

  const hintLines = (summary: string) => {
    return summary.split("\n").filter((line) => {
      return line.includes("started from it");
    });
  };

  test("an uncached slow parent gets one line with its count and duration", async () => {
    const summary = await runHint({ requestMs: 20_000 });
    const lines = hintLines(summary);

    expect(lines).toHaveLength(1);

    const duration = /^\| base \|.*\| (\S+(?: \S+)?) \|$/m.exec(summary)?.[1];

    expect(duration).toBeDefined();
    expect(lines[0]).toBe(
      `- \`base\` took ${duration} and 2 jobs started from it. It isn't cached, so it runs again next time. To reuse it, give it a cache key: \`cache: { key: files("pnpm-lock.yaml") }\`.`,
    );
  });

  test("one job starting from it reads as singular", async () => {
    const summary = await runHint({ requestMs: 20_000, children: 1 });

    expect(hintLines(summary)).toHaveLength(1);
    expect(summary).toContain(" and 1 job started from it.");
  });

  test("a cached parent gets no line", async () => {
    const summary = await runHint({ requestMs: 20_000, cache: true });

    expect(hintLines(summary)).toHaveLength(0);
  });

  test("a parent that took 30s or less gets no line", async () => {
    const summary = await runHint({ requestMs: 1 });

    expect(hintLines(summary)).toHaveLength(0);
  });

  test("a fast parent isn't inflated by a slow stage after it", async () => {
    const summary = await runHint({ requestMs: 1, laterRequestMs: 60_000 });

    expect(hintLines(summary)).toHaveLength(0);

    const row = /^\| base \|.*\| (\S+(?: \S+)?) \|$/m.exec(summary);

    expect(row?.[1]).toMatch(/^(\d+ms|\d|[12]\ds)$/);
    expect(row?.[0]).not.toMatch(/\dm /);
  });

  test("a slow job nothing starts from gets no line", async () => {
    const summary = await runHint({ requestMs: 20_000, fromBase: false });

    expect(hintLines(summary)).toHaveLength(0);
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

    const test = ci.job({ id: "test", from: setupJob }, async () => {
      await $`pnpm test`;
    });

    return ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await test();
    });
  };

  test("a `from` chain's snapshots are deleted when the run passes", async () => {
    const { api, ci } = setup();
    let duringRun = 0;

    const base = ci.job("base", async () => {
      await $`pnpm install`;
    });

    const child = ci.job({ id: "child", from: base }, async () => {
      await $`pnpm build`;
    });

    const grandchild = ci.job({ id: "grandchild", from: child }, async () => {
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

    const child = ci.job({ id: "child", from: base }, async () => {
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

  test("only the run's own snapshots go when a cached job's sits beside them", async () => {
    const api = createFakeSandboxApi();
    const { ci } = setup({ api });

    const base = ci.job("base", async () => {
      await $`pnpm install`;
    });

    const cached = ci.job(
      { id: "cached", from: base, cache: { key: "v1" } },
      async () => {
        await $`pnpm build`;
      },
    );

    const test = ci.job({ id: "test", from: cached }, async () => {
      await $`pnpm test`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await test();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    // `base`'s is deleted; `cached`'s is the cache entry.
    expect(api.snapshots.size).toBe(1);
    expect(cleanupSteps(result.stepIds)).toHaveLength(1);
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

  test("an unnamed fallback snapshot is deleted at the end of the run", async () => {
    const api = createFakeSandboxApi();

    api.withoutSnapshotNames();

    const { ci } = setup({ api });

    const result = await runFunction(cachedChain(ci), { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(namedSnapshots(api)).toHaveLength(0);
    expect(api.snapshots.size).toBe(0);
    expect(cleanupSteps(result.stepIds)).toHaveLength(1);
  });

  test("a keepOnFailure snapshot is kept on the failing run", async () => {
    const { api, ci } = setup();

    const base = ci.job("base", async () => {
      await $`pnpm install`;
    });

    const child = ci.job(
      { id: "child", from: base, keepOnFailure: "1h" },
      async () => {
        await $`pnpm build`;

        throw new Error("boom");
      },
    );

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

    const child = ci.job({ id: "child", from: base }, async () => {
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
      expect.stringContaining("Couldn't delete a snapshot"),
    );
  });

  test("a snapshot that's already gone is fine", async () => {
    const { api, ci } = setup();

    const base = ci.job("base", async () => {
      await $`pnpm install`;
    });

    const child = ci.job({ id: "child", from: base }, async () => {
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

    const child = ci.job({ id: "child", from: base }, async () => {
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
