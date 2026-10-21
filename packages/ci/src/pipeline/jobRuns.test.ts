/**
 * Tests of jobs as child runs: each job a pipeline calls runs as a run of its
 * own, so it has its own step budget, and the pipeline's run only holds the
 * check, the invoke and the end of the job.
 *
 * @module
 */

import { internalEvents } from "inngest";
import { describe, expect, test } from "vitest";
import { consoleReporter } from "../github/auth.ts";
import { $ } from "../machine/command.ts";
import { report } from "../report.ts";
import { createCiTestClient } from "../testing/client.ts";
import { prEvent, prTrigger } from "../testing/events.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { invokedRunCount, runFunction } from "../testing/runFunction.ts";
import { fakeSchema } from "../testing/schema.ts";
import { createCi } from "./createCi.ts";

const setup = () => {
  const api = createFakeSandboxApi();
  const reporter = consoleReporter();
  const ci = createCi(createCiTestClient(api), { github: reporter });

  return { api, ci, reporter };
};

/** Jobs of three commands each, called together by a pipeline. */
const parallelJobs = (
  ci: ReturnType<typeof setup>["ci"],
  count: number,
  childRuns: boolean,
) => {
  const jobs = Array.from({ length: count }, (_, n) => {
    return ci.job(`job-${n}`, async () => {
      await $`pnpm lint`;
      await $`pnpm test`;
      await $`pnpm build`;
    });
  });

  return ci.pipeline({ id: "pr", on: prTrigger, childRuns }, async () => {
    await Promise.all(
      jobs.map((job) => {
        return job();
      }),
    );
  });
};

const machineNames = (api: ReturnType<typeof setup>["api"]): string[] => {
  return [...api.sandboxes.values()]
    .map((machine) => {
      return machine.name;
    })
    .sort();
};

const snapshotsTaken = (api: ReturnType<typeof setup>["api"]): string[] => {
  return api.timeline.filter((entry) => {
    return entry.startsWith("snapshot ");
  });
};

