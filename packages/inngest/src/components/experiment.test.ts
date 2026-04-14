import { AsyncLocalStorage } from "node:async_hooks";
import { type Mock, vi } from "vitest";
import type { AsyncContext } from "./execution/als.ts";
import type { IInngestExecution } from "./execution/InngestExecution.ts";
import type {
  MetadataKind,
  MetadataOpcode,
  MetadataScope,
} from "./InngestMetadata.ts";

/**
 * We use the real ALS symbol so that `getAsyncCtxSync()` inside the
 * production code sees whatever store we push.
 */
const alsSymbol = Symbol.for("inngest:als");
const als = new AsyncLocalStorage<AsyncContext>();

/**
 * Install our test ALS as the global singleton *before* any production
 * module is imported.  The als.ts module lazily initialises on first
 * access, so overwriting the cache here guarantees every call to
 * `getAsyncCtxSync()` / `getAsyncLocalStorage()` resolves to our instance.
 */
(globalThis as Record<symbol, unknown>)[alsSymbol] = {
  promise: Promise.resolve(als),
  resolved: als,
  isFallback: false,
};

afterAll(() => {
  delete (globalThis as Record<string | symbol | number, unknown>)[alsSymbol];
});

// ── Strategy imports (after ALS is wired) ──────────────────────────
import { experiment } from "./ExperimentStrategies.ts";
import {
  createGroupTools,
  type ExperimentSelectFn,
  type GroupToolsDeps,
} from "./InngestGroupTools.ts";
import { createStepTools, getStepOptions } from "./InngestStepTools.ts";
import { NonRetriableError } from "./NonRetriableError.ts";

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Simulate what a real `step.run()` call does: flip the experiment
 * step tracker so that zero-step detection passes.
 */
const fakeStepCall = () => {
  const tracker = als.getStore()?.execution?.experimentStepTracker;
  if (tracker) {
    tracker.found = true;
  }
};

/** Create a minimal mock `IInngestExecution` with a spied `addMetadata`. */
const mockExecution = (): IInngestExecution & { addMetadata: Mock } => ({
  version: 1,
  start: vi.fn(),
  addMetadata: vi.fn(() => true),
});

/**
 * Build a fake `experimentStepRun` that:
 * 1. Records the OutgoingOp-style args it was called with.
 * 2. Runs the supplied callback inside an ALS context that mimics the
 *    real execution engine (sets `executingStep` with a hashed-id).
 */
const createMockExperimentStepRun = (
  exec: IInngestExecution,
  ctx: AsyncContext,
) => {
  const HASHED_STEP_ID = "abc123hashed";

  const fn = vi.fn(
    async (idOrOptions: string | { id: string }, callback: () => unknown) => {
      // Mimic what the engine does: set executingStep in ALS, then run cb
      const nestedCtx: AsyncContext = {
        ...ctx,
        execution: {
          ...ctx.execution!,
          executingStep: {
            id: HASHED_STEP_ID,
          },
        },
      };
      return als.run(nestedCtx, () => callback());
    },
  );

  return { fn, HASHED_STEP_ID };
};

/**
 * Create a full test harness: execution mock, ALS context, group tools.
 * Returns everything needed to call `group.experiment()` and inspect results.
 */
const createHarness = () => {
  const exec = mockExecution();
  const ctx: AsyncContext = {
    app: {} as AsyncContext["app"],
    execution: {
      instance: exec,
      ctx: { runId: "run-id-123" } as AsyncContext["execution"] extends
        | infer E
        | undefined
        ? E extends { ctx: infer C }
          ? C
          : never
        : never,
    },
  };
  const { fn: experimentStepRun, HASHED_STEP_ID } = createMockExperimentStepRun(
    exec,
    ctx,
  );

  const deps: GroupToolsDeps = { experimentStepRun: experimentStepRun };
  const group = createGroupTools(deps);

  /**
   * Run `group.experiment()` inside the base ALS context so that
   * `getAsyncCtxSync()` returns our mock context.
   */
  const run = <T>(fn: () => Promise<T>): Promise<T> => als.run(ctx, fn);

  return { group, exec, ctx, experimentStepRun, HASHED_STEP_ID, run };
};

