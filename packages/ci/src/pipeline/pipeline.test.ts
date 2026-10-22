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
import type { StandardSchemaV1 } from "@standard-schema/spec";
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
import { busOf, createCiTestClient } from "../testing/client.ts";
import { prEvent, prTrigger } from "../testing/events.ts";
import { createFakeGitHub } from "../testing/fakeGitHub.ts";
import type { FakeSnapshot } from "../testing/fakeSandbox.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { invokedRunCount, runFunction } from "../testing/runFunction.ts";
import { fakeSchema } from "../testing/schema.ts";
import { temporalDuration } from "../testing/temporal.ts";
import type { Job } from "../types.ts";
import type { Ci } from "./createCi.ts";
import { createCi } from "./createCi.ts";
import { runCombosKey } from "./matrix.ts";
import { cleanupFunction } from "./pipeline.ts";
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

describe("matrix IDs", () => {
  test("defining the same matrix ID twice is rejected", () => {
    const { ci } = setup();

    ci.job(
      { id: "compat", matrix: { axes: { node: ["20"] } } },
      async () => {},
    );

    expect(() => {
      return ci.job(
        { id: "compat", matrix: { axes: { node: ["22"] } } },
        async () => {},
      );
    }).toThrow(/already defined/);
  });
});

describe("pipelines and jobs", () => {
  test("a job runs its commands on its own machine", async () => {
    const { api, ci } = setup();

    const test = ci.job("test", async () => {
      await $`pnpm install`;

      await $`pnpm test`;
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, childRuns: false },
      async () => {
        await test();
      },
    );

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

    expect(machineSetupScript).toContain('echo "127.0.0.1 localhost"');

    expect(machineSetupScript).toContain('echo "::1 localhost"');
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

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, childRuns: false },
      async () => {
        await test();

        await test();

        await test();
      },
    );

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

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, childRuns: false },
      async () => {
        await Promise.all([build(), build()]);
      },
    );

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

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, childRuns: false },
      async () => {
        await one();

        await two();
      },
    );

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

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, childRuns: false },
      async () => {
        return job();
      },
    );

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

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, childRuns: false },
      async () => {
        return job();
      },
    );

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

    const build = ci.job(
      { id: "build", input },
      async ({ input: { target, minify } }) => {
        received.add(JSON.stringify({ target, minify }));

        await $`pnpm build --target ${target}`;
      },
    );

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

    const base = ci.job(
      { id: "base", input },
      async ({ input: { target } }) => {
        await $`pnpm install --target ${target}`;
      },
    );

    const test = ci.job(
      { id: "test", from: base.with({ target: "web" }) },
      async () => {},
    );

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return test();
    });

    await runFunction(pipeline, { event: prEvent });

    expect(userCommands(api)).toHaveLength(1);
  });

  test("a job without a schema takes its input as given", async () => {
    const { ci } = setup();
    const received = new Set<string>();

    const greet = ci.job(
      "greet",
      async ({ input: name }: { input: string }) => {
        received.add(name);
      },
    );

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return greet("jack");
    });

    await runFunction(pipeline, { event: prEvent });

    expect([...received]).toEqual(["jack"]);
  });
});

