/**
 * Tests of the trace spans CI groups its steps under, and what it names them:
 * one span per job, and in it one per machine, one per command, and one per
 * attempt for a command with retries, with GitHub check updates in a span of
 * their own. Every span has a kind, and a statement on a background process
 * is a row of its own. Spans and names never change a step's ID. A failed run
 * of a command ends in a failing step, so its span shows the failure. CI's
 * own work carries CI's origin, and what you wrote carries none.
 *
 * @module
 */

import { step } from "inngest";
import { describe, expect, test } from "vitest";
import { CommandFailedError } from "../errors.ts";
import { ciOrigin } from "../pipeline/names.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import type { Ci } from "../testing/harness.ts";
import { ciTest, drawTrace } from "../testing/harness.ts";
import { version } from "../version.ts";
import { $ } from "./command.ts";
import { sandbox } from "./sandbox.ts";

/** Run a job with a captured, a managed, a retried and a background command. */
const run = () => {
  return ciTest({
    scripts: [
      { match: "slow", ticks: 1, stdout: "done" },
      { match: "flaky", exitCode: 1 },
      { match: "serve", ticks: 1, stdout: "listening" },
    ],
  }).run((ci) => {
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
  });
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

const origin = ciOrigin;
const span = (id: string, name: string, kind: string) => {
  return { id, name, kind };
};
const github = [{ ...span("github", "GitHub", "github"), origin }];
const job = span("test", "test", "job");
const machine = [
  job,
  { ...span("test › machine", "Start sandbox", "sandbox"), origin },
];
const command = (label: string) => {
  return [job, span(`test › ${label}`, `$ ${label}`, "command")];
};
const attempt = (n: number) => {
  return [
    ...command("flaky"),
    { ...span(`attempt-${n}`, `Attempt ${n}`, "attempt"), origin },
  ];
};

/** A statement on the background `serve`, a row of its own beside the command's. */
const statement = (suffix: string, label: string) => {
  return [
    job,
    span(`test › serve › ${suffix}`, `$ serve (${label})`, "command"),
  ];
};

describe("spans", () => {
  test("group each job, machine, command and retried attempt, each with its kind", async () => {
    const result = await run();

    expect(result.type).toBe("function-resolved");

    // Each statement on a background process is a span of its own. Check
    // updates are in the run's GitHub span, and cleanup is in none.
    expect(result.spans).toEqual({
      "github › check:pr:start": github,
      "github › check:test:start": github,
      "test › machine": machine,
      "test › machine › setup": machine,
      "test › quick": command("quick"),
      "test › slow › start": command("slow"),
      "test › slow › wait #1": command("slow"),
      "test › slow › check #1": command("slow"),
      "test › slow › wait #2": command("slow"),
      "test › slow › check #2": command("slow"),
      "test › slow › output": command("slow"),
      "test › flaky #attempt-1 › start": attempt(1),
      "test › flaky #attempt-1 › wait #1": attempt(1),
      "test › flaky #attempt-1 › check #1": attempt(1),
      "test › flaky #attempt-1 › output": attempt(1),
      "test › flaky #attempt-1 › exit": attempt(1),
      "github › check:test:attempt:1": github,
      "test › flaky #attempt-2 › start": attempt(2),
      "test › flaky #attempt-2 › wait #1": attempt(2),
      "test › flaky #attempt-2 › check #1": attempt(2),
      "test › flaky #attempt-2 › output": attempt(2),
      "test › flaky #attempt-2 › exit": attempt(2),
      "test › serve › start": command("serve"),
      "test › serve › output #1": statement("output #1", "output"),
      "test › serve › wait #2": statement("exited #1", "exited"),
      "test › serve › check #2": statement("exited #1", "exited"),
      "test › serve › wait #3": statement("exited #1", "exited"),
      "test › serve › check #3": statement("exited #1", "exited"),
      "test › serve › output": statement("exited #1", "exited"),
      "test › serve › kill": statement("kill", "kill"),
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

    expect(result.spans["test › flaky #attempt-1 › exit"]).toEqual(attempt(1));

    expect(result.names["test › flaky #attempt-1 › exit"]).toBe(
      "Exited with code 1",
    );

    expect(result.steps["test › flaky #attempt-1 › exit"]).toMatchObject({
      name: "NonRetriableError",
      message: "exit 1",
    });
  });

  test("record nothing more for a passing or `.nothrow()` command", async () => {
    const result = await ciTest({
      scripts: [{ match: "fail", exitCode: 1 }],
    }).run((ci) => {
      return ci.job("test", async () => {
        await $`pass`;

        await $`fail`.nothrow();
      });
    });

    expect(result.type).toBe("function-resolved");

    expect(
      result.stepIds.filter((id) => {
        return id.endsWith("› exit");
      }),
    ).toEqual([]);
  });

  test("still retry after a failed run, and throw the same error at the end", async () => {
    let caught: unknown;

    const result = await ciTest({
      scripts: [
        { match: "flaky", exitCode: 1, stdout: "out", stderr: "flake" },
      ],
    }).run((ci) => {
      return ci.job("test", async () => {
        try {
          await $`flaky`.retries(1);
        } catch (error) {
          caught = error;
        }
      });
    });

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
    const result = await ciTest().run((ci) => {
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
    const result = await ciTest().run(rowsPipeline);

    expect(result.type).toBe("function-resolved");

    expect(drawTrace(result)).toBe(
      [
        "GitHub [github]",
        "  Create check: pr",
        "  Report test: started",
        "  Report test: passed",
        "  Report jobs: ended with the run",
        "  Complete check: pr",
        "Look up cache",
        "Build base in its own run",
        "test [job]",
        "  Start sandbox from base [sandbox]",
        "    Create sandbox",
        "    Prepare workspace",
        "  $ pnpm test [command]",
        "    Start process",
        "    Wait 1s",
        "    Poll process",
        "    Read output",
        "  lint [command]",
        "    Start process",
        "    Wait 1s",
        "    Poll process",
        "    Read output",
        "  my-step",
        "  api [sandbox]",
        "    Start sandbox [sandbox]",
        "      Create sandbox",
        "      Prepare workspace",
        "    $ pnpm start [command]",
        "      Run and read output",
        "Clean up sandboxes",
        "Clean up snapshots",
      ].join("\n"),
    );
  });

  test("mark the work CI does for you, and nothing you wrote", async () => {
    const result = await ciTest().run(rowsPipeline);

    expect(result.type).toBe("function-resolved");

    expect(ciOrigin).toBe(`@inngest/ci@${version}`);

    // Jobs, commands, `my-step` and the `api` sandbox are yours.
    expect(drawTrace(result, true)).toBe(
      [
        "GitHub [github] <- ci",
        "  Create check: pr <- ci",
        "  Report test: started <- ci",
        "  Report test: passed <- ci",
        "  Report jobs: ended with the run <- ci",
        "  Complete check: pr <- ci",
        "Look up cache <- ci",
        "Build base in its own run <- ci",
        "test [job]",
        "  Start sandbox from base [sandbox] <- ci",
        "    Create sandbox <- ci",
        "    Prepare workspace <- ci",
        "  $ pnpm test [command]",
        "    Start process <- ci",
        "    Wait 1s <- ci",
        "    Poll process <- ci",
        "    Read output <- ci",
        "  lint [command]",
        "    Start process <- ci",
        "    Wait 1s <- ci",
        "    Poll process <- ci",
        "    Read output <- ci",
        "  my-step",
        "  api [sandbox]",
        "    Start sandbox [sandbox] <- ci",
        "      Create sandbox <- ci",
        "      Prepare workspace <- ci",
        "    $ pnpm start [command]",
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

    const result = await ciTest({ api }).run((ci) => {
      const parent = ci.job("base", async () => {
        await $`pnpm install`;
      });

      return ci.job({ id: "test", from: parent }, async () => {
        await $`pnpm test`;
      });
    });

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
