/**
 * Tests of the trace spans CI groups its steps under, and what it names them:
 * one span per job, and in it one per machine, one per command, and one per
 * attempt for a command with retries, with GitHub check updates in a span of
 * their own. Spans and names never change a step's ID. A failed run of a
 * command ends in a failing step, so its span shows the failure. CI's own
 * work carries CI's origin, and what you wrote carries none.
 *
 * @module
 */

import { version as sdkVersion, step } from "inngest";
import { describe, expect, test } from "vitest";
import { CommandFailedError } from "../errors.ts";
import { consoleReporter } from "../github/auth.ts";
import { createCi } from "../pipeline/createCi.ts";
import { ciOrigin } from "../pipeline/names.ts";
import { createCiTestClient } from "../testing/client.ts";
import { prEvent } from "../testing/events.ts";
import type { CommandScript, FakeSandboxApi } from "../testing/fakeSandbox.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import { version } from "../version.ts";
import { $ } from "./command.ts";
import { sandbox } from "./sandbox.ts";

type Ci = ReturnType<typeof createCi>;

interface TraceNode {
  label: string;
  children: Map<string, TraceNode>;
}

/**
 * Draw a run's trace as an indented tree, the way the UI nests it: each span
 * once, where its first step is, with its kind in brackets, and each step
 * under its spans.
 */
const drawTrace = (
  result: Awaited<ReturnType<typeof runFunction>>,
  /** Suffix each row with who it says did it, as in `Create sandbox <- ci`. */
  withOrigins = false,
): string => {
  const root: TraceNode = { label: "", children: new Map() };

  const by = (origin: string | undefined) => {
    if (!withOrigins || !origin) {
      return "";
    }

    const names: Record<string, string> = {
      [ciOrigin]: "ci",
      [`inngest@${sdkVersion}`]: "inngest",
    };

    return ` <- ${names[origin] ?? origin}`;
  };

  for (const stepId of result.stepIds) {
    let node = root;

    for (const span of result.spans[stepId] ?? []) {
      const key = `span:${span.id}`;
      const label = span.kind ? `${span.name} [${span.kind}]` : span.name;

      const child = node.children.get(key) ?? {
        label: `${label}${by(span.origin)}`,
        children: new Map(),
      };

      node.children.set(key, child);

      node = child;
    }

    node.children.set(`step:${stepId}`, {
      label: `${result.names[stepId] ?? stepId}${by(result.origins[stepId])}`,
      children: new Map(),
    });
  }

  const lines: string[] = [];

  const draw = (node: TraceNode, depth: number) => {
    for (const child of node.children.values()) {
      lines.push(`${"  ".repeat(depth)}${child.label}`);

      draw(child, depth + 1);
    }
  };

  draw(root, 0);

  return lines.join("\n");
};

/** Run the pipeline whose handler `define` makes from a fresh client. */
const runPipeline = async (
  define: (ci: Ci) => () => Promise<unknown>,
  scripts: CommandScript[] = [],
  api: FakeSandboxApi = createFakeSandboxApi(),
) => {
  api.script(scripts);

  const ci = createCi(createCiTestClient(api), {
    github: consoleReporter(),
  });

  const pipeline = ci.pipeline(
    { id: "pr", on: [{ event: "github/pull_request.opened" }] },
    define(ci),
  );

  return runFunction(pipeline, { event: prEvent });
};

/** Run a job with a captured, a managed, a retried and a background command. */
const run = () => {
  return runPipeline(
    (ci) => {
      return ci.job("test", async () => {
        await $`quick`.timeout("30s");

        await $`slow`;

        try {
          await $`flaky`.retries(1);
        } catch {
          // Both attempts fail.
        }

        const server = await $`serve`.background();

        await server.output();

        await server.exited();

        await server.kill();
      });
    },
    [
      { match: "slow", ticks: 1, stdout: "done" },
      { match: "flaky", exitCode: 1 },
      { match: "serve", ticks: 1, stdout: "listening" },
    ],
  );
};

/**
 * A pipeline with a row of every sort: a job started from another, plain and
 * labelled commands, a step of your own and an extra sandbox.
 */