describe("jobs as child runs", () => {
  test("a job runs its commands in a run of its own, and the pipeline holds three steps for it", async () => {
    const { api, ci } = setup();
    const before = invokedRunCount();

    const result = await runFunction(parallelJobs(ci, 1, true), {
      event: prEvent,
    });

    expect(result.type).toBe("function-resolved");
    expect(invokedRunCount() - before).toBe(1);

    expect(
      result.stepIds.filter((id) => {
        return id.startsWith("job-0");
      }),
    ).toEqual(["job-0 › build"]);

    expect(result.names["job-0 › build"]).toBe("Run job-0 in its own run");

    expect(machineNames(api)).toEqual([
      expect.stringMatching(/^ci-01TESTINVOKED\d+-job-0$/),
    ]);

    // Nothing starts from the job, so no snapshot is taken for it.
    expect(snapshotsTaken(api)).toEqual([]);
  });

  test("the pipeline's run holds four steps per job instead of twelve", async () => {
    const steps: number[] = [];

    for (const childRuns of [false, true]) {
      const { ci } = setup();

      const result = await runFunction(parallelJobs(ci, 3, childRuns), {
        event: prEvent,
        maxRequests: 400,
      });

      expect(result.type).toBe("function-resolved");

      steps.push(result.stepIds.length);
    }

    // Five steps are the pipeline's own: its check, the jobs' checks, cleanup.
    expect(steps).toEqual([3 * 12 + 5, 3 * 4 + 5]);
  });

  test("a pipeline that would overflow a step limit in its own run fits as child runs", async () => {
    // The platform's default is 1,000 per run. This is the same shape on a
    // limit of 50, so the test runs in a moment.
    const stepLimit = 50;
    const steps: number[] = [];

    for (const childRuns of [false, true]) {
      const { ci } = setup();

      const result = await runFunction(parallelJobs(ci, 8, childRuns), {
        event: prEvent,
        maxRequests: 400,
      });

      expect(result.type).toBe("function-resolved");

      steps.push(result.stepIds.length);
    }

    const [inline = 0, child = 0] = steps;

    expect(inline).toBeGreaterThan(stepLimit);
    expect(child).toBeLessThan(stepLimit);
  });

  test.each([
    {
      why: "a command that exits non-zero",
      script: { match: "pnpm test", exitCode: 1, stderr: "1 failing" },
      command: () => {
        return $`pnpm test`;
      },
    },
    {
      why: "a command that times out",
      script: { match: "pnpm test", execTimesOut: true },
      command: () => {
        return $`pnpm test`.timeout("30s");
      },
    },
  ])(
    "$why fails the job's check as it does in the pipeline's run",
    async ({ script, command }) => {
      const outcomes = [];

      for (const childRuns of [false, true]) {
        const { api, ci, reporter } = setup();

        api.script([script]);

        const test = ci.job("test", async () => {
          await report.summary("reported before failing");

          await command();
        });

        const pipeline = ci.pipeline(
          { id: "pr", on: prTrigger, childRuns },
          async () => {
            await test();
          },
        );

        const result = await runFunction(pipeline, { event: prEvent });

        outcomes.push({
          type: result.type,
          retriable: result.retriable,
          completed: reporter.history
            .filter((entry) => {
              return entry.status === "completed";
            })
            .map(({ at: _at, summary, ...entry }) => {
              return {
                ...entry,
                summary: summary?.replace(/(?:\d+m )?\d+m?s/g, "<duration>"),
              };
            }),
          machines: [...api.sandboxes.values()].map((machine) => {
            return machine.status;
          }),
        });
      }

      const [inline, child] = outcomes;

      expect(child).toEqual(inline);
      expect(child?.type).toBe("function-rejected");
      expect(child?.completed[0]?.title).toMatch(
        /^(❌ .+|⏱️ Timed out: `pnpm test` ran past its 30s limit)$/,
      );
      expect(child?.completed[0]?.summary).toContain("reported before failing");
      expect(child?.machines).toEqual(["TERMINATED"]);
    },
  );

  test("the same job called twice is two runs, named as in the pipeline", async () => {
    const { ci } = setup();
    const before = invokedRunCount();

    const test = ci.job("test", async () => {
      await $`pnpm test`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await Promise.all([test(), test()]);
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(invokedRunCount() - before).toBe(2);
    expect(result.stepIds).toContain("test › build");
    expect(result.stepIds).toContain("test (2) › build");
  });

  test("a job's input crosses the invoke as given, and its schema runs in the job's run", async () => {
    const { api, ci } = setup();

    const deploy = ci.job(
      {
        id: "deploy",
        input: fakeSchema<{ target: string; retries: number }>(
          { target: "string", retries: "number" },
          { retries: 3 },
        ),
      },
      async ({ input }) => {
        await $`deploy ${input.target} ${String(input.retries)}`;
      },
    );

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await deploy({ target: "web" } as never);
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");

    expect(
      api.commands.map((argv) => {
        return argv.join(" ");
      }),
    ).toContain("deploy web 3");
  });

  test("jobs that start from a parent start from its snapshot, built once", async () => {
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

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await Promise.all([lint(), test()]);
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");

    expect(result.stepIds).toEqual(
      expect.arrayContaining([
        "base (from) › build",
        "lint › build",
        "test › build",
      ]),
    );

    expect(
      api.commands.filter((argv) => {
        return argv.join(" ") === "pnpm install";
      }),
    ).toHaveLength(1);

    // Only the parent is snapshotted: the jobs that start from it take none.
    expect(snapshotsTaken(api)).toEqual([
      expect.stringMatching(/^snapshot ci-01TESTINVOKED\d+-base$/),
    ]);

    const children = [...api.sandboxes.values()].filter((machine) => {
      return /-(lint|test)$/.test(machine.name);
    });

    expect(children).toHaveLength(2);

    expect(
      children.every((machine) => {
        return machine.snapshotId;
      }),
    ).toBe(true);
  });

  test("jobs the pipeline defines, or that keep a machine on failure, run in the pipeline's run", async () => {
    const { api, ci } = setup();
    const before = invokedRunCount();

    const kept = ci.job({ id: "kept", keepOnFailure: "1h" }, async () => {
      await $`pnpm kept`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      const made = ci.job("made", async () => {
        await $`pnpm made`;
      });

      await Promise.all([kept(), made()]);
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");
    expect(invokedRunCount() - before).toBe(0);
    expect(machineNames(api)).toEqual([
      "ci-01TESTRUN-kept",
      "ci-01TESTRUN-made",
    ]);
  });

  test("childRuns: false runs every job in the pipeline's run", async () => {
    const { api, ci } = setup();
    const before = invokedRunCount();

    const result = await runFunction(parallelJobs(ci, 2, false), {
      event: prEvent,
    });

    expect(result.type).toBe("function-resolved");
    expect(invokedRunCount() - before).toBe(0);
    expect(machineNames(api)).toEqual([
      "ci-01TESTRUN-job-0",
      "ci-01TESTRUN-job-1",
    ]);
  });

  test("the commands a job ran are counted in the pipeline's metadata", async () => {
    const { ci } = setup();

    const result = await runFunction(parallelJobs(ci, 2, true), {
      event: prEvent,
    });

    const end = result.metadata
      .filter((update) => {
        return update.scope === "run" && update.step.endsWith(":complete");
      })
      .at(-1);

    expect((end?.values.apis as { commands: number }).commands).toBe(6);
  });

  test("a run that is cancelled, or that ends, takes the jobs it called with it", () => {
    const { ci } = setup();

    parallelJobs(ci, 1, true);

    const build = ci.functions().find((fn) => {
      return fn.opts.id === "ci/build";
    });

    const cancelOn = build?.opts.cancelOn as { event: string; if: string }[];

    expect(
      cancelOn.map((cancel) => {
        return cancel.event;
      }),
    ).toEqual([
      internalEvents.FunctionCancelled,
      internalEvents.FunctionFinished,
    ]);

    // A cache build is for the runs after this one too, so it outlives its
    // invoker, unless the pipeline is cancelled.
    expect(cancelOn[0]?.if).toBe("async.data.run_id == event.data.rootRunId");

    expect(cancelOn[1]?.if).toBe(
      "event.data.direct == true && async.data.run_id == event.data.rootRunId",
    );
  });
});