// ====================================================================
// Strategy tests
// ====================================================================

describe("experiment strategies", () => {
  describe("fixed", () => {
    test("always returns the specified variant", () => {
      const select = experiment.fixed("control");
      expect(select()).toBe("control");
    });

    test("ignores variant names argument", () => {
      const select = experiment.fixed("beta");
      expect(select(["alpha", "beta", "gamma"])).toBe("beta");
    });

    test("has strategy 'fixed' in config", () => {
      const select = experiment.fixed("x");
      expect(select.__experimentConfig).toEqual({ strategy: "fixed" });
    });
  });

  describe("weighted", () => {
    test("returns a valid variant name", () => {
      const select = experiment.weighted({ a: 50, b: 50 });
      // Must resolve inside ALS with a runId for determinism
      const result = als.run(
        {
          app: {} as AsyncContext["app"],
          execution: {
            instance: mockExecution(),
            ctx: { runId: "seed-1" } as never,
          },
        },
        () => select(),
      );
      expect(["a", "b"]).toContain(result);
    });

    test("is deterministic for the same run ID", () => {
      const select = experiment.weighted({ a: 50, b: 50 });
      const ctx: AsyncContext = {
        app: {} as AsyncContext["app"],
        execution: {
          instance: mockExecution(),
          ctx: { runId: "deterministic-seed" } as never,
        },
      };

      const first = als.run(ctx, () => select());
      const second = als.run(ctx, () => select());
      expect(first).toBe(second);
    });

    test("produces different results for different run IDs", () => {
      const select = experiment.weighted({ a: 50, b: 50 });
      const results = new Set<string>();

      // With enough different seeds, we should get both variants
      for (let i = 0; i < 100; i++) {
        const ctx: AsyncContext = {
          app: {} as AsyncContext["app"],
          execution: {
            instance: mockExecution(),
            ctx: { runId: `run-${i}` } as never,
          },
        };
        results.add(als.run(ctx, () => select()) as string);
      }

      expect(results.size).toBe(2);
    });

    test("respects weight distribution (70/30)", () => {
      const weights = { a: 70, b: 30 };
      const select = experiment.weighted(weights);
      const counts: Record<string, number> = { a: 0, b: 0 };

      for (let i = 0; i < 1000; i++) {
        const ctx: AsyncContext = {
          app: {} as AsyncContext["app"],
          execution: {
            instance: mockExecution(),
            ctx: { runId: `dist-${i}` } as never,
          },
        };
        const variant = als.run(ctx, () => select()) as string;
        counts[variant]!++;
      }

      // With 1000 samples, 70/30 should be roughly within 55-85 / 15-45
      expect(counts.a).toBeGreaterThan(550);
      expect(counts.a).toBeLessThan(850);
      expect(counts.b).toBeGreaterThan(150);
      expect(counts.b).toBeLessThan(450);
    });

    test("has strategy 'weighted' and weights in config", () => {
      const weights = { x: 60, y: 40 };
      const select = experiment.weighted(weights);
      expect(select.__experimentConfig).toEqual({
        strategy: "weighted",
        weights,
      });
    });

    test("throws on all-zero weights", () => {
      expect(() => experiment.weighted({ a: 0, b: 0 })).toThrow(
        "all weights are zero",
      );
    });

    test("throws on negative weights", () => {
      expect(() => experiment.weighted({ a: -10, b: 50 })).toThrow(
        'weight for "a" is negative (-10)',
      );
    });

    test("throws on NaN weight", () => {
      expect(() => experiment.weighted({ a: NaN, b: 50 })).toThrow(
        'weight for "a" is not a finite number',
      );
    });

    test("throws on Infinity weight", () => {
      expect(() => experiment.weighted({ a: Infinity, b: 50 })).toThrow(
        'weight for "a" is not a finite number',
      );
    });
  });

  describe("bucket", () => {
    test("same value always maps to the same variant", () => {
      const select = experiment.bucket("user-42", {
        weights: { a: 50, b: 50 },
      });
      const first = select();
      const second = select();
      expect(first).toBe(second);
    });

    test("distributes different values across variants", () => {
      const results = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const select = experiment.bucket(`user-${i}`, {
          weights: { a: 50, b: 50 },
        });
        results.add(select() as string);
      }
      expect(results.size).toBe(2);
    });

    test("uses equal weights from variant names when no explicit weights", () => {
      const select = experiment.bucket("user-99");
      // When called with variant names, should work
      const result = select(["control", "treatment"]);
      expect(["control", "treatment"]).toContain(result);
    });

    test("throws when no weights and no variant names", () => {
      const select = experiment.bucket("user-1");
      expect(() => select()).toThrow(
        "experiment.bucket() requires either explicit weights or variant names",
      );
    });

    test("hashes empty string for null value", () => {
      const selectNull = experiment.bucket(null, {
        weights: { a: 50, b: 50 },
      });
      const selectUndefined = experiment.bucket(undefined, {
        weights: { a: 50, b: 50 },
      });
      // Both null and undefined should hash "" → same result
      expect(selectNull()).toBe(selectUndefined());
    });

    test("sets nullishBucket flag for null/undefined", () => {
      expect(experiment.bucket(null).__experimentConfig.nullishBucket).toBe(
        true,
      );
      expect(
        experiment.bucket(undefined).__experimentConfig.nullishBucket,
      ).toBe(true);
    });

    test("does not set nullishBucket for non-null values", () => {
      expect(
        experiment.bucket("hello").__experimentConfig.nullishBucket,
      ).toBeUndefined();
    });

    test("has strategy 'bucket' in config", () => {
      const select = experiment.bucket("val");
      expect(select.__experimentConfig.strategy).toBe("bucket");
    });

    test("throws on all-zero explicit weights", () => {
      expect(() =>
        experiment.bucket("val", { weights: { a: 0, b: 0 } }),
      ).toThrow("all weights are zero");
    });
  });

  describe("custom", () => {
    test("calls the user function and returns result", () => {
      const select = experiment.custom(() => "my-variant");
      expect(select()).toBe("my-variant");
    });

    test("supports async functions", async () => {
      const select = experiment.custom(async () => "async-variant");
      await expect(select()).resolves.toBe("async-variant");
    });

    test("has strategy 'custom' in config", () => {
      const select = experiment.custom(() => "x");
      expect(select.__experimentConfig).toEqual({ strategy: "custom" });
    });
  });
});

