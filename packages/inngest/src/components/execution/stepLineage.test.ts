import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, test } from "vitest";
import { createClient } from "../../test/helpers.ts";
import { StepMode } from "../../types.ts";
import { InngestFunction } from "../InngestFunction.ts";
import type { GenericStepTools } from "../InngestStepTools.ts";
import { _internals } from "./engine.ts";
import type { ExecutionResults } from "./InngestExecution.ts";

/**
 * These drive real executions with steps already memoised, so resumption
 * actually happens and lineage is observed the way it is in a live run.
 *
 * `discoveredAfter` is diagnostic only. It never affects execution, so every
 * assertion here is about what a run visualisation would be able to draw.
 */
describe("step lineage", () => {
  const hash = (id: string) => _internals.hashId(id);

  /**
   * Runs one request of a handler with `completed` already in state, exactly as
   * the Executor would send it back after those steps finished, and returns the
   * lineage reported for each newly discovered step.
   */
  const lineageOf = async ({
    handler,
    completed,
  }: {
    handler: (ctx: { step: GenericStepTools }) => unknown;
    completed: string[];
  }) => {
    const client = createClient({ id: "test" });

    const fn = new InngestFunction(
      client,
      { id: "test-fn", triggers: [{ event: "test/event" }] },
      handler as unknown as Parameters<typeof client.createFunction>[1],
    );

    const stepState = Object.fromEntries(
      completed.map((id) => [
        hash(id),
        { id: hash(id), data: id, fulfilled: false },
      ]),
    );

    const execution = fn["createExecution"]({
      partialOptions: {
        client,
        data: fromPartial({ event: { name: "test/event", data: {} } }),
        runId: "test-run-id",
        stepState,
        stepCompletionOrder: completed.map(hash),
        reqArgs: [],
        headers: {},
        stepMode: StepMode.Async,
      },
    });

    const result = await execution.start();

    // A lone new step is executed inline ("step-ran") rather than planned, so
    // both shapes carry lineage and both must be checked.
    const steps =
      result.type === "steps-found"
        ? (result as ExecutionResults["steps-found"]).steps
        : result.type === "step-ran"
          ? [(result as ExecutionResults["step-ran"]).step]
          : (() => {
              throw new Error(`unexpected result type "${result.type}"`);
            })();

    // Report lineage by readable step id, so failures name the step rather than
    // a hash. Hashes are reversed via the ids we were given plus the ones found.
    const nameOf = new Map<string, string>();
    for (const id of completed) {
      nameOf.set(hash(id), id);
    }
    for (const step of steps) {
      nameOf.set(step.id, step.displayName ?? step.id);
    }
    const name = (id: string) => nameOf.get(id) ?? id;

    return Object.fromEntries(
      steps.map((step) => {
        const opts = step.opts as
          | { discoveredAfter?: string[]; discoveredAfterAlternates?: string[] }
          | undefined;

        return [
          name(step.id),
          {
            after: (opts?.discoveredAfter ?? []).map(name).sort(),
            alternates: (opts?.discoveredAfterAlternates ?? []).map(name).sort(),
          },
        ];
      }),
    );
  };

  test("a step after a chain names the step it followed", async () => {
    const lineage = await lineageOf({
      handler: async ({ step }) => {
        await step.run("a", () => "a");
        await step.run("b", () => "b");
      },
      completed: ["a"],
    });

    expect(lineage.b).toEqual({ after: ["a"], alternates: [] });
  });

  test("a step after Promise.all names every member of the join", async () => {
    const lineage = await lineageOf({
      handler: async ({ step }) => {
        await Promise.all([
          step.run("a", () => "a"),
          step.run("b", () => "b"),
        ]);
        await step.run("c", () => "c");
      },
      completed: ["a", "b"],
    });

    expect(lineage.c).toEqual({ after: ["a", "b"], alternates: [] });
  });

  test("a three-way join names all three", async () => {
    const lineage = await lineageOf({
      handler: async ({ step }) => {
        await Promise.all([
          step.run("x", () => "x"),
          step.run("y", () => "y"),
          step.run("z", () => "z"),
        ]);
        await step.run("w", () => "w");
      },
      completed: ["x", "y", "z"],
    });

    expect(lineage.w).toEqual({ after: ["x", "y", "z"], alternates: [] });
  });

  test("Promise.allSettled joins too, despite per-element handlers", async () => {
    const lineage = await lineageOf({
      handler: async ({ step }) => {
        await Promise.allSettled([
          step.run("m", () => "m"),
          step.run("n", () => "n"),
        ]);
        await step.run("o", () => "o");
      },
      completed: ["m", "n"],
    });

    expect(lineage.o).toEqual({ after: ["m", "n"], alternates: [] });
  });

  test("a nested combinator flattens to the steps it stands for", async () => {
    const lineage = await lineageOf({
      handler: async ({ step }) => {
        await Promise.all([
          Promise.all([step.run("a", () => "a"), step.run("b", () => "b")]),
          step.run("c", () => "c"),
        ]);
        await step.run("d", () => "d");
      },
      completed: ["a", "b", "c"],
    });

    expect(lineage.d).toEqual({ after: ["a", "b", "c"], alternates: [] });
  });

  test("a race names the winner, and the losers as alternates", async () => {
    const lineage = await lineageOf({
      handler: async ({ step }) => {
        await Promise.race([
          step.run("r1", () => "r1"),
          step.run("r2", () => "r2"),
        ]);
        await step.run("r3", () => "r3");
      },
      completed: ["r1", "r2"],
    });

    // r1 completed first, so it is what unblocked r3. r2 could have, and did
    // not — a dashed edge, not a second real dependency.
    expect(lineage.r3).toEqual({ after: ["r1"], alternates: ["r2"] });
  });

  test("a step waiting on only part of a fan-out excludes the idle one", async () => {
    const lineage = await lineageOf({
      handler: async ({ step }) => {
        const x = step.run("x", () => "x");
        const y = step.run("y", () => "y");
        const z = step.run("z", () => "z");

        await Promise.all([x, z]);
        await step.run("w", () => "w");
        await y;
      },
      completed: ["x", "y", "z"],
    });

    expect(lineage.w).toEqual({ after: ["x", "z"], alternates: [] });
  });

  test("two independent .catch calls are not a join", async () => {
    const noop = () => undefined;

    const lineage = await lineageOf({
      handler: async ({ step }) => {
        const a = step.run("a", () => "a");
        const b = step.run("b", () => "b");
        a.catch(noop);
        b.catch(noop);

        await a;
        await step.run("c", () => "c");
        await b;
      },
      completed: ["a", "b"],
    });

    // c starts once a is done; b is still running. A `.catch()` is
    // `then(undefined, f)`, so it must not be read as a combinator.
    expect(lineage.c).toEqual({ after: ["a"], alternates: [] });
  });

  test("independent branches keep their own lineage", async () => {
    const lineage = await lineageOf({
      handler: async ({ step }) => {
        await Promise.all([
          (async () => {
            await step.run("L1", () => "L1");
            await step.run("L2", () => "L2");
          })(),
          (async () => {
            await step.run("R1", () => "R1");
            await step.run("R2", () => "R2");
          })(),
        ]);
      },
      completed: ["L1", "R1"],
    });

    expect(lineage.L2).toEqual({ after: ["L1"], alternates: [] });
    expect(lineage.R2).toEqual({ after: ["R1"], alternates: [] });
  });

  test("steps found before any resumption have no lineage", async () => {
    const lineage = await lineageOf({
      handler: async ({ step }) => {
        await Promise.all([
          step.run("a", () => "a"),
          step.run("b", () => "b"),
        ]);
      },
      completed: [],
    });

    expect(lineage.a).toEqual({ after: [], alternates: [] });
    expect(lineage.b).toEqual({ after: [], alternates: [] });
  });
});