describe("a job's input in its build run", () => {
  /**
   * A schema that turns a string into a Date, and refuses anything else, as a
   * schema that doesn't accept its own output does.
   */
  const dateSchema: StandardSchemaV1<{ at: string }, { at: Date }> = {
    "~standard": {
      version: 1,
      vendor: "fake",
      validate: (input: unknown) => {
        const at = (input as { at?: unknown } | undefined)?.at;

        if (typeof at !== "string") {
          return { issues: [{ message: "Expected a string", path: ["at"] }] };
        }

        return { value: { at: new Date(at) } };
      },
    },
  };

  const setupDates = () => {
    const { api, ci } = setup();
    // A handler replays on every step, so what it saw is a set.
    const seen = new Set<string>();

    const base = ci.job(
      { id: "base", cache: { key: "v1" }, input: dateSchema },
      async ({ input: { at } }) => {
        seen.add(at instanceof Date ? at.toISOString() : typeof at);

        await $`pnpm install`;
      },
    );

    return { api, ci, base, seen };
  };

  test("a cached job called directly gets the schema's output in its build", async () => {
    const { ci, base, seen } = setupDates();

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return base({ at: "2026-01-02T03:04:05.000Z" });
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect([...seen]).toEqual(["2026-01-02T03:04:05.000Z"]);
  });

  test("a parent started from gets the schema's output in its build", async () => {
    const { ci, base, seen } = setupDates();

    const lint = ci.job(
      { id: "lint", from: base.with({ at: "2026-01-02T03:04:05.000Z" }) },
      async () => {},
    );

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return lint();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect([...seen]).toEqual(["2026-01-02T03:04:05.000Z"]);
  });

  test("a Set made by the schema from the JSON input reaches the build as a Set", async () => {
    const { ci } = setup();
    const seen = new Set<string>();

    const tags: StandardSchemaV1<{ tags: string[] }, { tags: Set<string> }> = {
      "~standard": {
        version: 1,
        vendor: "fake",
        validate: (input: unknown) => {
          const list = (input as { tags?: unknown } | undefined)?.tags;

          if (!Array.isArray(list)) {
            return { issues: [{ message: "Expected an array" }] };
          }

          return { value: { tags: new Set<string>(list) } };
        },
      },
    };

    const base = ci.job(
      { id: "base", cache: { key: "v1" }, input: tags },
      async ({ input: { tags } }) => {
        seen.add(tags instanceof Set ? [...tags].join(",") : typeof tags);

        await $`pnpm install`;
      },
    );

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return base({ tags: ["a", "b"] });
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect([...seen]).toEqual(["a,b"]);
  });

  test("an input JSON can't carry fails the job with a reason", async () => {
    const { ci } = setup();

    const base = ci.job(
      { id: "base", cache: { key: "v1" } },
      async (_ctx: { input: { big: bigint } }) => {
        await $`pnpm install`;
      },
    );

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, retries: 0 },
      async () => {
        return base({ big: 1n });
      },
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-rejected");
    expect(String((result.error as Error).message)).toMatch(
      /BigInt|serialize/i,
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

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, childRuns: false },
      async () => {
        return job();
      },
    );

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

  test("a command that ends in its first window takes one step", async () => {
    const { api, ci } = setup();

    api.script([{ match: "quick", stdout: "done" }]);

    let output: string | undefined;

    const job = ci.job("quick", async () => {
      output = await $`quick`.text();
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, childRuns: false },
      async () => {
        await job();
      },
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(output).toBe("done");

    expect(
      result.stepIds.filter((id) => {
        return id.startsWith("quick › quick");
      }),
    ).toEqual(["quick › quick › start"]);
  });

  test("a command's start step carries the sandbox metadata the trace reads", async () => {
    const { api, ci } = setup();

    api.script([{ match: "quick", stdout: "done" }]);

    const job = ci.job("quick", async () => {
      await $`quick`;
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, childRuns: false },
      async () => {
        await job();
      },
    );

    const result = await runFunction(pipeline, { event: prEvent });

    const entry = result.metadata.find((update) => {
      return (
        update.step === "quick › quick › start" &&
        update.kind === "inngest.sandbox"
      );
    });

    expect(entry?.values).toMatchObject({
      version: 1,
      action: "process.start",
      method: "processes.start",
      command: ["quick"],
      process_state: "EXITED",
      exit_code: 0,
    });
  });

  test("a command that runs on takes a step per window, and starts once", async () => {
    const { api, ci } = setup();

    api.script([{ match: "slow", ticks: 3, stdout: "eventually" }]);

    const job = ci.job("slow", async () => {
      await $`slow`;
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, childRuns: false },
      async () => {
        await job();
      },
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(
      result.stepIds.filter((id) => {
        return id.startsWith("slow › slow");
      }),
    ).toEqual([
      "slow › slow › start",
      "slow › slow › check #1",
      "slow › slow › check #2",
      "slow › slow › check #3",
    ]);

    // The handler replays on every step, and none of them starts it again.
    expect(
      userCommands(api).map((argv) => {
        return argv.join(" ");
      }),
    ).toEqual(["slow"]);
  });

  test("a command that needs several polls still completes", async () => {
    const { api, ci } = setup();

    api.script([{ match: "slow", ticks: 3, stdout: "eventually" }]);

    let output: string | undefined;

    const job = ci.job("slow", async () => {
      output = await $`slow`.text();
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, childRuns: false },
      async () => {
        await job();
      },
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(output).toBe("eventually");

    expect(
      result.stepIds.filter((id) => {
        return id.includes("check #");
      }).length,
    ).toBe(3);
  });

  test.each(["30s", 30_000, temporalDuration(30_000)])(
    "a short command with a %j timeout runs as one captured step",
    async (timeout) => {
      const { api, ci } = setup();

      api.script([{ match: "quick", stdout: "fast" }]);

      let output: string | undefined;

      const job = ci.job("quick", async () => {
        output = await $`quick`.timeout(timeout).text();
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
    },
  );

  test.each([
    ["2s", "2s"],
    [1500, "1500ms"],
  ])(
    "a captured command that times out throws CommandTimeoutError (%s)",
    async (limit, shown) => {
      const { api, ci } = setup();

      api.script([{ match: "hang", execTimesOut: true }]);

      let caught: unknown = "no error";

      const job = ci.job("hang", async () => {
        let lookedAround = false;

        try {
          await $`hang`.timeout(limit).onTimeout(async () => {
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
        message: `\`hang\` timed out after ${shown}`,
        lookedAround: true,
      });
    },
  );

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

  test("a background process's output keeps stdout and stderr in the order they were written", async () => {
    const { api, ci } = setup();

    api.script([
      {
        match: "serve",
        ticks: 1,
        chunks: [
          { stream: "STDOUT", text: "one\n" },
          { stream: "STDERR", text: "two\n" },
          { stream: "STDOUT", text: "three\n" },
        ],
      },
    ]);

    let output: string | undefined;

    const job = ci.job("e2e", async () => {
      const server = await $`serve`.background();

      output = await server.output();

      await server.kill();
    });

    await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await job();
      }),
      { event: prEvent },
    );

    expect(output).toBe("one\ntwo\nthree\n");
  });

  test("a command that ends during its first wait reports its duration", async () => {
    const { ci } = setup();

    let seen: number | undefined;

    const job = ci.job("timed", async () => {
      const result = await $`true`;

      seen = result.durationMs;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await job();
    });

    await runFunction(pipeline, { event: prEvent });

    expect(typeof seen).toBe("number");
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

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, childRuns: false },
      async () => {
        await job();
      },
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(seen).toEqual({ first: "one", second: "two", server: "up" });

    // Each start ran once: reconciling never starts the command again, and is
    // a step of its own, so a failed lookup never repeats the start.
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

  test("a failed lookup after an ambiguous start never starts the command again", async () => {
    const api = createFakeSandboxApi();

    api.script([{ match: "once", stdout: "done", ambiguousStarts: 1 }]);

    let failedLists = 1;

    const fetch = api.fetch;

    api.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);

      if (
        failedLists > 0 &&
        init?.method === "GET" &&
        url.endsWith("/processes?limit=250")
      ) {
        failedLists--;

        return new Response(
          JSON.stringify({
            errors: [{ code: "unavailable", message: "try again" }],
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }

      return fetch(input, init);
    };

    const { ci } = setup({ api });

    let seen: unknown;

    const job = ci.job("lookup", async () => {
      seen = await $`once`.text();
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await job();
    });

    await runFunction(pipeline, { event: prEvent });

    expect(seen).toBe("done");
    expect(failedLists).toBe(0);
    expect(
      userCommands(api).map((argv) => {
        return argv.join(" ");
      }),
    ).toEqual(["once"]);
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

  test("two children of one uncached parent share one invoke and one build run", async () => {
    const { api, ci } = setup();

    const base = ci.job("base", async () => {
      await $`pnpm install`;
    });

    const lint = ci.job({ id: "lint", from: base }, async () => {
      await $`pnpm lint`;
    });

    const test = ci.job({ id: "test", from: base }, async () => {
      await $`pnpm test`;
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, childRuns: false },
      async () => {
        await Promise.all([lint(), test()]);
      },
    );

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

    const pack = ci.job({ id: "pack", from: build }, async () => {
      await $`pnpm pack`;
    });

    const ship = ci.job({ id: "ship", from: pack }, async () => {
      await $`pnpm ship`;
    });

    const lint = ci.job({ id: "lint", from: build }, async () => {
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

    const lint = ci.job({ id: "lint", from: base }, async () => {
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

      const lint = ci.job({ id: "lint", from: base }, async () => {
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

  test("an uncached parent's snapshot without names is still started from and deleted", async () => {
    const { api, ci } = setup();

    api.withoutSnapshotNames();

    const base = ci.job("base", async () => {
      await $`pnpm install`;
    });

    const lint = ci.job({ id: "lint", from: base }, async () => {
      await $`pnpm lint`;
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await lint();

        // Nothing was meant to be cached, so there is nothing to warn about.
        return getRunScope()?.warnings;
      }),
      { event: prEvent },
    );

    expect(result.type).toBe("function-resolved");
    expect(result.data).toEqual([]);
    expect(api.snapshotStarts).toHaveLength(1);
    expect(api.snapshots.size).toBe(0);
  });

  test("children with different inputs of one parent build once each", async () => {
    const { api, ci } = setup();

    const build = ci.job(
      {
        id: "build",
        input: fakeSchema<{ target: string }>({ target: "string" }),
      },
      async ({ input: { target } }) => {
        await $`pnpm build --target ${target}`;
      },
    );

    const web = ci.job(
      { id: "web", from: build.with({ target: "web" }) },
      async () => {
        await $`pnpm test:web`;
      },
    );

    const web2 = ci.job(
      { id: "web2", from: build.with({ target: "web" }) },
      async () => {
        await $`pnpm test:web2`;
      },
    );

    const api2 = ci.job(
      { id: "api", from: build.with({ target: "api" }) },
      async () => {
        await $`pnpm test:api`;
      },
    );

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger, childRuns: false }, async () => {
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

  test("calling the parent directly and starting from it builds it twice", async () => {
    const { api, ci } = setup();

    const base = ci.job("base", async () => {
      await $`pnpm install`;
    });

    const lint = ci.job({ id: "lint", from: base }, async () => {
      await $`pnpm lint`;
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, childRuns: false },
      async () => {
        await base();

        await lint();
      },
    );

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

  test("a direct call after starting from it is the job's first direct call", async () => {
    const { api, ci } = setup();

    const base = ci.job("base", async () => {
      await $`pnpm install`;
    });

    const lint = ci.job({ id: "lint", from: base }, async () => {
      await $`pnpm lint`;
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, childRuns: false },
      async () => {
        await lint();

        await base();
      },
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(
      userCommands(api).filter((argv) => {
        return argv[1] === "install";
      }),
    ).toHaveLength(2);

    expect(result.stepIds).toContain("base › machine");
    expect(result.stepIds).not.toContain("base (2) › machine");
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

      const pipeline = ci.pipeline(
        { id: "pr", on: prTrigger, childRuns: false },
        async () => {
          await lint();
        },
      );

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

  test("every combination of a matrix starts from its `from`", async () => {
    const { api, ci } = setup();

    const install = ci.job("setup", async () => {
      await $`pnpm install`;
    });

    const compat = ci.job(
      { id: "compat", matrix: { axes: { node: ["20", "22"] } }, from: install },
      async ({ matrix: { node } }) => {
        await $`node ${node}`;
      },
    );

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await compat();
    });

    await runFunction(pipeline, { event: prEvent });

    expect(ran(api, "pnpm install")).toBe(1);

    const cloned = [...api.sandboxes.values()].filter((sandbox) => {
      return sandbox.snapshotId;
    });

    expect(cloned).toHaveLength(2);
  });

  test("a `from` that isn't a job throws when the job is defined", () => {
    const { ci } = setup();

    expect(() => {
      ci.job({ id: "child", from: "parent" as unknown as Job }, async () => {});
    }).toThrow(
      'The `from` of job "child" must name a job, or a job with input from `job.with(input)`.',
    );

    expect(() => {
      ci.job({ id: "other", from: {} as unknown as Job }, async () => {});
    }).toThrow("must name a job");
  });

  test("a `from` naming another client's job throws when the job is defined", () => {
    const { ci } = setup();
    const other = setup().ci;

    const parent = other.job("parent", async () => {});

    expect(() => {
      ci.job({ id: "child", from: parent }, async () => {});
    }).toThrow("`parent`, which isn't defined on this CI client");

    // The ID matches a job on this client, which isn't the one named.
    ci.job("same", async () => {});

    const impostor = other.job("same", async () => {});

    expect(() => {
      ci.job({ id: "child", from: impostor.with() }, async () => {});
    }).toThrow("isn't defined on this CI client");
  });

  test("input that fails the parent's schema throws when the job is defined", () => {
    const { ci } = setup();

    const build = ci.job(
      {
        id: "build",
        input: fakeSchema<{ target: string }>({ target: "string" }),
      },
      async () => {},
    );

    expect(() => {
      ci.job(
        {
          id: "test",
          from: build.with({ target: 1 as unknown as string }),
        },
        async () => {},
      );
    }).toThrow(/target: Expected string/);

    expect(() => {
      ci.job({ id: "ok", from: build.with({ target: "web" }) }, async () => {});
    }).not.toThrow();
  });

  test("a `from` that gives a required schema no input throws when the job is defined", () => {
    const { ci } = setup();

    const build = ci.job(
      {
        id: "build",
        input: fakeSchema<{ target: string }>({ target: "string" }),
      },
      async () => {},
    );

    expect(() => {
      ci.job(
        {
          id: "test",
          from: build.with(undefined as unknown as { target: string }),
        },
        async () => {},
      );
    }).toThrow(/target: Required/);
  });

  test("input checked by an async schema waits for run time", () => {
    const { ci } = setup();

    const input: StandardSchemaV1<unknown, { target: string }> = {
      "~standard": {
        version: 1,
        vendor: "fake",
        validate: async () => {
          return { issues: [{ message: "never" }] };
        },
      },
    };

    const build = ci.job({ id: "build", input }, async () => {});

    expect(() => {
      ci.job(
        { id: "test", from: build.with({ target: "web" }) },
        async () => {},
      );
    }).not.toThrow();
  });

  test("a matrix with a bad static `from` throws when it's defined", () => {
    const { ci } = setup();
    const other = setup().ci;

    const parent = other.job("parent", async () => {});

    expect(() => {
      ci.job(
        { id: "compat", matrix: { axes: { node: ["20"] } }, from: parent },
        async () => {},
      );
    }).toThrow("isn't defined on this CI client");

    expect(() => {
      ci.job(
        {
          id: "compat2",
          matrix: { axes: { node: ["20"] } },
          from: "parent" as unknown as Job,
        },
        async () => {},
      );
    }).toThrow("must name a job");
  });

  test.each([
    {
      name: "an empty matrix axis",
      define: (ci: Ci) => {
        ci.job({ id: "m", matrix: { axes: { node: [] } } }, async () => {});
      },
      message: 'The `node` axis of matrix "m" has no values',
    },
    {
      name: "an empty string cache key",
      define: (ci: Ci) => {
        ci.job({ id: "j", cache: { key: "" } }, async () => {});
      },
      message: 'The `cache.key` of "j" can\'t be empty',
    },
    {
      name: "an empty list cache key",
      define: (ci: Ci) => {
        ci.job({ id: "j", cache: { key: [] } }, async () => {});
      },
      message: 'The `cache.key` of "j" can\'t be empty',
    },
    {
      name: "an unknown cache scope",
      define: (ci: Ci) => {
        ci.job(
          { id: "j", cache: { scope: "pr" as unknown as "branch" } },
          async () => {},
        );
      },
      message: 'The `cache.scope` of "j" must be "branch" or "global"',
    },
    {
      name: "an unknown cache scope on a matrix",
      define: (ci: Ci) => {
        ci.job(
          {
            id: "m",
            matrix: { axes: { node: ["20"] } },
            cache: { scope: "pr" as unknown as "branch" },
          },
          async () => {},
        );
      },
      message: 'The `cache.scope` of "m" must be',
    },
  ])("$name throws when it's defined", ({ define, message }) => {
    const { ci } = setup();

    expect(() => {
      define(ci);
    }).toThrow(message);
  });

  test("a `from` function that returns a non-job fails the run for good", async () => {
    const { ci } = setup();

    const child = ci.job(
      { id: "child", from: (() => "nope") as unknown as () => Job },
      async () => {},
    );

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return child();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-rejected");
    expect(result.retriable).toBe(false);

    expect(String((result.error as { message?: string })?.message)).toContain(
      "must name a job",
    );
  });

  test.each([
    {
      name: "a `from` function that leads back to the start",
      message:
        "`a` > `b` > `a` starts from itself. A job can't start from itself; remove one of these `from`s.",
      define: (ci: Ci) => {
        const a: Job = ci.job({ id: "a", from: () => b }, async () => {});
        const b: Job = ci.job({ id: "b", from: () => a }, async () => {});

        return a;
      },
    },
    {
      name: "a cycle only reachable through a parent's own parent",
      message: "`c` > `a` > `b` > `a` starts from itself",
      define: (ci: Ci) => {
        const a: Job = ci.job({ id: "a", from: () => b }, async () => {});
        const b: Job = ci.job({ id: "b", from: () => a }, async () => {});

        return ci.job({ id: "c", from: a }, async () => {});
      },
    },
    {
      name: "a job that names itself",
      message: "`a` > `a` starts from itself",
      define: (ci: Ci) => {
        const a: Job = ci.job({ id: "a", from: () => a }, async () => {});

        return a;
      },
    },
  ])(
    "$name fails the run once, before any build",
    async ({ define, message }) => {
      const { ci } = setup();
      const entry = define(ci);

      const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        return entry();
      });

      const before = invokedRunCount();
      const result = await runFunction(pipeline, { event: prEvent });

      expect(result.type).toBe("function-rejected");
      expect(result.retriable).toBe(false);

      expect(String((result.error as { message?: string })?.message)).toContain(
        message,
      );

      expect(invokedRunCount() - before).toBe(0);
    },
  );

  test("a `from` function picks the parent from the job's input", async () => {
    const { api, ci } = setup();

    const build = ci.job(
      {
        id: "build",
        input: fakeSchema<{ target: string }>({ target: "string" }),
      },
      async ({ input: { target } }) => {
        await $`pnpm build --target ${target}`;
      },
    );

    const test = ci.job(
      {
        id: "test",
        input: fakeSchema<{ target: string }>({ target: "string" }),
        from: ({ input }) => {
          return build.with({ target: input.target });
        },
      },
      async ({ input: { target } }) => {
        await $`pnpm test --filter ${target}`;
      },
    );

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await Promise.all([test({ target: "web" }), test({ target: "api" })]);
    });

    await runFunction(pipeline, { event: prEvent });

    expect(userCommands(api).sort()).toEqual([
      ["pnpm", "build", "--target", "api"],
      ["pnpm", "build", "--target", "web"],
      ["pnpm", "test", "--filter", "api"],
      ["pnpm", "test", "--filter", "web"],
    ]);
  });

  const runFromWithFailingSnapshots = async (
    { api, ci }: ReturnType<typeof setup>,
    why: string,
  ) => {
    const install = ci.job("setup", async () => {
      await $`pnpm install`;
    });

    const test = ci.job({ id: "test", from: install }, async () => {
      await $`pnpm test`;
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, retries: 0 },
      async () => {
        await test();
      },
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-rejected");
    expect(JSON.stringify(result.error)).toContain(why);

    // The parent ran once, and nothing replayed it on the child's machine.
    expect(
      userCommands(api).map((argv) => {
        return argv.join(" ");
      }),
    ).toEqual(["pnpm install"]);
  };

  test("fails when the snapshot limit is reached instead of re-running the parent", async () => {
    const ctx = setup();

    ctx.api.exhaustSnapshots();

    await runFromWithFailingSnapshots(ctx, "snapshot limit");
  });

  test("fails when snapshots aren't available instead of re-running the parent", async () => {
    const ctx = setup();

    ctx.api.disableSnapshots();

    await runFromWithFailingSnapshots(ctx, "snapshot");
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

  test("machines default to 4 vCPU and 4 GiB", async () => {
    const { api, ci } = setup();

    const job = ci.job("plain", async () => {
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

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, childRuns: false },
      async () => {
        return job();
      },
    );

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

    const compat = ci.job(
      { id: "compat", matrix: { axes: { node: ["20", "22"] } } },
      async ({ matrix: { node } }) => {
        await $`pnpm test --node ${node}`;
      },
    );

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, childRuns: false },
      async () => {
        await compat();
      },
    );

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

  test("a `from` function that throws fails only its combination's job", async () => {
    const { api, ci, reporter } = setup();

    const base = ci.job("base", async () => {
      await $`pnpm install`;
    });

    const compat = ci.job(
      {
        id: "compat",
        matrix: { axes: { node: ["20", "22"] } },
        from: ({ input }) => {
          if (input.node === "20") {
            throw new Error("no base for node 20");
          }

          return base;
        },
      },
      async ({ matrix: { node } }) => {
        await $`pnpm test --node ${node}`;
      },
    );

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, retries: 0 },
      async () => {
        await compat();
      },
    );

    await runFunction(pipeline, { event: prEvent });

    const failed = reporter.history
      .filter((entry) => {
        return entry.status === "completed" && entry.conclusion === "failure";
      })
      .map((entry) => {
        return entry.name;
      });

    expect(failed).toContain("pr / compat (node:20)");

    expect(
      userCommands(api).map((argv) => {
        return argv.join(" ");
      }),
    ).toContain("pnpm test --node 22");
  });

  test("a matrix can run one combination", async () => {
    const { api, ci } = setup();
    const ran = new Set<string>();

    const compat = ci.job(
      { id: "compat", matrix: { axes: { node: ["20", "22"] } } },
      async ({ matrix: { node } }) => {
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

  test("a build asked for a combination the matrix lacks fails instead of passing", async () => {
    const { ci } = setup();

    const compat = ci.job(
      { id: "compat", matrix: { axes: { node: ["20", "22"] } } },
      async () => {},
    );

    await expect(
      (
        compat as unknown as {
          [runCombosKey](combos: Record<string, unknown>[]): Promise<void>;
        }
      )[runCombosKey]([{ node: "18" }]),
    ).rejects.toThrow(/No combination/);
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
    // Two machines running one app, sharing nothing but the sandbox environment.
    const api = createFakeSandboxApi();

    for (const _machine of ["a", "b"]) {
      const { ci } = setup({ api });

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
      expect.stringMatching(/^ci\/pr:7\/setup\/[0-9a-f]+\/[0-9a-f]+$/),
    ]);
  });

  test.each([
    ["the same input again", ["1", "1"], 1],
    ["a different input", ["1", "2"], 2],
  ])("the same key with %s", async (_label, inputs, installs) => {
    const api = createFakeSandboxApi();

    for (const version of inputs) {
      const { ci } = setup({ api });

      const build = ci.job(
        { id: "setup", cache: { key: "v1" } },
        async ({ input }: { input: string }) => {
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
    // The second key replaced the first, which nothing can name again.
    expect(namedSnapshots(api)).toHaveLength(1);
  });

  test("a new key replaces the old entry of its own job and input, and no other", async () => {
    const api = createFakeSandboxApi();

    const runWithKey = async (key: string, targets: string[]) => {
      const { ci } = setup({ api });

      const build = ci.job(
        {
          id: "build",
          cache: { key },
          input: fakeSchema<{ target: string }>({ target: "string" }),
        },
        async () => {
          await $`pnpm build`;
        },
      );

      const lint = ci.job({ id: "lint", cache: { key } }, async () => {
        await $`pnpm lint`;
      });

      await runFunction(
        ci.pipeline({ id: "pr", on: prTrigger }, async () => {
          await Promise.all([
            ...targets.map((target) => {
              return build({ target });
            }),
            lint(),
          ]);
        }),
        { event: prEvent },
      );
    };

    await runWithKey("v1", ["web", "api"]);

    expect(namedSnapshots(api)).toHaveLength(3);

    // Only `web` is built under the new key.
    await runWithKey("v2", ["web"]);

    const jobsLeft = namedSnapshots(api).map((name) => {
      return name.split("/")[2];
    });

    // `web` and `lint` hold their v2 entries; `api` still has its v1.
    expect(jobsLeft.sort()).toEqual(["build", "build", "lint"]);
    expect(ran(api, "pnpm build")).toBe(3);
    expect(ran(api, "pnpm lint")).toBe(2);
  });

  test("a build never deletes a newer entry of its slot", async () => {
    const api = createFakeSandboxApi();

    const runWithKey = async (key: string) => {
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
    };

    await runWithKey("v1");

    // As if a build with another key finished after this one started.
    for (const snapshot of api.snapshots.values()) {
      snapshot.createdAt = new Date(Date.now() + 3_600_000).toISOString();
    }

    await runWithKey("v2");

    expect(namedSnapshots(api)).toHaveLength(2);
  });

  test("the same branch, job and key in another repository misses", async () => {
    // Two repositories sharing one Sandbox environment.
    const api = createFakeSandboxApi();

    const runIn = async (fullName: string) => {
      const { ci } = setup({ api });

      const job = ci.job({ id: "setup", cache: { key: "v1" } }, async () => {
        await $`pnpm install`;
      });

      const event = {
        ...prEvent,
        data: {
          ...prEvent.data,
          repository: { full_name: fullName },
          pull_request: {
            ...prEvent.data.pull_request,
            head: {
              ...prEvent.data.pull_request.head,
              repo: { full_name: fullName },
            },
          },
        },
      };

      const result = await runFunction(
        ci.pipeline({ id: "pr", on: prTrigger }, async () => {
          await job();
        }),
        { event },
      );

      expect(result.type).toBe("function-resolved");
    };

    await runIn("inngest/inngest-js");
    await runIn("inngest/inngest");

    expect(userCommands(api)).toHaveLength(2);
    expect(namedSnapshots(api)).toHaveLength(2);

    // The first repository still hits its own.
    await runIn("inngest/inngest-js");

    expect(userCommands(api)).toHaveLength(2);
  });

  test("the same repository, branch, job and key in another app misses", async () => {
    // Two apps in one repository and Sandbox environment.
    const api = createFakeSandboxApi();

    const runIn = async (appId: string) => {
      const { ci } = setup({ api, appId });

      const job = ci.job({ id: "setup", cache: { key: "v1" } }, async () => {
        await $`pnpm install`;
      });

      const result = await runFunction(
        ci.pipeline({ id: "pr", on: prTrigger }, async () => {
          await job();
        }),
        { event: prEvent },
      );

      expect(result.type).toBe("function-resolved");
    };

    await runIn("app-a");
    await runIn("app-b");

    expect(ran(api, "pnpm install")).toBe(2);
    expect(namedSnapshots(api)).toHaveLength(2);

    // Each app still hits its own.
    await runIn("app-a");
    await runIn("app-b");

    expect(ran(api, "pnpm install")).toBe(2);
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
    const [cached] = [...api.snapshots.values()];

    expect(
      [...api.sandboxes.values()].filter((machine) => {
        return machine.snapshotId;
      }),
    ).toEqual([expect.objectContaining({ snapshotId: cached?.id })]);
  });

  describe("a cached job below an uncached one", () => {
    /** `setup` is cached only when `cacheSetup`; `build` always has a cache. */
    const runChain = async (
      api: ReturnType<typeof createFakeSandboxApi>,
      options: { cacheSetup: boolean; runId: string; named?: string[] },
    ) => {
      const { ci } = setup({ api });

      const setupJob = ci.job(
        {
          id: "setup",
          ...(options.cacheSetup ? { cache: { key: "s" } } : {}),
        },
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

      const lint = ci.job({ id: "lint", from: buildJob }, async () => {
        await $`pnpm lint`;

        options.named?.push(...namedSnapshots(api));
      });

      const test = ci.job({ id: "test", from: buildJob }, async () => {
        await $`pnpm test`;
      });

      return runFunction(
        ci.pipeline({ id: "pr", on: prTrigger, childRuns: false }, async () => {
          await Promise.all([lint(), test()]);

          return getRunScope()?.warnings;
        }),
        { event: prEvent, runId: options.runId },
      );
    };

    const ran = (
      api: ReturnType<typeof createFakeSandboxApi>,
      text: string,
    ) => {
      return userCommands(api).filter((argv) => {
        return argv.join(" ").includes(text);
      }).length;
    };

    test("is never given a name, however many runs, and nothing is left behind", async () => {
      const duringRuns: string[] = [];

      const api = createFakeSandboxApi();

      for (const runId of ["01RUNA", "01RUNB", "01RUNC"]) {
        const result = await runChain(api, {
          cacheSetup: false,
          runId,
          named: duringRuns,
        });

        expect(result.type).toBe("function-resolved");

        // `build` was never cached, so nothing named for it is ever left, and
        // the run's own snapshots went with the run.
        expect(
          namedSnapshots(api).filter((name) => {
            return name.includes("/build/");
          }),
        ).toEqual([]);
        expect(api.snapshots.size).toBe(0);
      }

      // Nor was it named while the run used it, in the cache's scope or any
      // other: the name it had belongs to the run.
      expect(duringRuns.length).toBeGreaterThan(0);
      expect(
        duringRuns.filter((name) => {
          return name.startsWith("ci/pr:7/") || name.startsWith("ci/main/");
        }),
      ).toEqual([]);

      // It can't be reused, so it ran in every run.
      expect(ran(api, "pnpm build")).toBe(3);
      expect(ran(api, "pnpm install")).toBe(3);
    });

    test("called directly, it runs in the run without a name or a cache lookup", async () => {
      const api = createFakeSandboxApi();

      for (const runId of ["01RUNA", "01RUNB"]) {
        const { ci } = setup({ api });

        const setupJob = ci.job({ id: "setup" }, async () => {
          await $`pnpm install`;
        });

        const buildJob = ci.job(
          { id: "build", from: setupJob, cache: { key: "b" } },
          async () => {
            await $`pnpm build`;
          },
        );

        const result = await runFunction(
          ci.pipeline(
            { id: "pr", on: prTrigger, childRuns: false },
            async () => {
              await buildJob();

              return getRunScope()?.warnings;
            },
          ),
          { event: prEvent, runId },
        );

        expect(result.type).toBe("function-resolved");
        expect(result.data).toEqual([
          "never reused: `build` starts from `setup`, which has no `cache` (give `setup` a `cache`)",
        ]);
        expect(api.snapshots.size).toBe(0);
      }

      expect(ran(api, "pnpm build")).toBe(2);
    });

    test("still snapshots, so its children in the run start from it and it runs once", async () => {
      const api = createFakeSandboxApi();

      const result = await runChain(api, {
        cacheSetup: false,
        runId: "01RUNA",
      });

      expect(result.type).toBe("function-resolved");
      expect(ran(api, "pnpm build")).toBe(1);
      expect(ran(api, "pnpm lint")).toBe(1);
      expect(ran(api, "pnpm test")).toBe(1);

      const children = [...api.sandboxes.values()].filter((machine) => {
        return /^ci-01RUNA-(lint|test)$/.test(machine.name);
      });

      expect(children).toHaveLength(2);
      expect(new Set(children.map((machine) => machine.snapshotId)).size).toBe(
        1,
      );

      // They start from the snapshot taken of `build`'s machine, after it ran.
      const timeline = api.timeline.map((entry) => {
        return entry.startsWith("command ") ? entry : "snapshot";
      });

      const built = timeline.indexOf("command pnpm build");
      const lastSnapshotBeforeLint = timeline
        .slice(0, timeline.indexOf("command pnpm lint"))
        .lastIndexOf("snapshot");

      expect(built).toBeGreaterThan(-1);
      expect(lastSnapshotBeforeLint).toBeGreaterThan(built);
      expect(children.every((machine) => machine.snapshotId)).toBe(true);
    });

    test("says it rebuilds every run until the job above it has a cache", async () => {
      const api = createFakeSandboxApi();

      const result = await runChain(api, {
        cacheSetup: false,
        runId: "01RUNA",
      });

      expect(result.data).toEqual([
        "never reused: `build` starts from `setup`, which has no `cache` (give `setup` a `cache`)",
      ]);

      const cached = await runChain(createFakeSandboxApi(), {
        cacheSetup: true,
        runId: "01RUNA",
      });

      expect(cached.data).toEqual([]);
    });

    test("is cached and reused once the job above it has a cache", async () => {
      const api = createFakeSandboxApi();

      for (const runId of ["01RUNA", "01RUNB"]) {
        const result = await runChain(api, { cacheSetup: true, runId });

        expect(result.type).toBe("function-resolved");
      }

      expect(ran(api, "pnpm install")).toBe(1);
      expect(ran(api, "pnpm build")).toBe(1);

      expect(
        namedSnapshots(api).filter((name) => {
          return name.startsWith("ci/pr:7/build/");
        }),
      ).toHaveLength(1);
    });
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

    /** The snapshots `build` is cached under, oldest first. */
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
      const startsBefore = api.snapshotStarts.length;

      const key = change(api);

      await runWith(api, key);

      expect(ran(api, "pnpm install")).toBe(2);
      expect(ran(api, "pnpm build")).toBe(2);
      expect(ran(api, "pnpm test")).toBe(3);

      // `setup` has a new snapshot, so `build` has a new name: a miss found
      // by name alone. No machine started from the old snapshot to find out.
      const fresh = buildSnapshots(api).at(-1);

      expect(fresh?.name).not.toBe(old?.name);
      expect(api.snapshotStarts.slice(startsBefore)).not.toContain(old?.id);
      expect(api.snapshotStarts.at(-1)).toBe(fresh?.id);

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

    const lint = ci.job({ id: "lint", from: base }, async () => {
      await $`pnpm lint`;
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger, childRuns: false }, async () => {
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
        ci.pipeline({ id: "pr", on: prTrigger, childRuns: false }, async () => {
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

  describe("a snapshot that fails to start", () => {
    /**
     * `base` is cached and the children start from it. Runs on a shared fake
     * API, so a second call restores what the first built.
     */
    const runPipeline = async (
      api: ReturnType<typeof createFakeSandboxApi>,
      options: {
        event?: { name: string; data: unknown };
        on?: { event: string }[];
        children?: string[];
      } = {},
    ) => {
      const { ci } = setup({ api });

      const base = ci.job({ id: "base", cache: { key: "v1" } }, async () => {
        await $`pnpm install`;
      });

      const children = (options.children ?? ["lint"]).map((id) => {
        return ci.job({ id, from: base }, async () => {
          await $`pnpm ${id}`;
        });
      });

      const result = await runFunction(
        ci.pipeline(
          { id: "ci", on: options.on ?? prTrigger, childRuns: false },
          async () => {
            await Promise.all(
              children.map((child) => {
                return child();
              }),
            );

            return getRunScope()?.warnings;
          },
        ),
        { event: options.event ?? prEvent },
      );

      return result;
    };

    const deletesOf = (
      api: ReturnType<typeof createFakeSandboxApi>,
      snapshotId: string | undefined,
    ) => {
      return api.requests.filter((request) => {
        return request === `DELETE /v2/snapshots/${snapshotId}`;
      }).length;
    };

    const leftoverMachines = (api: ReturnType<typeof createFakeSandboxApi>) => {
      return [...api.sandboxes.values()].filter((machine) => {
        return machine.stuck && machine.status !== "TERMINATED";
      });
    };

    /** A cached `base` from a first run, ready to be restored by the next. */
    const built = async () => {
      const api = createFakeSandboxApi();

      expect((await runPipeline(api)).type).toBe("function-resolved");

      const [snapshot] = [...api.snapshots.values()];

      return { api, snapshot };
    };

    test("a capacity error that clears is retried as any step is, with nothing deleted or rebuilt", async () => {
      const { api, snapshot } = await built();

      api.failNextSnapshotStarts("capacity");

      const second = await runPipeline(api);

      expect(second.type).toBe("function-resolved");
      expect(second.data).toEqual([]);
      expect(deletesOf(api, snapshot?.id)).toBe(0);
      expect(api.snapshots.has(snapshot?.id ?? "")).toBe(true);
      expect(ran(api, "pnpm install")).toBe(1);
    });

    test("a capacity error that doesn't clear fails the job, and is not a start failure", async () => {
      const { api, snapshot } = await built();

      api.failNextSnapshotStarts("capacity", { count: 50 });

      const second = await runPipeline(api);

      expect(second.type).toBe("function-rejected");
      expect(deletesOf(api, snapshot?.id)).toBe(0);
      expect(api.snapshots.has(snapshot?.id ?? "")).toBe(true);
      expect(ran(api, "pnpm install")).toBe(1);

      // No second try at the snapshot: capacity is not the snapshot's fault.
      expect(second.stepIds.filter((id) => id.includes("restart"))).toEqual([]);
    });

    test.each([
      ["gone, as when a newer cache key replaced it", "gone"],
      ["deleting", "DELETING"],
    ] as const)(
      "a snapshot that is %s is rebuilt, not deleted",
      async (_label, then) => {
        const { api, snapshot } = await built();

        api.failNextSnapshotStarts("timeout", { then });

        const second = await runPipeline(api);

        expect(second.type).toBe("function-resolved");
        expect(second.data).toEqual([
          expect.stringContaining(
            "fell back: snapshot of `base` wouldn't start",
          ),
        ]);
        expect(deletesOf(api, snapshot?.id)).toBe(0);
        expect(ran(api, "pnpm install")).toBe(2);
        expect(ran(api, "pnpm lint")).toBe(2);

        // Rebuilt under the name, once nothing holds it. A snapshot that is
        // being deleted is on its way out and doesn't count.
        expect(
          [...api.snapshots.values()]
            .filter((candidate) => {
              return candidate.status === "READY";
            })
            .map((candidate) => {
              return candidate.name;
            }),
        ).toEqual([expect.stringMatching(/^ci\/pr:7\/base\//)]);
        expect(leftoverMachines(api)).toEqual([]);
      },
    );

    test("a snapshot still being created is rebuilt unnamed, leaving it alone", async () => {
      const { api, snapshot } = await built();

      api.failNextSnapshotStarts("timeout", { then: "CREATING" });

      const second = await runPipeline(api);

      expect(second.type).toBe("function-resolved");

      // Unnamed on purpose, so it didn't try for the name and give up on it.
      expect(second.data).toEqual([
        expect.stringContaining("fell back: snapshot of `base` wouldn't start"),
      ]);
      expect(deletesOf(api, snapshot?.id)).toBe(0);
      expect(ran(api, "pnpm install")).toBe(2);

      // The other build keeps the name. This run's copy had none, and was
      // deleted with the rest of the run's snapshots.
      expect([...api.snapshots.values()].map((s) => s.id)).toEqual([
        snapshot?.id,
      ]);

      expect(api.snapshotStarts.at(-1)).not.toBe(snapshot?.id);
    });

    test.each(["timeout", "failed"] as const)(
      "one %s is retried once, and the snapshot is kept",
      async (mode) => {
        const { api, snapshot } = await built();

        api.failNextSnapshotStarts(mode);

        const second = await runPipeline(api);

        expect(second.type).toBe("function-resolved");
        expect(second.data).toEqual([
          expect.stringContaining("snapshot of `base` needed a retry to start"),
        ]);

        // Restored on the second try; nothing deleted or rebuilt.
        expect(api.snapshotStarts.slice(-2)).toEqual([
          snapshot?.id,
          snapshot?.id,
        ]);
        expect(deletesOf(api, snapshot?.id)).toBe(0);
        expect(api.snapshots.has(snapshot?.id ?? "")).toBe(true);
        expect(ran(api, "pnpm install")).toBe(1);
        expect(ran(api, "pnpm lint")).toBe(2);
        expect(leftoverMachines(api)).toEqual([]);
      },
    );

    test("the retry waits at least as long for its machine as the first try did", async () => {
      const { api } = await built();

      api.failNextSnapshotStarts("timeout");

      const second = await runPipeline(api);

      expect(second.type).toBe("function-resolved");

      const waitOf = (stepId: string) => {
        const call = second.inputs[stepId] as {
          input: { input: { runningTimeoutMs?: number }[] }[];
        };

        return call.input[0]?.input[0]?.runningTimeoutMs;
      };

      const first = waitOf("lint › machine");

      // A shorter wait would make a slow node more likely to fail the retry,
      // and a second failure deletes the snapshot.
      expect(first).toBeGreaterThan(0);
      expect(waitOf("lint › machine › restart")).toBeGreaterThanOrEqual(
        first ?? 0,
      );
    });

    test("when the retry fails too, the snapshot is deleted and rebuilt", async () => {
      const { api, snapshot } = await built();

      api.failSnapshotStarts();

      const second = await runPipeline(api);

      expect(second.type).toBe("function-resolved");
      expect(second.data).toEqual([
        expect.stringContaining("fell back: snapshot of `base` wouldn't start"),
      ]);
      expect(deletesOf(api, snapshot?.id)).toBe(1);
      expect(api.snapshots.has(snapshot?.id ?? "")).toBe(false);
      expect(ran(api, "pnpm install")).toBe(2);
      expect(ran(api, "pnpm lint")).toBe(2);

      // The rebuild is cached under the freed name for the next run.
      expect(namedSnapshots(api)).toEqual([
        expect.stringMatching(/^ci\/pr:7\/base\//),
      ]);
      expect(leftoverMachines(api)).toEqual([]);
    });

    test("a snapshot that times out twice is rebuilt unnamed, and never deleted", async () => {
      const { api, snapshot } = await built();

      api.timeoutSnapshotStarts();

      const second = await runPipeline(api);

      expect(second.type).toBe("function-resolved");
      expect(deletesOf(api, snapshot?.id)).toBe(0);
      expect(api.snapshots.has(snapshot?.id ?? "")).toBe(true);
      expect(ran(api, "pnpm install")).toBe(2);
      expect(ran(api, "pnpm lint")).toBe(2);
      expect(leftoverMachines(api)).toEqual([]);
    });

    test("a launch failure fails the job and leaves the snapshot alone, whatever the number of tries", async () => {
      const { api, snapshot } = await built();

      api.failNextSnapshotStarts("launch", { count: 50 });

      const second = await runPipeline(api);

      expect(second.type).toBe("function-rejected");
      expect(deletesOf(api, snapshot?.id)).toBe(0);
      expect(api.snapshots.has(snapshot?.id ?? "")).toBe(true);
      expect(ran(api, "pnpm install")).toBe(1);

      // No second try at the snapshot: the launch is not the snapshot's fault.
      expect(second.stepIds.filter((id) => id.includes("restart"))).toEqual([]);
    });

    test("when the snapshot can't be deleted, the rebuild is unnamed and the broken one is never reused", async () => {
      const { api, snapshot } = await built();

      api.failSnapshotStarts();
      api.refuseSnapshotDeletes();
      const startsBefore = api.snapshotStarts.length;

      const second = await runPipeline(api);

      expect(second.type).toBe("function-resolved");
      expect(second.data).toEqual([
        expect.stringContaining("fell back: snapshot of `base` wouldn't start"),
        expect.stringContaining("couldn't be deleted"),
      ]);

      // The broken snapshot is still there and still holds the name, so the
      // rebuild has none, and the run deleted its copy at its end.
      expect(deletesOf(api, snapshot?.id)).toBe(1);
      expect([...api.snapshots.values()].map((s) => s.id)).toEqual([
        snapshot?.id,
      ]);
      expect(ran(api, "pnpm install")).toBe(2);
      expect(ran(api, "pnpm lint")).toBe(2);

      // Two tries at the broken snapshot, then only the rebuilt one.
      expect(
        api.snapshotStarts
          .slice(startsBefore)
          .filter((id) => id === snapshot?.id),
      ).toHaveLength(2);
    });

    test("a pull request run whose restore of main's snapshot times out once leaves it alone", async () => {
      const api = createFakeSandboxApi();

      const first = await runPipeline(api, {
        event: pushEvent,
        on: pushTrigger,
      });

      expect(first.type).toBe("function-resolved");

      const [main] = [...api.snapshots.values()];

      expect(main?.name).toMatch(/^ci\/main\/base\//);

      api.failNextSnapshotStarts("timeout");

      const pr = await runPipeline(api);

      expect(pr.type).toBe("function-resolved");
      expect(deletesOf(api, main?.id)).toBe(0);
      expect(namedSnapshots(api)).toEqual([main?.name]);
      expect(ran(api, "pnpm install")).toBe(1);
      expect(ran(api, "pnpm lint")).toBe(2);
    });

    test("several jobs on the same broken snapshot delete it once", async () => {
      const api = createFakeSandboxApi();

      expect(
        (await runPipeline(api, { children: ["lint", "test", "build"] })).type,
      ).toBe("function-resolved");

      const [snapshot] = [...api.snapshots.values()];

      api.failSnapshotStarts();

      const second = await runPipeline(api, {
        children: ["lint", "test", "build"],
      });

      expect(second.type).toBe("function-resolved");
      expect(deletesOf(api, snapshot?.id)).toBe(1);

      // One delete for all three, not one each that happens to find it gone.
      expect(
        second.stepIds.filter((id) => id.includes("cache:delete")),
      ).toHaveLength(1);

      // One rebuild for all three.
      expect(ran(api, "pnpm install")).toBe(2);
      expect(ran(api, "pnpm lint")).toBe(2);
      expect(ran(api, "pnpm test")).toBe(2);
      expect(ran(api, "pnpm build")).toBe(2);
      expect(leftoverMachines(api)).toEqual([]);
    });
  });

  test("a cached job's build uses the pipeline's machine", async () => {
    const { api, ci } = setup();

    const job = ci.job({ id: "big", cache: { key: "v1" } }, async () => {
      await $`pnpm build`;
    });

    const result = await runFunction(
      ci.pipeline(
        { id: "pr", on: prTrigger, machine: { vcpu: 4 } },
        async () => {
          await job();
        },
      ),
      { event: prEvent },
    );

    expect(result.type).toBe("function-resolved");

    expect(
      [...api.sandboxes.values()].map((box) => {
        return box.vcpu;
      }),
    ).toEqual([4]);
  });

  test("a cached job's input is validated once, however the build is run", async () => {
    const { ci } = setup();
    const received = new Set<unknown>();

    // Accepts a string and gives a number, so it rejects its own output.
    const input = {
      "~standard": {
        version: 1,
        vendor: "fake",
        validate: (value: unknown) => {
          return typeof value === "string"
            ? { value: Number(value) }
            : { issues: [{ message: "Expected string" }] };
        },
      },
    };

    const job = ci.job(
      { id: "num", input: input as never, cache: { key: "v1" } },
      async ({ input: value }) => {
        received.add(value);

        await $`pnpm build`;
      },
    );

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await (job as unknown as (value: string) => Promise<void>)("42");
      }),
      { event: prEvent },
    );

    expect(result.type).toBe("function-resolved");
    expect([...received]).toEqual([42]);
  });

  test("a cached job's summaries reach its own check", async () => {
    const { ci, reporter } = setup();

    const job = ci.job({ id: "cov", cache: { key: "v1" } }, async () => {
      await $`pnpm test`;
      await report.summary("Coverage: **91%**");
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await job();
      }),
      { event: prEvent },
    );

    expect(result.type).toBe("function-resolved");

    const completed = reporter.history.find((entry) => {
      return entry.name === "pr / cov" && entry.status === "completed";
    });

    expect(completed?.summary).toContain("Coverage: **91%**");
  });

  test("when the rebuilt snapshot won't start either, the job falls back to a fresh machine", async () => {
    const api = createFakeSandboxApi();

    const run = async () => {
      const { ci } = setup({ api });

      const base = ci.job({ id: "base", cache: { key: "v1" } }, async () => {
        await $`pnpm install`;
      });

      const lint = ci.job({ id: "lint", from: base }, async () => {
        await $`pnpm lint`;
      });

      return runFunction(
        ci.pipeline({ id: "pr", on: prTrigger }, async () => {
          await lint();
        }),
        { event: prEvent },
      );
    };

    await run();

    api.failAllSnapshotStarts();

    const second = await run();

    expect(second.type).toBe("function-resolved");
    expect(ran(api, "pnpm lint")).toBe(2);

    expect(
      [...api.sandboxes.values()].filter((machine) => {
        return machine.stuck && machine.status !== "TERMINATED";
      }),
    ).toEqual([]);
  });

  test("after a snapshot won't start, concurrent commands all wait for the parent to re-run", async () => {
    const api = createFakeSandboxApi();

    const run = async () => {
      const { ci } = setup({ api });

      const base = ci.job({ id: "base", cache: { key: "v1" } }, async () => {
        await $`pnpm install`;
        await $`pnpm build`;
      });

      const check = ci.job({ id: "check", from: base }, async () => {
        await Promise.all([$`pnpm lint`, $`pnpm test`]);
      });

      const result = await runFunction(
        ci.pipeline({ id: "pr", on: prTrigger }, async () => {
          await check();
        }),
        { event: prEvent },
      );

      expect(result.type).toBe("function-resolved");
    };

    await run();

    api.failSnapshotStarts();

    const before = userCommands(api).length;

    await run();

    const commands = userCommands(api)
      .slice(before)
      .map((command) => {
        return command.join(" ");
      });

    expect(commands.slice(0, 2)).toEqual(["pnpm install", "pnpm build"]);
    expect(new Set(commands.slice(2))).toEqual(
      new Set(["pnpm lint", "pnpm test"]),
    );
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
          { event: prEvent, runId: `01RUN${i}` },
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
      conclusion: "skipped",
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
        title: "❌ boom (exit 1)",
      }),
      expect.objectContaining({ name: "pr", conclusion: "failure" }),
    ]);
  });

  test.each([
    ["passes", 0],
    ["fails", 1],
  ] as const)(
    "a job that %s destroys its machines before it is reported, not when the run ends",
    async (_label, exitCode) => {
      const { api, ci } = setup();

      api.script([{ match: "pnpm test", exitCode }]);

      const test = ci.job("test", async () => {
        const extra = await sandbox("extra");

        await extra.$`pnpm extra`;
        await $`pnpm test`;
      });

      const pipeline = ci.pipeline(
        { id: "pr", on: prTrigger, childRuns: false },
        async () => {
          return test();
        },
      );

      const result = await runFunction(pipeline, { event: prEvent });

      const at = (id: string) => {
        return result.stepIds.indexOf(id);
      };

      expect(at("test › destroy")).toBeGreaterThan(-1);
      expect(at("test › extra › destroy")).toBeGreaterThan(-1);
      expect(at("test › destroy")).toBeLessThan(
        at("github › check:test:complete"),
      );
      expect(at("test › destroy")).toBeLessThan(at("pipeline › cleanup"));

      expect(
        [...api.sandboxes.values()].map((machine) => {
          return machine.status;
        }),
      ).toEqual(["TERMINATED", "TERMINATED"]);
    },
  );

  test.each([false, true])(
    "a job that fails with a retryable error destroys its machine and is not retried (childRuns: %s)",
    async (childRuns) => {
      const { api, ci } = setup();

      const flaky = ci.job("flaky", async () => {
        await $`pnpm setup`;

        throw new Error("flaky infrastructure");
      });

      const pipeline = ci.pipeline(
        { id: "pr", on: prTrigger, retries: 2, childRuns },
        async () => {
          await flaky();
        },
      );

      const result = await runFunction(pipeline, {
        event: prEvent,
        retries: 2,
        maxRequests: 400,
      });

      expect(result.type).toBe("function-rejected");
      expect(result.error).toMatchObject({ name: "NonRetriableError" });

      expect(
        [...api.sandboxes.values()].map((machine) => {
          return machine.status;
        }),
      ).toEqual(["TERMINATED"]);
    },
  );

  test("a job's failure title is one short line", async () => {
    const { ci, reporter } = setup();

    const build = ci.job("build", async () => {
      await $`pnpm build`;

      throw new NonRetriableError(
        "Sandbox did not reach RUNNING within 120000 milliseconds\nmore detail",
      );
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return build();
    });

    await runFunction(pipeline, { event: prEvent });

    const failed = reporter.history.find((entry) => {
      return entry.status === "completed" && entry.name === "pr / build";
    });

    expect(failed).toMatchObject({
      conclusion: "failure",
      title: "❌ machine didn't start in 2m",
    });
  });

  test("a cached child of a parent called with an input hits again, and misses when that input changes", async () => {
    const api = createFakeSandboxApi();

    const runWith = async (version: string) => {
      const { ci } = setup({ api });

      const parent = ci.job(
        { id: "setup", cache: { key: "p" } },
        async ({ input }: { input: { version: string } }) => {
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
        async (_ctx: { input: { version: string } }) => {
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
    expect(restored?.title).toMatch(/^⚡ Cache hit, built (just now|.+ ago)$/);
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

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, childRuns: false },
      async () => {
        return job();
      },
    );

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

    expect(completed?.title).toMatch(/^✅ Passed in (\d+m )?\d+s$/);
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
    expect(result.steps["pipeline › cleanup"]).toEqual({
      destroyed: 0,
      lockReleased: false,
    });
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
    ).resolves.toEqual({ destroyed: 0, lockReleased: false });

    await expect(
      destroyOrphans(
        page(async () => {
          throw new Error("503 service unavailable");
        }),
        "run1",
      ),
    ).rejects.toThrow("503");
  });

  test("a lock machine that can't be asked who owns it fails the step to retry", async () => {
    const client = {
      sandboxes: {
        list: async () => {
          return {
            items: [
              {
                name: "ci-lock",
                status: "RUNNING",
                destroy: async () => {},
                commands: {
                  run: async () => {
                    throw new Error("503 service unavailable");
                  },
                },
              },
            ],
          };
        },
      },
      // biome-ignore lint/suspicious/noExplicitAny: a partial client is enough here
    } as any;

    await expect(destroyOrphans(client, "run1", "ci-lock")).rejects.toThrow(
      "503",
    );
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

    const compat = ci.job(
      { id: "compat", matrix: { axes: { node: ["20", "22"] } } },
      async ({ matrix: { node } }) => {
        await $`pnpm test --node ${node}`;
      },
    );

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, childRuns: false },
      async () => {
        return compat();
      },
    );

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
      ["pr / build", "failure", "❌ machine didn't start in 2m"],
      [
        "pr",
        "failure",
        "❌ 1 of 1 job failed: build: machine didn't start in 2m",
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

describe("commit statuses", () => {
  test("a failing job's status says why it failed", async () => {
    vi.stubEnv("INNGEST_CI_GITHUB", "live");

    try {
      const { api, ci, gh } = setupGitHub();

      gh.route("POST /repos/inngest/inngest-js/statuses/abc1234", {});

      api.script([
        {
          match: "pnpm test",
          exitCode: 1,
          stderr: "warming up\nENOTFOUND localhost\n",
        },
      ]);

      const test = ci.job("test", async () => {
        await $`pnpm test`;
      });

      const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        return test();
      });

      await runFunction(pipeline, { event: prEvent });

      const descriptions = gh.requests.map((request) => {
        return (request.body as { description: string }).description;
      });

      expect(descriptions).toContain("❌ ENOTFOUND localhost (exit 1)");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the pipeline's commit status", () => {
  test("ends with how many jobs failed", async () => {
    vi.stubEnv("INNGEST_CI_GITHUB", "live");

    try {
      const { api, ci, gh } = setupGitHub();

      gh.route("POST /repos/inngest/inngest-js/statuses/abc1234", {});

      api.script([{ match: "pnpm lint", exitCode: 1, stderr: "Error: bad\n" }]);

      const lint = ci.job("lint", async () => {
        await $`pnpm lint`;
      });

      const test = ci.job("test", async () => {
        await $`pnpm test`;
      });

      const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        const results = await Promise.allSettled([lint(), test()]);
        const errors = results.flatMap((result) => {
          return result.status === "rejected" ? [result.reason] : [];
        });

        if (errors.length > 0) {
          throw new AggregateError(errors, "jobs failed");
        }
      });

      await runFunction(pipeline, { event: prEvent });

      const statuses = gh.requests
        .map((request) => {
          return request.body as {
            context: string;
            state: string;
            description: string;
          };
        })
        .filter((status) => {
          return status.context === "pr";
        });

      expect(statuses.at(0)).toMatchObject({ state: "pending" });
      expect(statuses.at(-1)).toMatchObject({
        state: "failure",
        description: "❌ 1 of 2 jobs failed: lint: Error: bad (exit 1)",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a handler that resolves is a success, however many jobs failed", async () => {
    vi.stubEnv("INNGEST_CI_GITHUB", "live");

    try {
      const { api, ci, gh } = setupGitHub();

      gh.route("POST /repos/inngest/inngest-js/statuses/abc1234", {});

      api.script([{ match: "pnpm lint", exitCode: 1, stderr: "Error: bad\n" }]);

      const lint = ci.job("lint", async () => {
        await $`pnpm lint`;
      });

      const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await Promise.allSettled([lint()]);
      });

      const result = await runFunction(pipeline, { event: prEvent });

      expect(result.type).toBe("function-resolved");

      const statuses = gh.requests
        .map((request) => {
          return request.body as { context: string; state: string };
        })
        .filter((status) => {
          return status.context === "pr";
        });

      expect(statuses.at(-1)).toMatchObject({ state: "success" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the lifecycle of a check", () => {
  const statusesOf = (
    gh: ReturnType<typeof setupGitHub>["gh"],
    context: string,
  ) => {
    return gh.requests
      .filter((request) => {
        return (
          (request.body as { context?: string } | undefined)?.context ===
          context
        );
      })
      .map((request) => {
        const status = request.body as { state: string; description: string };

        return [status.state, status.description];
      });
  };

  test("statuses go from queued to running to the result", async () => {
    vi.stubEnv("INNGEST_CI_GITHUB", "live");

    try {
      const { ci, gh } = setupGitHub("statuses");

      gh.route("POST /repos/inngest/inngest-js/statuses/abc1234", {});

      const lint = ci.job("lint", async () => {
        await $`pnpm lint`;
      });

      const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await lint();
      });

      await runFunction(pipeline, { event: prEvent });

      const lifecycle = statusesOf(gh, "pr / lint");

      expect(lifecycle.slice(0, 2)).toEqual([
        ["pending", "Queued"],
        ["pending", "Running"],
      ]);

      expect(lifecycle.at(-1)?.[0]).toBe("success");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("every matrix combination is queued before any starts", async () => {
    vi.stubEnv("INNGEST_CI_GITHUB", "live");

    try {
      const { ci, gh } = setupGitHub("statuses");

      gh.route("POST /repos/inngest/inngest-js/statuses/abc1234", {});

      const compat = ci.job(
        {
          id: "compat",
          matrix: { axes: { node: ["20", "22"] }, concurrency: 1 },
        },
        async () => {},
      );

      const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await compat();
      });

      await runFunction(pipeline, { event: prEvent });

      const posts = gh.requests.map((request) => {
        const status = request.body as { context: string; description: string };

        return `${status.context}: ${status.description}`;
      });

      const firstRunning = posts.findIndex((post) => {
        return post.startsWith("pr / compat") && post.endsWith("Running");
      });

      const queued = posts.filter((post) => {
        return post.startsWith("pr / compat") && post.endsWith("Queued");
      });

      expect(queued).toHaveLength(2);
      expect(
        posts.slice(0, firstRunning).filter((post) => {
          return post.endsWith("Queued");
        }),
      ).toHaveLength(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("checks go from queued to in progress to completed", async () => {
    vi.stubEnv("INNGEST_CI_GITHUB", "live");

    try {
      const { ci, gh } = setupGitHub("checks");
      const made: Array<{ id: number; name: string; external_id: string }> = [];

      gh.handle("POST /repos/inngest/inngest-js/check-runs", (request) => {
        const body = request.body as { name: string; external_id: string };
        const created = { id: made.length + 1, ...body };

        made.push(created);

        return { body: created };
      });

      gh.handle(
        "GET /repos/inngest/inngest-js/commits/abc1234/check-runs",
        () => {
          return { body: { total_count: made.length, check_runs: made } };
        },
      );

      gh.route("PATCH /repos/inngest/inngest-js/check-runs/*", {});

      const lint = ci.job("lint", async () => {
        await $`pnpm lint`;
      });

      const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await lint();
      });

      await runFunction(pipeline, { event: prEvent });

      const lintId = made.find((check) => {
        return check.name === "pr / lint";
      })?.id;

      const states = gh.requests
        .filter((request) => {
          const body = request.body as
            | { name?: string; status?: string }
            | undefined;

          return (
            request.method !== "GET" &&
            body?.status !== undefined &&
            (body.name === "pr / lint" ||
              request.path.endsWith(`/check-runs/${lintId}`))
          );
        })
        .map((request) => {
          const body = request.body as { status: string; conclusion?: string };

          return [request.method, body.status, body.conclusion];
        });

      expect(states).toEqual([
        ["POST", "queued", undefined],
        ["PATCH", "in_progress", undefined],
        ["PATCH", "completed", "success"],
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a pipeline that skips ends as skipped", async () => {
    const { ci, reporter } = setup();

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return ci.skip("nothing changed");
    });

    await runFunction(pipeline, { event: prEvent });

    expect(reporter.history.at(-1)).toMatchObject({ conclusion: "skipped" });
  });
});

describe("how long a pipeline took", () => {
  test("the title is the clock time, not the sum of the jobs' times", async () => {
    const { ci, reporter } = setup();

    const jobs = ["a", "b", "c"].map((id) => {
      return ci.job(id, async () => {
        await $`pnpm ${id}`;
      });
    });

    await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await Promise.all(
          jobs.map((job) => {
            return job();
          }),
        );
      }),
      { event: prEvent },
    );

    const done = reporter.history.find((entry) => {
      return entry.name === "pr" && entry.status === "completed";
    });

    expect(done?.title).toMatch(/^✅ Passed: 3 jobs in \d+(ms|s)$/);
    expect(done?.summary).toMatch(
      /^> \[!NOTE\]\n> ✅ \*\*3 jobs passed\*\* in \*\*\d+(ms|s)\*\*/,
    );
  });
});

describe("what the cache saved", () => {
  test("a job that starts from a reused snapshot says how long it took to build", async () => {
    const api = createFakeSandboxApi();

    const run = async () => {
      const { ci, reporter } = setup({ api });

      const base = ci.job({ id: "base", cache: { key: "v1" } }, async () => {
        await $`pnpm install`;
      });

      const test = ci.job({ id: "test", from: base }, async () => {
        await $`pnpm test`;
      });

      const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await test();
      });

      await runFunction(pipeline, { event: prEvent });

      return reporter.history.filter((entry) => {
        return entry.name === "pr" && entry.status === "completed";
      });
    };

    // Every clock read is a second later than the last, so the build takes time.
    const realNow = Date.now.bind(Date);
    let reads = 0;

    vi.spyOn(Date, "now").mockImplementation(() => {
      reads += 1;

      return realNow() + reads * 1000;
    });

    const first = await run().finally(() => {
      vi.mocked(Date.now).mockRestore();
    });

    expect(first[0]?.title).not.toContain("saved");

    const second = await run();

    expect(second[0]?.title).toMatch(/ · ⚡ \d+s saved by cache$/);
    expect(second[0]?.summary).toContain("| `base` |");
  });
});

describe("a job's status while it runs in its own run", () => {
  test("links to the pipeline run, so a cancel of that run can find it", async () => {
    vi.stubEnv("INNGEST_CI_GITHUB", "live");

    try {
      const { ci, gh } = setupGitHub("statuses");

      gh.route("POST /repos/inngest/inngest-js/statuses/abc1234", {});

      const lint = ci.job("lint", async () => {
        await $`pnpm lint`;
      });

      await runFunction(
        ci.pipeline({ id: "pr", on: prTrigger }, async () => {
          await lint();
        }),
        { event: prEvent },
      );

      const own = gh.requests
        .map((request) => {
          return request.body as { description: string; target_url: string };
        })
        .filter((status) => {
          return status.description === "Running in its own run";
        });

      expect(own).toHaveLength(1);
      expect(own[0]?.target_url).toContain("01TESTRUN");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("a cancelled pipeline's job runs", () => {
  test("the build function ends its runs when the pipeline run that called them is cancelled", () => {
    const { ci } = setup();

    const build = ci.functions().find((fn) => {
      return fn.opts.id === "ci/build";
    });

    const cancelOn = (
      build?.opts as {
        cancelOn?: Array<{ event: string; if?: string }>;
      }
    )?.cancelOn;

    expect(cancelOn).toContainEqual({
      event: "inngest/function.cancelled",
      if: "async.data.run_id == event.data.rootRunId",
    });
  });
});

describe("what a check shows", () => {
  const checksSetup = () => {
    const { api, ci, gh } = setupGitHub("checks");
    const made: Array<{ id: number; name: string; external_id: string }> = [];

    gh.handle("POST /repos/inngest/inngest-js/check-runs", (request) => {
      const body = request.body as { name: string; external_id: string };
      const created = { id: made.length + 1, ...body };

      made.push(created);

      return { body: created };
    });

    gh.handle(
      "GET /repos/inngest/inngest-js/commits/abc1234/check-runs",
      () => {
        return { body: { total_count: made.length, check_runs: made } };
      },
    );

    gh.route("GET /repos/inngest/inngest-js/check-runs/*", {
      output: { summary: "before" },
    });

    gh.route("PATCH /repos/inngest/inngest-js/check-runs/*", {});

    return { api, ci, gh };
  };

  const patches = (gh: ReturnType<typeof setupGitHub>["gh"]) => {
    return gh.requests
      .filter((request) => {
        return request.method === "PATCH";
      })
      .map((request) => {
        return request.body as {
          actions?: Array<{ identifier: string }>;
          output?: {
            title?: string;
            summary?: string;
            annotations?: unknown[];
          };
        };
      });
  };

  test("Cancel stays on a check while its job runs in its own run", async () => {
    vi.stubEnv("INNGEST_CI_GITHUB", "live");

    try {
      const { ci, gh } = checksSetup();

      const lint = ci.job("lint", async () => {
        await $`pnpm lint`;
      });

      await runFunction(
        ci.pipeline({ id: "pr", on: prTrigger }, async () => {
          await lint();
        }),
        { event: prEvent },
      );

      const building = patches(gh).filter((body) => {
        return body.output?.title === "Running in its own run";
      });

      expect(building).toHaveLength(1);
      expect(building[0]?.actions?.map((action) => action.identifier)).toEqual([
        "cancel",
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("annotations past the first 50 are steps of their own", async () => {
    vi.stubEnv("INNGEST_CI_GITHUB", "live");

    try {
      const { ci, gh } = checksSetup();

      const lint = ci.job("lint", async () => {
        await report.annotate(
          Array.from({ length: 120 }, (_, index) => {
            return { path: "a.ts", line: index + 1, message: "boom" };
          }),
        );

        await $`pnpm lint`;
      });

      const result = await runFunction(
        ci.pipeline({ id: "pr", on: prTrigger }, async () => {
          await lint();
        }),
        { event: prEvent },
      );

      const sizes = patches(gh)
        .filter((body) => {
          return body.output?.annotations !== undefined;
        })
        .map((body) => {
          return body.output?.annotations?.length;
        });

      expect(sizes).toEqual([50, 50, 20]);

      expect(
        result.stepIds.filter((id) => {
          return id.includes("annotations");
        }),
      ).toEqual([
        "github › check:lint:annotations:2",
        "github › check:lint:annotations:3",
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("a log that holds a code fence is shown in a longer one", async () => {
    vi.stubEnv("INNGEST_CI_GITHUB", "live");

    try {
      const { api, ci, gh } = checksSetup();

      api.script([
        {
          match: "pnpm lint",
          exitCode: 1,
          stderr: "Error: see\n```ts\ncode\n```\n",
        },
      ]);

      const lint = ci.job("lint", async () => {
        await $`pnpm lint`;
      });

      await runFunction(
        ci.pipeline({ id: "pr", on: prTrigger }, async () => {
          await lint();
        }),
        { event: prEvent },
      );

      const summaries = patches(gh).map((body) => {
        return body.output?.summary ?? "";
      });

      expect(
        summaries.some((summary) => {
          return summary.includes("````");
        }),
      ).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("re-running one job", () => {
  const rerunEvent = (ci: Record<string, unknown>) => {
    return { ...prEvent, data: { ...prEvent.data, _ci: ci } };
  };

  test("a job that's skipped gives back something to read from", async () => {
    const { ci } = setup();

    let read: unknown = "unset";

    const first = ci.job("first", async () => {
      await $`pnpm first`;

      return { target: "x" };
    });

    const second = ci.job("second", async () => {
      await $`pnpm second`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      const result = (await first()) as { target?: string };

      read = result.target;

      await second();
    });

    const result = await runFunction(pipeline, {
      event: rerunEvent({ job: "second", pipeline: "pr" }),
    });

    expect(result.type).toBe("function-resolved");
    expect(read).toBeUndefined();
  });

  test("another pipeline on the same trigger does nothing, and reports nothing", async () => {
    const { ci, reporter } = setup();

    const pipeline = ci.pipeline({ id: "lint", on: prTrigger }, async () => {});

    const result = await runFunction(pipeline, {
      event: rerunEvent({ job: "test", pipeline: "pr" }),
    });

    expect(result.data).toEqual({ skipped: "another pipeline's re-run" });
    expect(reporter.history).toHaveLength(0);
  });

  test("a re-run without the cache builds a cached job defined in the pipeline again", async () => {
    const api = createFakeSandboxApi();

    const run = async (event: typeof prEvent) => {
      const { ci } = setup({ api });

      return runFunction(
        ci.pipeline({ id: "pr", on: prTrigger }, async () => {
          const install = ci.job(
            { id: "install", cache: { key: "v1" } },
            async () => {
              await $`pnpm install`;
            },
          );

          await install();
        }),
        { event },
      );
    };

    await run(prEvent);
    await run(prEvent);

    expect(userCommands(api)).toHaveLength(1);

    const fresh = await run(rerunEvent({ noCache: true, pipeline: "pr" }));

    expect(fresh.type).toBe("function-resolved");
    expect(userCommands(api)).toHaveLength(2);
  });
});

describe("the Cancel button", () => {
  const click = async (
    checkName: string,
    permission: string,
  ): Promise<string[]> => {
    vi.stubEnv("INNGEST_CI_GITHUB", "live");

    try {
      const { ci, gh } = setupGitHub("checks");

      gh.route(
        "GET /repos/inngest/inngest-js/collaborators/octocat/permission",
        {
          permission,
        },
      );

      ci.pipeline({ id: "pr", on: prTrigger }, async () => {});

      const fn = ci.functions().find((candidate) => {
        return candidate.opts.id === "pr/check-rerequested";
      });

      if (!fn) {
        throw new Error("no check-rerequested function");
      }

      const result = await runFunction(fn, {
        event: {
          name: "github/check_run.requested_action",
          data: {
            action: "requested_action",
            requested_action: { identifier: "cancel" },
            sender: { login: "octocat" },
            check_run: {
              name: checkName,
              external_id: "01RUN:lint",
              head_sha: "abc1234",
            },
            repository: { full_name: "inngest/inngest-js" },
          },
        },
      });

      return result.stepIds;
    } finally {
      vi.unstubAllEnvs();
    }
  };

  test("sends the cancel event for a check of the pipeline, from someone who can write", async () => {
    expect(await click("pr / lint", "write")).toContain("cancel");
  });

  test.each([
    ["someone who can only read", "pr / lint", "read"],
    ["another pipeline's check", "other / lint", "write"],
  ])("does nothing for %s", async (_who, name, permission) => {
    expect(await click(name, permission)).not.toContain("cancel");
  });

  test("a pipeline's runs end on the cancel event", () => {
    const { ci } = setup();

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {});

    const [cancel] =
      (pipeline.opts as { cancelOn?: Array<{ event: string; if: string }> })
        .cancelOn ?? [];

    expect(cancel?.event).toBe("ci/run.cancel");

    // A fork can have the same commit, so the repository is part of the match.
    expect(cancel?.if).toContain(
      "async.data.repo == event.data.repository.full_name",
    );
  });

  test("waiting and running checks carry the button, and finishing takes it away", async () => {
    vi.stubEnv("INNGEST_CI_GITHUB", "live");

    try {
      const { ci, gh } = setupGitHub("checks");
      const made: Array<{ id: number; name: string; external_id: string }> = [];

      gh.handle("POST /repos/inngest/inngest-js/check-runs", (request) => {
        const body = request.body as { name: string; external_id: string };
        const created = { id: made.length + 1, ...body };

        made.push(created);

        return { body: created };
      });

      gh.handle(
        "GET /repos/inngest/inngest-js/commits/abc1234/check-runs",
        () => {
          return { body: { total_count: made.length, check_runs: made } };
        },
      );

      gh.route("PATCH /repos/inngest/inngest-js/check-runs/*", {});

      const lint = ci.job("lint", async () => {
        await $`pnpm lint`;
      });

      await runFunction(
        ci.pipeline({ id: "pr", on: prTrigger }, async () => {
          await lint();
        }),
        { event: prEvent },
      );

      const actionsOf = (status: string) => {
        return gh.requests
          .filter((request) => {
            return (
              request.method !== "GET" &&
              (request.body as { status?: string }).status === status
            );
          })
          .map((request) => {
            return (request.body as { actions?: Array<{ identifier: string }> })
              .actions;
          });
      };

      for (const actions of [
        ...actionsOf("queued"),
        ...actionsOf("in_progress"),
      ]) {
        expect(actions?.map((action) => action.identifier)).toEqual(["cancel"]);
      }

      for (const actions of actionsOf("completed")) {
        expect(actions).toEqual([]);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("re-running from a check", () => {
  const rerunEvent = (ci: Record<string, unknown>) => {
    return { ...prEvent, data: { ...prEvent.data, _ci: ci } };
  };

  const commandsRun = (api: ReturnType<typeof createFakeSandboxApi>) => {
    return userCommands(api).map((argv) => {
      return argv.join(" ");
    });
  };

  test("a job's re-run runs that job alone", async () => {
    const { api, ci } = setup();

    const lint = ci.job("lint", async () => {
      await $`pnpm lint`;
    });

    const test = ci.job("test", async () => {
      await $`pnpm test`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await Promise.all([lint(), test()]);
    });

    const result = await runFunction(pipeline, {
      event: rerunEvent({ job: "test" }),
    });

    expect(result.type).toBe("function-resolved");
    expect(commandsRun(api)).toEqual(["pnpm test"]);
  });

  test("a re-run without the cache builds a cached job again", async () => {
    const api = createFakeSandboxApi();

    const run = async (event: typeof prEvent) => {
      const { ci } = setup({ api });

      const base = ci.job({ id: "base", cache: { key: "v1" } }, async () => {
        await $`pnpm install`;
      });

      const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await base();
      });

      return runFunction(pipeline, { event });
    };

    await run(prEvent);
    await run(prEvent);

    expect(commandsRun(api)).toEqual(["pnpm install"]);

    const fresh = await run(rerunEvent({ noCache: true }));

    expect(fresh.type).toBe("function-resolved");
    expect(commandsRun(api)).toEqual(["pnpm install", "pnpm install"]);
  });

  test("a failed check offers a re-run without the cache", async () => {
    vi.stubEnv("INNGEST_CI_GITHUB", "live");

    try {
      const { api, ci, gh } = setupGitHub("checks");
      const made: Array<{ id: number; name: string; external_id: string }> = [];

      gh.handle("POST /repos/inngest/inngest-js/check-runs", (request) => {
        const body = request.body as { name: string; external_id: string };
        const created = { id: made.length + 1, ...body };

        made.push(created);

        return { body: created };
      });

      gh.handle(
        "GET /repos/inngest/inngest-js/commits/abc1234/check-runs",
        () => {
          return { body: { total_count: made.length, check_runs: made } };
        },
      );

      gh.route("PATCH /repos/inngest/inngest-js/check-runs/*", {});

      api.script([{ match: "pnpm lint", exitCode: 1, stderr: "Error: bad\n" }]);

      const lint = ci.job("lint", async () => {
        await $`pnpm lint`;
      });

      await runFunction(
        ci.pipeline({ id: "pr", on: prTrigger }, async () => {
          await lint();
        }),
        { event: prEvent },
      );

      const completed = gh.requests.filter((request) => {
        return (
          request.method === "PATCH" &&
          (request.body as { conclusion?: string }).conclusion === "failure"
        );
      });

      expect(completed.length).toBeGreaterThan(0);

      const noCache = {
        label: "Re-run, no cache",
        description: "Run again from scratch",
        identifier: "rerun-fresh",
      };

      for (const request of completed) {
        const body = request.body as {
          name: string;
          actions: Array<{ identifier: string }>;
        };

        expect(body.actions.at(-1)).toEqual(noCache);
        expect(body.actions.map((action) => action.identifier)).toEqual(
          body.name === "pr" ? ["rerun-all", "rerun-fresh"] : ["rerun-fresh"],
        );
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("closing what a cancelled run left open", () => {
  const cancelFor = async (
    reporter: "checks" | "statuses",
    seed: (gh: ReturnType<typeof setupGitHub>["gh"]) => void,
  ) => {
    vi.stubEnv("INNGEST_CI_GITHUB", "live");

    try {
      const { ci, gh } = setupGitHub(reporter);

      seed(gh);

      ci.pipeline({ id: "pr", on: prTrigger }, async () => {});

      const cleanup = ci.functions().find((fn) => {
        return fn.opts.id === "pr/cleanup";
      });

      if (!cleanup) {
        throw new Error("no cleanup function");
      }

      await runFunction(cleanup, {
        event: {
          name: "inngest/function.cancelled",
          data: { run_id: "01TESTRUN", event: prEvent },
        },
      });

      return gh.requests;
    } finally {
      vi.unstubAllEnvs();
    }
  };

  test("check runs that are still queued are closed as well as running ones", async () => {
    const requests = await cancelFor("checks", (gh) => {
      gh.handle(
        "GET /repos/inngest/inngest-js/commits/abc1234/check-runs",
        (request) => {
          return {
            body: {
              total_count: 1,
              check_runs:
                request.query.status === "queued"
                  ? [
                      {
                        id: 8,
                        name: "pr / test",
                        external_id: "01TESTRUN:test",
                      },
                    ]
                  : [],
            },
          };
        },
      );

      gh.route("PATCH /repos/inngest/inngest-js/check-runs/8", { id: 8 });
    });

    expect(
      requests.filter((request) => {
        return request.method === "PATCH";
      }),
    ).toHaveLength(1);
  });

  test("statuses past the first page are closed too", async () => {
    const url = "http://localhost:8288/run?runID=01TESTRUN";

    const requests = await cancelFor("statuses", (gh) => {
      gh.route("POST /repos/inngest/inngest-js/statuses/abc1234", {});

      gh.handle(
        "GET /repos/inngest/inngest-js/commits/abc1234/status",
        (request) => {
          return {
            body: {
              statuses:
                request.query.page === "2"
                  ? [
                      {
                        context: "pr / late",
                        state: "pending",
                        target_url: url,
                      },
                    ]
                  : Array.from({ length: 100 }, (_, index) => {
                      return {
                        context: `other ${index}`,
                        state: "success",
                        target_url: "http://elsewhere",
                      };
                    }),
            },
          };
        },
      );
    });

    expect(
      requests
        .filter((request) => {
          return request.method === "POST";
        })
        .map((request) => {
          return (request.body as { context: string }).context;
        }),
    ).toEqual(["pr / late"]);
  });
});

describe("a cancelled run's checks", () => {
  const cancelWith = async (
    reporter: "checks" | "statuses",
    eventName: string,
    seed: (gh: ReturnType<typeof setupGitHub>["gh"]) => void,
  ) => {
    vi.stubEnv("INNGEST_CI_GITHUB", "live");

    try {
      const { ci, gh } = setupGitHub(reporter);

      seed(gh);

      ci.pipeline({ id: "pr", on: prTrigger }, async () => {});

      const cleanup = ci.functions().find((fn) => {
        return fn.opts.id === "pr/cleanup";
      });

      if (!cleanup) {
        throw new Error("no cleanup function");
      }

      const ended = await runFunction(cleanup, {
        event: {
          name: eventName,
          data: { run_id: "01TESTRUN", event: prEvent },
        },
      });

      expect(ended.type).toBe("function-resolved");

      return gh.requests.filter((request) => {
        return request.method !== "GET";
      });
    } finally {
      vi.unstubAllEnvs();
    }
  };

  const url = (runId: string) => {
    return `http://localhost:8288/run?runID=${runId}`;
  };

  test.each([
    ["cancelled", "inngest/function.cancelled", ["pr", "pr / lint"]],
    ["failed", "inngest/function.failed", []],
  ])("statuses of a run that was %s", async (_how, eventName, expected) => {
    const posts = await cancelWith("statuses", eventName, (gh) => {
      gh.route("POST /repos/inngest/inngest-js/statuses/abc1234", {});

      gh.route("GET /repos/inngest/inngest-js/commits/abc1234/status", {
        statuses: [
          { context: "pr", state: "pending", target_url: url("01TESTRUN") },
          {
            context: "pr / lint",
            state: "pending",
            target_url: url("01TESTRUN"),
          },
          {
            context: "pr / test",
            state: "success",
            target_url: url("01TESTRUN"),
          },
          { context: "other", state: "pending", target_url: url("01OTHER") },
        ],
      });
    });

    expect(
      posts.map((request) => {
        const status = request.body as { context: string; description: string };

        expect(status.description).toBe("Cancelled");

        return status.context;
      }),
    ).toEqual(expected);
  });

  test("check runs of a cancelled run, jobs included, are completed as cancelled", async () => {
    const posts = await cancelWith(
      "checks",
      "inngest/function.cancelled",
      (gh) => {
        gh.route("GET /repos/inngest/inngest-js/commits/abc1234/check-runs", {
          total_count: 3,
          check_runs: [
            { id: 1, name: "pr", external_id: "01TESTRUN:pipeline" },
            { id: 2, name: "pr / lint", external_id: "01TESTRUN:lint" },
            { id: 3, name: "other", external_id: "01OTHER:pipeline" },
          ],
        });

        gh.route("PATCH /repos/inngest/inngest-js/check-runs/1", { id: 1 });
        gh.route("PATCH /repos/inngest/inngest-js/check-runs/2", { id: 2 });
      },
    );

    expect(
      posts.map((request) => {
        return [
          request.path,
          (request.body as { conclusion: string }).conclusion,
        ];
      }),
    ).toEqual([
      [expect.stringContaining("/check-runs/1"), "cancelled"],
      [expect.stringContaining("/check-runs/2"), "cancelled"],
    ]);
  });
});

describe("a cancelled run's pipeline check", () => {
  test("says what finished, what was stopped and what never started, and offers a re-run", async () => {
    vi.stubEnv("INNGEST_CI_GITHUB", "live");

    try {
      const { ci, gh } = setupGitHub("checks");

      gh.route("GET /repos/inngest/inngest-js/commits/abc1234/check-runs", {
        total_count: 4,
        check_runs: [
          {
            id: 1,
            name: "pr",
            external_id: "01TESTRUN:pipeline",
            status: "in_progress",
            started_at: "2026-10-21T09:12:00Z",
            details_url: "http://localhost:8288/run?runID=01TESTRUN",
          },
          {
            id: 2,
            name: "pr / lint",
            external_id: "01TESTRUN:lint",
            status: "completed",
            conclusion: "success",
            started_at: "2026-10-21T09:12:01Z",
            completed_at: "2026-10-21T09:12:31Z",
          },
          {
            id: 3,
            name: "pr / test",
            external_id: "01TESTRUN:test",
            status: "in_progress",
            started_at: "2026-10-21T09:12:02Z",
          },
          {
            id: 4,
            name: "pr / e2e",
            external_id: "01TESTRUN:e2e",
            status: "queued",
          },
        ],
      });

      gh.route("PATCH /repos/inngest/inngest-js/check-runs/1", { id: 1 });
      gh.route("PATCH /repos/inngest/inngest-js/check-runs/3", { id: 3 });
      gh.route("PATCH /repos/inngest/inngest-js/check-runs/4", { id: 4 });

      ci.pipeline({ id: "pr", on: prTrigger }, async () => {});

      const cleanup = ci.functions().find((fn) => {
        return fn.opts.id === "pr/cleanup";
      });

      if (!cleanup) {
        throw new Error("no cleanup function");
      }

      await runFunction(cleanup, {
        event: {
          name: "inngest/function.cancelled",
          data: { run_id: "01TESTRUN", event: prEvent },
        },
      });

      const patched = (id: number) => {
        return gh.requests.find((request) => {
          return (
            request.method === "PATCH" &&
            request.path.endsWith(`/check-runs/${id}`)
          );
        })?.body as {
          conclusion: string;
          actions: Array<{ identifier: string }>;
          output: { title: string; summary: string };
        };
      };

      const pipeline = patched(1);

      expect(pipeline.conclusion).toBe("cancelled");
      expect(pipeline.output.title).toMatch(
        /^🛑 Cancelled after .+: 1 passed, 2 not finished$/,
      );
      expect(pipeline.output.summary).toContain("> [!NOTE]");
      expect(pipeline.output.summary).toContain(
        "✅ 1 passed · 🛑 1 stopped mid-run · ⬜ 1 never started",
      );
      expect(pipeline.actions.map((action) => action.identifier)).toEqual([
        "rerun-all",
      ]);

      // The finished job's check is left alone; the others are cancelled.
      expect(patched(2)).toBeUndefined();
      expect(patched(3).output.summary).toContain("**Cancelled**");
      expect(patched(4).output.title).toBe("🛑 Cancelled");
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

      const test = ci.job("test", async () => {
        await $`pnpm test`;
      });

      const pipeline = ci.pipeline(
        { id: "pr", on: prTrigger, childRuns: false, retries: 1 },
        async (ctx) => {
          await test();

          if (ctx.attempt === 0) {
            throw new Error("flaky infrastructure");
          }
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
    const lint = ci.job({ id: "lint", from: base }, async () => {
      await $`pnpm lint`;
    });

    return ci.pipeline(
      { id: "pr", on: prTrigger, childRuns: false },
      async () => {
        return lint();
      },
    );
  };

  /** A pipeline that calls the cached job itself, so it has a check. */
  const directPipeline = (
    ci: ReturnType<typeof setup>["ci"],
    base: ReturnType<typeof buildJob>,
  ) => {
    return ci.pipeline(
      { id: "pr", on: prTrigger, childRuns: false },
      async () => {
        return base();
      },
    );
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
    expect(machines[0]?.name).toMatch(/^ci-build-[0-9a-f]{32}$/);

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
    ).toMatch(/^✅ Passed in /);
  });

  test("a hit builds nothing", async () => {
    const api = createFakeSandboxApi();

    for (let i = 0; i < 2; i++) {
      const { ci } = setup({ api });

      await runFunction(childPipeline(ci, buildJob(ci)), { event: prEvent });
    }

    expect(installs(api)).toBe(1);
  });

  test("two pipelines needing the same key end on one named snapshot", async () => {
    const api = createFakeSandboxApi();

    // Two runs of one app, against one sandbox environment.
    const { ci } = setup({ api });
    const base = buildJob(ci);

    const first = childPipeline(ci, base);
    const second = ci.pipeline(
      { id: "push", on: prTrigger, childRuns: false },
      async () => {
        return base();
      },
    );

    const [a, b] = await Promise.all([
      runFunction(first, { event: prEvent, runId: "01RUNA" }),
      runFunction(second, { event: prEvent, runId: "01RUNB" }),
    ]);

    expect(a.type).toBe("function-resolved");
    expect(b.type).toBe("function-resolved");

    // Runs that miss together may each build, so what is fixed is that one
    // snapshot kept the name and the child that started from it got it.
    const [snapshot, ...others] = [...api.snapshots.values()].filter(
      (candidate) => {
        return candidate.name;
      },
    );

    expect(others).toEqual([]);
    expect(snapshot?.status).toBe("READY");

    const child = [...api.sandboxes.values()].find((machine) => {
      return machine.name === "ci-01RUNA-lint";
    });

    expect(child?.snapshotId).toBe(snapshot?.id);
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
          /localhost:8288\/run\?runID=01(TESTINVOKED|BUILD)\d+/.test(line)
        );
      }),
    ).toBe(true);
  });

  test("one build function serves every job and matrix, however many there are", () => {
    const { ci } = setup();

    ci.job("plain", async () => {});

    ci.job({ id: "cached", cache: { key: "v1" } }, async () => {});

    ci.job(
      { id: "compat", matrix: { axes: { node: ["20", "22"] } } },
      async () => {},
    );

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

  test("a cached job another app asks for, which starts from an uncached job, is built", async () => {
    const { ci } = setup();

    const base = ci.job("base", async () => {
      await $`pnpm install`;
    });

    ci.job({ id: "leaf", cache: { key: "v1" }, from: base }, async () => {
      await $`pnpm lint`;
    });

    const build = ci.functions().find((fn) => {
      return fn.opts.id === "ci/build";
    });

    const result = await runFunction(build as NonNullable<typeof build>, {
      event: {
        name: "inngest/function.invoked",
        data: {
          jobId: "leaf",
          ownKey: "",
          cacheKey: "leaf",
          askedByApp: true,
          rootRunId: "01ROOT",
          parent: {
            runId: "01ROOT",
            pipelineId: "pr",
            jobPath: "leaf",
            trigger: "manual",
          },
        },
      },
    });

    expect(result.type).toBe("function-resolved");
  });

  test("a cached matrix combination is built by its matrix's function", async () => {
    const { api, ci } = setup();

    const compat = ci.job(
      {
        id: "compat",
        matrix: { axes: { node: ["20", "22"] } },
        cache: { key: "m1" },
      },
      async ({ matrix: { node } }) => {
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

  test("snapshots are deleted when completing the pipeline check fails on the last attempt", async () => {
    const { api, ci, reporter } = setup();

    // The first check started is the pipeline's; completing it always fails.
    const push = reporter.history.push.bind(reporter.history);

    reporter.history.push = (...records) => {
      for (const record of records) {
        if (
          record.status === "completed" &&
          record.name === reporter.history[0]?.name
        ) {
          throw new Error("GitHub is down");
        }
      }

      return push(...records);
    };

    const base = ci.job("base", async () => {
      await $`pnpm install`;
    });

    const child = ci.job({ id: "child", from: base }, async () => {
      await $`pnpm test`;
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

  test.each([
    ["cancelled", "inngest/function.cancelled"],
    ["failed or ran out of steps", "inngest/function.failed"],
  ])(
    "a run that was %s without reaching its cleanup has its snapshots deleted",
    async (_how, eventName) => {
      const { api, client, ci } = setup();
      const leftBehind = new Map<string, FakeSnapshot>();

      const base = ci.job("base", async () => {
        await $`pnpm install`;
      });

      const child = ci.job({ id: "child", from: base }, async () => {
        await $`pnpm build`;

        for (const snapshot of api.snapshots.values()) {
          leftBehind.set(snapshot.id, snapshot);
        }
      });

      const result = await runFunction(
        ci.pipeline({ id: "pr", on: prTrigger }, async () => {
          await child();
        }),
        { event: prEvent },
      );

      expect(result.type).toBe("function-resolved");
      expect(leftBehind.size).toBe(1);

      // What the run would have left had it stopped before its cleanup, beside
      // another run's snapshot and a cache entry, which are not its to delete.
      const [owned] = [...leftBehind.values()];

      for (const snapshot of [
        ...leftBehind.values(),
        {
          ...owned,
          id: "00000000-0000-4000-8000-0000000000aa",
          name: "ci/run:01OTHER/base/k",
        },
        {
          ...owned,
          id: "00000000-0000-4000-8000-0000000000bb",
          name: "ci/pr:7/setup/s/k",
        },
      ] as FakeSnapshot[]) {
        api.snapshots.set(snapshot.id, snapshot);
      }

      expect(api.snapshots.size).toBe(3);

      const ended = await runFunction(
        cleanupFunction({ client, config: { id: "pr" } }),
        { event: { name: eventName, data: { run_id: "01TESTRUN" } } },
      );

      expect(ended.error).toBeUndefined();
      expect(ended.type).toBe("function-resolved");
      expect(namedSnapshots(api).sort()).toEqual([
        "ci/pr:7/setup/s/k",
        "ci/run:01OTHER/base/k",
      ]);
    },
  );

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

  test("a build run hands up its run-only snapshots, including a cached job's below an uncached one", async () => {
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
    // `base`'s was taken in the build run and handed up, so the pipeline
    // deletes it. `cached` is below an uncached job, so its snapshot is run-only
    // too, rather than a named cache snapshot nothing could ever find again.
    expect(namedSnapshots(api)).toEqual([]);
    expect(api.snapshots.size).toBe(0);
    expect(deletedBy(result)).toHaveLength(2);
  });

  test("a build run doesn't delete the named snapshot it built", async () => {
    const api = createFakeSandboxApi();
    const { ci } = setup({ api });

    let namedDuringRun: string[] = [];

    const base = ci.job({ id: "base", cache: { key: "v1" } }, async () => {
      await $`pnpm install`;
    });

    const lint = ci.job({ id: "lint", from: base }, async () => {
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

  test("a build run's unnamed fallback is left for the invoking run to delete", async () => {
    const api = createFakeSandboxApi();

    api.withoutSnapshotNames();

    const { ci } = setup({ api });

    let duringRun = 0;

    const base = ci.job({ id: "base", cache: { key: "v1" } }, async () => {
      await $`pnpm install`;
    });

    const lint = ci.job({ id: "lint", from: base }, async () => {
      await $`pnpm lint`;

      duringRun = Math.max(duringRun, api.snapshots.size);
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return lint();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    // The build run's own cleanup left it, so `lint` could start from it.
    expect(duringRun).toBe(1);
    expect(api.snapshots.size).toBe(0);
    expect(cleanupSteps(result.stepIds)).toHaveLength(1);
  });

  test.each([
    ["1h", 1],
    [0, 0],
  ])(
    "a keepOnFailure of %j leaves %d kept snapshots on the failing run",
    async (keepOnFailure, kept) => {
      const { api, ci } = setup();

      const base = ci.job("base", async () => {
        await $`pnpm install`;
      });

      const child = ci.job(
        { id: "child", from: base, keepOnFailure },
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
      // `base`'s snapshot is deleted, a kept one of `child` stays.
      expect(api.snapshots.size).toBe(kept);
    },
  );

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
      expect.any(String),
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