// ====================================================================
// Core flow tests
// ====================================================================

describe("group.experiment() core flow", () => {
  test("calls experimentStepRun with the experiment ID", async () => {
    const { group, experimentStepRun, run } = createHarness();

    await run(() =>
      group.experiment("checkout-flow", {
        variants: {
          control: () => {
            fakeStepCall();
            return "old";
          },
          new_flow: () => {
            fakeStepCall();
            return "new";
          },
        },
        select: experiment.fixed("control"),
      }),
    );

    expect(experimentStepRun).toHaveBeenCalledWith(
      "checkout-flow",
      expect.any(Function),
    );
  });

  test("executes the selected variant's callback", async () => {
    const { group, run } = createHarness();
    const controlFn = vi.fn(() => {
      fakeStepCall();
      return "old-result";
    });
    const newFn = vi.fn(() => {
      fakeStepCall();
      return "new-result";
    });

    await run(() =>
      group.experiment("test-exp", {
        variants: {
          control: controlFn,
          new_flow: newFn,
        },
        select: experiment.fixed("new_flow"),
      }),
    );

    expect(newFn).toHaveBeenCalled();
    expect(controlFn).not.toHaveBeenCalled();
  });

  test("selection is memoized via experimentStepRun", async () => {
    const { group, experimentStepRun, run } = createHarness();

    // Call experiment twice
    await run(() =>
      group.experiment("exp-1", {
        variants: {
          a: () => {
            fakeStepCall();
            return "a";
          },
          b: () => {
            fakeStepCall();
            return "b";
          },
        },
        select: experiment.fixed("a"),
      }),
    );

    // experimentStepRun should have been called (memoization entry point)
    expect(experimentStepRun).toHaveBeenCalledTimes(1);
  });

  test("works on replay when experiment step is memoized", async () => {
    const exec = mockExecution();
    const ctx: AsyncContext = {
      app: {} as AsyncContext["app"],
      execution: {
        instance: exec,
        ctx: { runId: "run-id-123" } as never,
      },
    };

    // Simulate memoized step: returns variant name without calling callback
    const memoizedStepRun = vi.fn(
      async (_idOrOptions: unknown, _callback: unknown) => "control",
    );

    const deps: GroupToolsDeps = { experimentStepRun: memoizedStepRun };
    const group = createGroupTools(deps);

    const result = await als.run(ctx, () =>
      group.experiment("exp", {
        variants: {
          control: () => {
            fakeStepCall();
            return "old-result";
          },
          new_flow: () => {
            fakeStepCall();
            return "new-result";
          },
        },
        select: experiment.fixed("control"),
      }),
    );

    expect(result).toBe("old-result");
    expect(memoizedStepRun).toHaveBeenCalledTimes(1);
  });

  test("throws if experimentStepRun dep is missing", async () => {
    const group = createGroupTools();

    await expect(
      group.experiment("exp", {
        variants: { a: () => 1 },
        select: experiment.fixed("a"),
      }),
    ).rejects.toThrow("requires step tools to be available");
  });

  test("throws if no variants defined", async () => {
    const { group, run } = createHarness();

    await expect(
      run(() =>
        group.experiment("exp", {
          variants: {},
          select: experiment.fixed("a"),
        }),
      ),
    ).rejects.toThrow("requires at least one variant");
  });
});