const rowsPipeline = (ci: Ci) => {
  const base = ci.job(
    { id: "base", name: "Install dependencies" },
    async () => {
      await $`pnpm install`;
    },
  );

  return ci.job({ id: "test", from: base }, async () => {
    await $`pnpm test`;

    await $`pnpm exec eslint .`.as("lint");

    await step.run("my-step", () => {
      return "done";
    });

    const api = await sandbox("api");

    await api.$`pnpm start`.timeout("30s");
  });
};

/** The span of a command `test` ran. */
const command = (label: string) => {
  return { id: `test › ${label}`, name: `$ ${label}` };
};

const origin = ciOrigin;
const github = [{ id: "github", name: "GitHub", origin }];
const job = { id: "test", name: "test", kind: "job" };
const machine = [job, { id: "test › machine", name: "Start sandbox", origin }];
const quick = [job, command("quick")];
const slow = [job, command("slow")];
const attempt1 = [
  job,
  command("flaky"),
  { id: "attempt-1", name: "Attempt 1", origin },
];
const attempt2 = [
  job,
  command("flaky"),
  { id: "attempt-2", name: "Attempt 2", origin },
];
const serve = [job, command("serve")];

describe("spans", () => {
  test("group each job, machine, command and retried attempt", async () => {
    const result = await run();

    expect(result.type).toBe("function-resolved");

    // Background calls re-enter their command's span. Check updates are in
    // the run's GitHub span, and cleanup is in none.
    expect(result.spans).toEqual({
      "github › check:pr:start": github,
      "github › check:test:start": github,
      "test › machine": machine,
      "test › machine › setup": machine,
      "test › quick": quick,
      "test › slow › start": slow,
      "test › slow › wait #1": slow,
      "test › slow › check #1": slow,
      "test › slow › wait #2": slow,
      "test › slow › check #2": slow,
      "test › slow › output": slow,
      "test › flaky #attempt-1 › start": attempt1,
      "test › flaky #attempt-1 › wait #1": attempt1,
      "test › flaky #attempt-1 › check #1": attempt1,
      "test › flaky #attempt-1 › output": attempt1,
      "test › flaky #attempt-1 › exit": attempt1,
      "github › check:test:attempt:1": github,
      "test › flaky #attempt-2 › start": attempt2,
      "test › flaky #attempt-2 › wait #1": attempt2,
      "test › flaky #attempt-2 › check #1": attempt2,
      "test › flaky #attempt-2 › output": attempt2,
      "test › flaky #attempt-2 › exit": attempt2,
      "test › serve › start": serve,
      "test › serve › output #1": serve,
      "test › serve › wait #2": serve,
      "test › serve › check #2": serve,
      "test › serve › wait #3": serve,
      "test › serve › check #3": serve,
      "test › serve › output": serve,
      "test › serve › kill": serve,
      "github › check:test:complete": github,
      "github › check:jobs:complete": github,
      "github › check:pr:complete": github,
    });
  });

  test("leave step IDs and their order as they were, plus one per failed run", async () => {
    const result = await run();

    expect(result.stepIds).toEqual([
      "github › check:pr:start",
      "github › check:test:start",
      "test › machine",
      "test › machine › setup",
      "test › quick",
      "test › slow › start",
      "test › slow › wait #1",
      "test › slow › check #1",
      "test › slow › wait #2",
      "test › slow › check #2",
      "test › slow › output",
      "test › flaky #attempt-1 › start",
      "test › flaky #attempt-1 › wait #1",
      "test › flaky #attempt-1 › check #1",
      "test › flaky #attempt-1 › output",
      "test › flaky #attempt-1 › exit",
      "github › check:test:attempt:1",
      "test › flaky #attempt-2 › start",
      "test › flaky #attempt-2 › wait #1",
      "test › flaky #attempt-2 › check #1",
      "test › flaky #attempt-2 › output",
      "test › flaky #attempt-2 › exit",
      "test › serve › start",
      "test › serve › output #1",
      "test › serve › wait #2",
      "test › serve › check #2",
      "test › serve › wait #3",
      "test › serve › check #3",
      "test › serve › output",
      "test › serve › kill",
      "github › check:test:complete",
      "github › check:jobs:complete",
      "github › check:pr:complete",
      "pipeline › cleanup",
      "pipeline › cleanup:snapshots",
    ]);
  });

  test("name each step for what it does, not for what its spans show", async () => {
    const result = await run();

    expect(result.names).toMatchObject({
      "github › check:pr:start": "Create check: pr",
      "github › check:test:start": "Report test: started",
      "test › machine": "Create sandbox",
      "test › machine › setup": "Prepare workspace",
      "test › quick": "Run and read output",
      "test › slow › start": "Start process",
      "test › slow › wait #1": "Wait 1s",
      "test › slow › check #1": "Poll process",
      "test › slow › wait #2": "Wait 2s",
      "test › slow › output": "Read output",
      "github › check:test:attempt:1": "Report test: retrying (attempt 2 of 2)",
      "test › serve › output #1": "Read output",
      "test › serve › kill": "Stop process",
      "github › check:test:complete": "Report test: passed",
      "github › check:jobs:complete": "Report jobs: ended with the run",
      "github › check:pr:complete": "Complete check: pr",
      "pipeline › cleanup": "Clean up sandboxes",
    });
  });

  test("end a failed run's span in a failing step named for its exit", async () => {
    const result = await run();

    const attempt1Steps = result.stepIds.filter((id) => {
      return id.startsWith("test › flaky #attempt-1");
    });

    expect(attempt1Steps.at(-1)).toBe("test › flaky #attempt-1 › exit");

    expect(result.spans["test › flaky #attempt-1 › exit"]).toEqual(attempt1);

    expect(result.names["test › flaky #attempt-1 › exit"]).toBe(
      "Exited with code 1",
    );

    expect(result.steps["test › flaky #attempt-1 › exit"]).toMatchObject({
      name: "NonRetriableError",
      message: "exit 1",
    });
  });

  test("record nothing more for a passing or `.nothrow()` command", async () => {
    const result = await runPipeline(
      (ci) => {
        return ci.job("test", async () => {
          await $`pass`;

          await $`fail`.nothrow();
        });
      },
      [{ match: "fail", exitCode: 1 }],
    );

    expect(result.type).toBe("function-resolved");

    expect(result.stepIds).toEqual([
      "github › check:pr:start",
      "github › check:test:start",
      "test › machine",
      "test › machine › setup",
      "test › pass › start",
      "test › pass › wait #1",
      "test › pass › check #1",
      "test › pass › output",
      "test › fail › start",
      "test › fail › wait #1",
      "test › fail › check #1",
      "test › fail › output",
      "github › check:test:complete",
      "github › check:jobs:complete",
      "github › check:pr:complete",
      "pipeline › cleanup",
      "pipeline › cleanup:snapshots",
    ]);
  });

  test("still retry after a failed run, and throw the same error at the end", async () => {
    let caught: unknown;

    const result = await runPipeline(
      (ci) => {
        return ci.job("test", async () => {
          try {
            await $`flaky`.retries(1);
          } catch (error) {
            caught = error;
          }
        });
      },
      [{ match: "flaky", exitCode: 1, stdout: "out", stderr: "flake" }],
    );

    expect(result.type).toBe("function-resolved");

    expect(result.stepIds).toContain("test › flaky #attempt-2 › exit");

    expect(caught).toBeInstanceOf(CommandFailedError);

    expect(caught).toMatchObject({
      message: "`flaky` exited with 1\nflake",
      command: ["flaky"],
      exitCode: 1,
      stdoutTail: "out",
      stderrTail: "flake",
      jobPath: "test",
    });
  });

  test("keep the build of a parent outside every job's span", async () => {
    const result = await runPipeline((ci) => {
      const base = ci.job("base", async () => {
        await $`install`;
      });

      return ci.job({ id: "test", from: base }, async () => {
        await $`unit`;
      });
    });

    expect(result.type).toBe("function-resolved");

    const jobOf = Object.fromEntries(
      Object.entries(result.spans).map(([stepId, spans]) => {
        return [stepId, spans[0]?.id];
      }),
    );

    // `base` runs in a run of its own, so the pipeline has only the steps that
    // look it up and invoke it, outside any job whichever child asks first.
    // Check updates are in the GitHub span.
    expect(result.stepIds).toContain("base (from) › lookup");
    expect(result.stepIds).toContain("base (from) › build");
    expect(jobOf).toEqual({
      "github › check:pr:start": "github",
      "github › check:test:start": "github",
      "test › machine": "test",
      "test › machine › setup": "test",
      "test › unit › start": "test",
      "test › unit › wait #1": "test",
      "test › unit › check #1": "test",
      "test › unit › output": "test",
      "github › check:test:complete": "github",
      "github › check:jobs:complete": "github",
      "github › check:pr:complete": "github",
    });
  });

  test("name a pipeline's rows for what they are", async () => {
    const result = await runPipeline(rowsPipeline);

    expect(result.type).toBe("function-resolved");

    expect(drawTrace(result)).toBe(
      [
        "GitHub",
        "  Create check: pr",
        "  Report test: started",
        "  Report test: passed",
        "  Report jobs: ended with the run",
        "  Complete check: pr",
        "Look up cache",
        "Build base in its own run",
        "test [job]",
        "  Start sandbox from base",
        "    Create sandbox",
        "    Prepare workspace",
        "  $ pnpm test",
        "    Start process",
        "    Wait 1s",
        "    Poll process",
        "    Read output",
        "  lint",
        "    Start process",
        "    Wait 1s",
        "    Poll process",
        "    Read output",
        "  my-step",
        "  api",
        "    Start sandbox",
        "      Create sandbox",
        "      Prepare workspace",
        "    $ pnpm start",
        "      Run and read output",
        "Clean up sandboxes",
        "Clean up snapshots",
      ].join("\n"),
    );
  });

  test("mark the work CI does for you, and nothing you wrote", async () => {
    const result = await runPipeline(rowsPipeline);

    expect(result.type).toBe("function-resolved");

    expect(ciOrigin).toBe(`@inngest/ci@${version}`);

    // Jobs, commands, `my-step` and the `api` sandbox are yours. `snapshot()`
    // opens its span without an origin, so it inherits the one of the CI span
    // it runs in, while its own steps are marked by the SDK.
    expect(drawTrace(result, true)).toBe(
      [
        "GitHub <- ci",
        "  Create check: pr <- ci",
        "  Report test: started <- ci",
        "  Report test: passed <- ci",
        "  Report jobs: ended with the run <- ci",
        "  Complete check: pr <- ci",
        "Look up cache <- ci",
        "Build base in its own run <- ci",
        "test [job]",
        "  Start sandbox from base <- ci",
        "    Create sandbox <- ci",
        "    Prepare workspace <- ci",
        "  $ pnpm test",
        "    Start process <- ci",
        "    Wait 1s <- ci",
        "    Poll process <- ci",
        "    Read output <- ci",
        "  lint",
        "    Start process <- ci",
        "    Wait 1s <- ci",
        "    Poll process <- ci",
        "    Read output <- ci",
        "  my-step",
        "  api",
        "    Start sandbox <- ci",
        "      Create sandbox <- ci",
        "      Prepare workspace <- ci",
        "    $ pnpm start",
        "      Run and read output <- ci",
        "Clean up sandboxes <- ci",
        "Clean up snapshots <- ci",
      ].join("\n"),
    );
  });

  test("mark every step a command runs, through retries and background calls", async () => {
    const result = await run();

    expect(result.type).toBe("function-resolved");

    // The job only runs commands, so every step in it is CI's.
    for (const stepId of result.stepIds) {
      expect(result.origins[stepId]).toBe(ciOrigin);
    }
  });

  test("ask for a parent's snapshot again, as a build of its own, when it won't start", async () => {
    const api = createFakeSandboxApi();
    const { fetch } = api;
    let broken = false;

    // Break the snapshot as soon as it's taken, before `test` starts from it.
    api.fetch = (input, init) => {
      if (!broken && api.snapshots.size > 0) {
        broken = true;

        api.failSnapshotStarts();
      }

      return fetch(input, init);
    };

    const result = await runPipeline(
      (ci) => {
        const parent = ci.job("base", async () => {
          await $`pnpm install`;
        });

        return ci.job({ id: "test", from: parent }, async () => {
          await $`pnpm test`;
        });
      },
      [],
      api,
    );

    expect(result.type).toBe("function-resolved");

    const builds = result.stepIds.filter((id) => {
      return id.endsWith("› build");
    });

    expect(builds).toEqual([
      "base (from) › build",
      "base (from) (rebuild) › build",
    ]);

    // Neither is in a job's span.
    for (const id of builds) {
      expect(result.spans[id]?.[0]).toBeUndefined();
    }
  });
});