// ====================================================================
// Return shape tests
// ====================================================================

describe("group.experiment() return shapes", () => {
  test("returns variant result by default", async () => {
    const { group, run } = createHarness();

    const result = await run(() =>
      group.experiment("exp", {
        variants: {
          a: () => {
            fakeStepCall();
            return "result-a";
          },
          b: () => {
            fakeStepCall();
            return "result-b";
          },
        },
        select: experiment.fixed("a"),
      }),
    );

    expect(result).toBe("result-a");
  });

  test("returns { result, variant } when withVariant is true", async () => {
    const { group, run } = createHarness();

    const result = await run(() =>
      group.experiment("exp", {
        variants: {
          a: () => {
            fakeStepCall();
            return "result-a";
          },
          b: () => {
            fakeStepCall();
            return "result-b";
          },
        },
        select: experiment.fixed("b"),
        withVariant: true,
      }),
    );

    expect(result).toEqual({
      result: "result-b",
      variant: "b",
    });
  });
});

// ====================================================================
// Edge case tests
// ====================================================================

describe("group.experiment() edge cases", () => {
  test("single variant — selection runs and returns result", async () => {
    const { group, run } = createHarness();

    const result = await run(() =>
      group.experiment("single", {
        variants: {
          only: () => {
            fakeStepCall();
            return "only-result";
          },
        },
        select: experiment.fixed("only"),
      }),
    );

    expect(result).toBe("only-result");
  });

  test("custom returning invalid variant throws NonRetriableError", async () => {
    const { group, run } = createHarness();

    await expect(
      run(() =>
        group.experiment("exp", {
          variants: { a: () => 1, b: () => 2 },
          select: experiment.custom(() => "nonexistent"),
        }),
      ),
    ).rejects.toThrow(NonRetriableError);
  });

  test("custom returning invalid variant includes variant name in error", async () => {
    const { group, run } = createHarness();

    await expect(
      run(() =>
        group.experiment("my-exp", {
          variants: { x: () => 1, y: () => 2 },
          select: experiment.custom(() => "z"),
        }),
      ),
    ).rejects.toThrow(/select\(\) returned "z"/);
  });

  test("all-zero weights throw at creation time", () => {
    expect(() => experiment.weighted({ a: 0, b: 0 })).toThrow(
      "all weights are zero",
    );
  });

  test("zero-step variant throws NonRetriableError", async () => {
    const { group, run } = createHarness();

    // Variant returns a value directly without calling any step tool
    await expect(
      run(() =>
        group.experiment("exp", {
          variants: {
            bad: () => "no-step-call",
          },
          select: experiment.fixed("bad"),
        }),
      ),
    ).rejects.toThrow(NonRetriableError);
  });

  test("zero-step variant error message is descriptive", async () => {
    const { group, run } = createHarness();

    await expect(
      run(() =>
        group.experiment("my-exp", {
          variants: { bad: () => "raw" },
          select: experiment.fixed("bad"),
        }),
      ),
    ).rejects.toThrow(/did not invoke any step tools/);
  });
});

// ====================================================================
// ALS propagation tests
// ====================================================================

describe("group.experiment() ALS propagation", () => {
  test("variant callback runs inside ALS with experimentContext", async () => {
    const { group, run, HASHED_STEP_ID } = createHarness();
    let capturedCtx: AsyncContext["execution"] | undefined;

    await expect(
      run(() =>
        group.experiment("my-exp", {
          variants: {
            alpha: () => {
              // Capture the ALS context that the variant sees
              capturedCtx = als.getStore()?.execution;
              return "val";
            },
          },
          select: experiment.fixed("alpha"),
        }),
      ),
    ).rejects.toThrow(); // will throw zero-step, but we capture ctx first

    expect(capturedCtx?.experimentContext).toEqual({
      experimentStepID: HASHED_STEP_ID,
      experimentName: "my-exp",
      variant: "alpha",
      selectionStrategy: "fixed",
    });
  });

  test("step tools inside variant receive experiment fields for opts", async () => {
    const { group, run, HASHED_STEP_ID } = createHarness();
    let capturedExperimentContext: Record<string, unknown> | undefined;

    await run(() =>
      group.experiment("my-exp", {
        variants: {
          alpha: () => {
            // Simulate what wrappedMatchOp does: read experimentContext from ALS
            const ctx = als.getStore()?.execution?.experimentContext;
            if (ctx) {
              capturedExperimentContext = { ...ctx };
            }
            fakeStepCall();
            return "val";
          },
        },
        select: experiment.fixed("alpha"),
      }),
    );

    // Verify the fields that wrappedMatchOp would spread into OutgoingOp.opts
    expect(capturedExperimentContext).toEqual({
      experimentStepID: HASHED_STEP_ID,
      experimentName: "my-exp",
      variant: "alpha",
      selectionStrategy: "fixed",
    });
  });

  test("step tool invocation flips experimentStepTracker via ALS", async () => {
    const { group, run } = createHarness();
    let trackerAfterStep: boolean | undefined;

    await run(() =>
      group.experiment("exp", {
        variants: {
          v: () => {
            fakeStepCall();
            trackerAfterStep =
              als.getStore()?.execution?.experimentStepTracker?.found;
            return "val";
          },
        },
        select: experiment.fixed("v"),
      }),
    );

    expect(trackerAfterStep).toBe(true);
  });

  test("experimentContext is set even when experimentStepHashedId is empty (replay path)", async () => {
    // Simulate the replay case: experimentStepHashedId is undefined because
    // the selector step callback didn't re-execute (memoized). The
    // experimentContext should still be set so variant sub-steps can attach
    // experiment metadata to their ClickHouse rows.
    const exec = mockExecution();
    const ctx: AsyncContext = {
      app: {} as AsyncContext["app"],
      execution: {
        instance: exec,
        ctx: { runId: "run-id-replay" } as AsyncContext["execution"] extends
          | infer E
          | undefined
          ? E extends { ctx: infer C }
            ? C
            : never
          : never,
      },
    };

    // Mock experimentStepRun that does NOT set executingStep.id — simulates
    // replay where the callback is memoized and experimentStepHashedId stays
    // undefined.
    const experimentStepRun = vi.fn(
      async (
        _idOrOptions: string | { id: string },
        callback: () => unknown,
      ) => {
        return als.run(ctx, () => callback());
      },
    );

    const group = createGroupTools({ experimentStepRun });
    let capturedCtx: AsyncContext["execution"] | undefined;

    await expect(
      als.run(ctx, () =>
        group.experiment("my-exp", {
          variants: {
            alpha: () => {
              capturedCtx = als.getStore()?.execution;
              return "val";
            },
          },
          select: experiment.fixed("alpha"),
        }),
      ),
    ).rejects.toThrow(); // zero-step

    // experimentContext MUST be set even though experimentStepHashedId was
    // never captured. experimentStepID will be empty string as a fallback.
    expect(capturedCtx?.experimentContext).toBeDefined();
    expect(capturedCtx?.experimentContext).toEqual({
      experimentStepID: "",
      experimentName: "my-exp",
      variant: "alpha",
      selectionStrategy: "fixed",
    });
  });

  test("experimentContext includes selectionStrategy for weighted strategy", async () => {
    const { group, run } = createHarness();
    let capturedCtx: AsyncContext["execution"] | undefined;

    await expect(
      run(() =>
        group.experiment("weighted-ctx", {
          variants: {
            a: () => {
              capturedCtx = als.getStore()?.execution;
              return 1;
            },
            b: () => {
              capturedCtx = als.getStore()?.execution;
              return 2;
            },
          },
          select: experiment.weighted({ a: 70, b: 30 }),
        }),
      ),
    ).rejects.toThrow(); // zero-step

    expect(capturedCtx?.experimentContext).toBeDefined();
    expect(capturedCtx?.experimentContext?.selectionStrategy).toBe("weighted");
    expect(capturedCtx?.experimentContext?.experimentName).toBe("weighted-ctx");
    expect(["a", "b"]).toContain(capturedCtx?.experimentContext?.variant);
  });

  test("variant callback has experimentStepTracker in ALS", async () => {
    const { group, run } = createHarness();
    let capturedTracker: { found: boolean } | undefined;

    await expect(
      run(() =>
        group.experiment("exp", {
          variants: {
            v: () => {
              capturedTracker =
                als.getStore()?.execution?.experimentStepTracker;
              return "val";
            },
          },
          select: experiment.fixed("v"),
        }),
      ),
    ).rejects.toThrow(); // zero-step

    expect(capturedTracker).toBeDefined();
    expect(capturedTracker!.found).toBe(false);
  });
});

// ====================================================================
// Metadata tests
// ====================================================================

describe("group.experiment() metadata", () => {
  test("attaches inngest.experiment metadata to the selection step", async () => {
    const { group, run, exec, HASHED_STEP_ID } = createHarness();

    await run(() =>
      group.experiment("checkout-flow", {
        variants: {
          control: () => {
            fakeStepCall();
            return "c";
          },
          treatment: () => {
            fakeStepCall();
            return "t";
          },
        },
        select: experiment.fixed("control"),
      }),
    );

    expect(exec.addMetadata).toHaveBeenCalledWith(
      HASHED_STEP_ID,
      "inngest.experiment",
      "step",
      "merge",
      expect.objectContaining({
        experiment_name: "checkout-flow",
        variant_selected: "control",
        selection_strategy: "fixed",
        available_variants: ["control", "treatment"],
      }),
    );
  });

  test("includes variant_weights when strategy provides weights", async () => {
    const { group, run, exec } = createHarness();
    const weights = { a: 70, b: 30 };

    await run(() =>
      group.experiment("weighted-exp", {
        variants: {
          a: () => {
            fakeStepCall();
            return 1;
          },
          b: () => {
            fakeStepCall();
            return 2;
          },
        },
        select: experiment.weighted(weights),
      }),
    );

    const experimentCall = (exec.addMetadata as Mock).mock.calls.find(
      (call: unknown[]) => call[1] === "inngest.experiment",
    );
    expect(experimentCall).toBeDefined();
    expect(experimentCall![4]).toHaveProperty("variant_weights", weights);
  });

  test("does not include variant_weights when strategy has no weights", async () => {
    const { group, run, exec } = createHarness();

    await run(() =>
      group.experiment("fixed-exp", {
        variants: {
          a: () => {
            fakeStepCall();
            return 1;
          },
        },
        select: experiment.fixed("a"),
      }),
    );

    const experimentCall = (exec.addMetadata as Mock).mock.calls.find(
      (call: unknown[]) => call[1] === "inngest.experiment",
    );
    expect(experimentCall![4]).not.toHaveProperty("variant_weights");
  });

  test("attaches inngest.warning metadata for nullish bucket", async () => {
    const { group, run, exec, HASHED_STEP_ID } = createHarness();

    await run(() =>
      group.experiment("bucket-exp", {
        variants: {
          a: () => {
            fakeStepCall();
            return 1;
          },
          b: () => {
            fakeStepCall();
            return 2;
          },
        },
        select: experiment.bucket(null, { weights: { a: 50, b: 50 } }),
      }),
    );

    expect(exec.addMetadata).toHaveBeenCalledWith(
      HASHED_STEP_ID,
      "inngest.warnings",
      "step",
      "merge",
      expect.objectContaining({
        message: expect.stringContaining("null/undefined"),
      }),
    );
  });

  test("does not attach inngest.warning for non-null bucket", async () => {
    const { group, run, exec } = createHarness();

    await run(() =>
      group.experiment("bucket-exp", {
        variants: {
          a: () => {
            fakeStepCall();
            return 1;
          },
          b: () => {
            fakeStepCall();
            return 2;
          },
        },
        select: experiment.bucket("user-42", {
          weights: { a: 50, b: 50 },
        }),
      }),
    );

    const warningCalls = (exec.addMetadata as Mock).mock.calls.filter(
      (call: unknown[]) => call[1] === "inngest.warnings",
    );
    expect(warningCalls).toHaveLength(0);
  });

  test("metadata has correct kind and scope", async () => {
    const { group, run, exec } = createHarness();

    await run(() =>
      group.experiment("exp", {
        variants: {
          a: () => {
            fakeStepCall();
            return 1;
          },
        },
        select: experiment.fixed("a"),
      }),
    );

    const call = (exec.addMetadata as Mock).mock.calls.find(
      (c: unknown[]) => c[1] === "inngest.experiment",
    );

    // kind = "inngest.experiment", scope = "step", op = "merge"
    expect(call![1]).toBe("inngest.experiment" satisfies MetadataKind);
    expect(call![2]).toBe("step" satisfies MetadataScope);
    expect(call![3]).toBe("merge" satisfies MetadataOpcode);
  });

  test("all ExperimentMetadataValues fields populated for weighted strategy", async () => {
    const { group, run, exec } = createHarness();
    const weights = { control: 80, treatment: 20 };

    await run(() =>
      group.experiment("full-meta", {
        variants: {
          control: () => {
            fakeStepCall();
            return "c";
          },
          treatment: () => {
            fakeStepCall();
            return "t";
          },
        },
        select: experiment.weighted(weights),
      }),
    );

    const call = (exec.addMetadata as Mock).mock.calls.find(
      (c: unknown[]) => c[1] === "inngest.experiment",
    );
    const values = call![4] as Record<string, unknown>;

    expect(values.experiment_name).toBe("full-meta");
    expect(values.variant_selected).toBeDefined();
    expect(["control", "treatment"]).toContain(values.variant_selected);
    expect(values.selection_strategy).toBe("weighted");
    expect(values.available_variants).toEqual(["control", "treatment"]);
    expect(values.variant_weights).toEqual(weights);
  });
});

// ====================================================================
// Nested step guard
// ====================================================================

describe("nested step guard inside experiment select()", () => {
  test("sets insideExperimentSelect flag during custom select callback", async () => {
    const { group, run } = createHarness();

    await expect(
      run(() =>
        group.experiment("nested-guard", {
          variants: {
            control: () => {
              fakeStepCall();
              return "c";
            },
            treatment: () => {
              fakeStepCall();
              return "t";
            },
          },
          select: experiment.custom(async () => {
            // Verify the ALS flag is set during the select callback
            const { getAsyncCtxSync: getCtx } = await import(
              "./execution/als.ts"
            );
            const ctx = getCtx();
            expect(ctx?.execution?.insideExperimentSelect).toBe(true);
            return "control";
          }),
        }),
      ),
    ).resolves.toBeDefined();
  });
});

// ====================================================================
// Variant step metadata propagation
// ====================================================================

describe("variant step emits inngest.experiment metadata via wrappedMatchOp", () => {
  /**
   * Creates real step tools backed by a mock execution instance, so that
   * calling step.run() exercises the full wrappedMatchOp path including
   * the addMetadata call for variant steps.
   */
  const createStepToolsWithSpy = () => {
    const exec = mockExecution();

    const step = createStepTools(
      // Client — only used for middleware/config, not relevant here.
      { middleware: [] } as never,
      // Execution — wrappedMatchOp reads addMetadata from ALS, not this param,
      // but createStepTools requires it.
      exec as never,
      // Step handler — calls matchOp to exercise wrappedMatchOp.
      ({ args, matchOp }) => {
        const stepOptions = getStepOptions(args[0]);
        return Promise.resolve(matchOp(stepOptions, ...args.slice(1)));
      },
    );

    return { exec, step };
  };

  test("step.run inside experiment context writes metadata to variant step", async () => {
    const { exec, step } = createStepToolsWithSpy();

    const ctx: AsyncContext = {
      app: {} as AsyncContext["app"],
      execution: {
        instance: exec,
        ctx: { runId: "run-123" } as never,
        experimentContext: {
          experimentStepID: "selector-hashed-id",
          experimentName: "llm-response-strategy",
          variant: "gpt4o_mini",
          selectionStrategy: "weighted",
        },
        experimentStepTracker: { found: false },
      },
    };

    await als.run(ctx, () => step.run("gpt4o-mini-step", () => "result"));

    // Find the addMetadata call for the variant step (not the selector step).
    const variantMetadataCalls = (exec.addMetadata as Mock).mock.calls.filter(
      (call: unknown[]) =>
        call[1] === "inngest.experiment" && call[0] !== "selector-hashed-id",
    );

    expect(variantMetadataCalls).toHaveLength(1);

    const [stepId, kind, scope, op, values] = variantMetadataCalls[0]!;
    expect(stepId).toBe("gpt4o-mini-step");
    expect(kind).toBe("inngest.experiment");
    expect(scope).toBe("step");
    expect(op).toBe("merge");
    expect(values).toEqual({
      experiment_name: "llm-response-strategy",
      variant_selected: "gpt4o_mini",
      selection_strategy: "weighted",
    });
  });

  test("variant step metadata works on replay path (empty experimentStepID)", async () => {
    const { exec, step } = createStepToolsWithSpy();

    const ctx: AsyncContext = {
      app: {} as AsyncContext["app"],
      execution: {
        instance: exec,
        ctx: { runId: "run-replay" } as never,
        // Simulates replay: experimentStepID is empty because the selector
        // step callback did not re-execute.
        experimentContext: {
          experimentStepID: "",
          experimentName: "checkout-flow",
          variant: "express",
          selectionStrategy: "weighted",
        },
        experimentStepTracker: { found: false },
      },
    };

    await als.run(ctx, () =>
      step.run("express-checkout-step", () => "checkout-result"),
    );

    const variantMetadataCalls = (exec.addMetadata as Mock).mock.calls.filter(
      (call: unknown[]) => call[1] === "inngest.experiment",
    );

    expect(variantMetadataCalls).toHaveLength(1);

    const [stepId, _kind, _scope, _op, values] = variantMetadataCalls[0]!;
    expect(stepId).toBe("express-checkout-step");
    expect(values).toEqual({
      experiment_name: "checkout-flow",
      variant_selected: "express",
      selection_strategy: "weighted",
    });
  });

  test("no experiment metadata when step.run is outside experiment context", async () => {
    const { exec, step } = createStepToolsWithSpy();

    const ctx: AsyncContext = {
      app: {} as AsyncContext["app"],
      execution: {
        instance: exec,
        ctx: { runId: "run-no-exp" } as never,
        // No experimentContext — this is a regular step, not inside a variant.
      },
    };

    await als.run(ctx, () => step.run("regular-step", () => "result"));

    const experimentCalls = (exec.addMetadata as Mock).mock.calls.filter(
      (call: unknown[]) => call[1] === "inngest.experiment",
    );

    expect(experimentCalls).toHaveLength(0);
  });
});
