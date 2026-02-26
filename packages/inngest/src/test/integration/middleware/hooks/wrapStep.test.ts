import {
  createState,
  createTestApp,
  randomSuffix,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { expect, test } from "vitest";
import { Inngest, Middleware, StepError } from "../../../../index.ts";
import { assertStepError, isRecord, matrixCheckpointing } from "../../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

matrixCheckpointing("change output", async (checkpointing) => {
  const state = createState({
    step: {
      count: 0,
      output: "",
    },
  });

  class MW1 extends Middleware.BaseMiddleware {
    readonly id = "test";
    override async wrapStep({ next }: Middleware.WrapStepArgs) {
      const output = await next();
      return `mw1: ${output}`;
    }
  }

  class MW2 extends Middleware.BaseMiddleware {
    readonly id = "test";
    override async wrapStep({ next }: Middleware.WrapStepArgs) {
      const output = await next();
      return `mw2: ${output}`;
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    checkpointing,
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [MW1, MW2],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      state.step.output = await step.run("my-step", async () => {
        state.step.count++;
        return "original";
      });
      state.runId = runId;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.step).toEqual({
    count: 1,
    output: "mw1: mw2: original",
  });
});

matrixCheckpointing("change error", async (checkpointing) => {
  class InsideStepError extends Error {
    constructor(message: string) {
      super(message);
      this.name = this.constructor.name;
    }
  }

  class InsideMWError extends Error {
    constructor(...args: Parameters<typeof Error>) {
      super(...args);
      this.name = this.constructor.name;
    }
  }

  const state = createState({
    fn: {
      errors: [] as unknown[],
    },
    mw1: {
      errors: [] as unknown[],
    },
    mw2: {
      errors: [] as unknown[],
    },
    step: {
      count: 0,
    },
  });

  class MW1 extends Middleware.BaseMiddleware {
    readonly id = "test";
    override async wrapStep({ next }: Middleware.WrapStepArgs) {
      try {
        return await next();
      } catch (error) {
        state.mw1.errors.push(error);
        throw new InsideMWError("mw1", { cause: error });
      }
    }
  }

  class MW2 extends Middleware.BaseMiddleware {
    readonly id = "test";
    override async wrapStep({ next }: Middleware.WrapStepArgs) {
      try {
        return await next();
      } catch (error) {
        state.mw2.errors.push(error);
        throw new InsideMWError("mw2", { cause: error });
      }
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    checkpointing,
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [MW1, MW2],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      try {
        await step.run("my-step", async () => {
          state.step.count++;
          throw new InsideStepError("original");
        });
      } catch (error) {
        state.fn.errors.push(error);
      }
      state.runId = runId;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  // MW1 got the `InsideStepError` thrown by MW2
  expect(state.mw1.errors).toHaveLength(1);
  expect(state.mw1.errors[0]).toBeInstanceOf(InsideMWError);

  // MW2 got the memoized `StepError` thrown by the step
  expect(state.mw2.errors).toHaveLength(1);
  expect(state.mw2.errors[0]).toBeInstanceOf(StepError);

  // Assert the cause chain of errors: mw1 -> mw2 -> step
  expect(state.fn.errors).toHaveLength(1);
  const error = state.fn.errors[0] as Error;
  expect(error).toBeInstanceOf(InsideMWError);
  expect(error.message).toBe("mw1");
  const cause = error.cause as Error;
  expect(cause).toBeInstanceOf(InsideMWError);
  expect(cause.message).toBe("mw2");
  const causeCause = cause.cause as Error;
  expect(causeCause).toBeInstanceOf(StepError);
  expect(causeCause.message).toBe("original");
  expect(causeCause.name).toBe("InsideStepError");

  expect(state.step).toEqual({ count: 1 });
});

matrixCheckpointing(
  "hangs on next when not memoized",
  async (checkpointing) => {
    // When a step is not memoized then the `next` method hangs.

    const state = createState({
      afterNext: [] as { id: string; memoized: boolean }[],
      beforeNext: [] as { id: string; memoized: boolean }[],
    });

    class MW extends Middleware.BaseMiddleware {
      readonly id = "test";
      override async wrapStep({ next, stepInfo }: Middleware.WrapStepArgs) {
        state.beforeNext.push({
          id: stepInfo.options.id,
          memoized: stepInfo.memoized,
        });
        const output = await next();
        state.afterNext.push({
          id: stepInfo.options.id,
          memoized: stepInfo.memoized,
        });
        return output;
      }
    }

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      checkpointing,
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [MW],
    });
    const fn = client.createFunction(
      { id: "fn", retries: 0, triggers: [{ event: eventName }] },
      async ({ step, runId }) => {
        await step.run("step-1", async () => "result-1");
        await step.run("step-2", async () => "result-2");
        state.runId = runId;
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    await state.waitForRunComplete();

    if (checkpointing) {
      // With checkpointing, we "barrel through" the steps. So `wrapStep` isn't
      // called for memoized data.
      expect(state.beforeNext).toEqual([
        { id: "step-1", memoized: false },
        { id: "step-2", memoized: false },
      ]);
      expect(state.afterNext).toEqual([
        { id: "step-1", memoized: false },
        { id: "step-2", memoized: false },
      ]);
    } else {
      expect(state.beforeNext).toEqual([
        { id: "step-1", memoized: false },
        { id: "step-1", memoized: true },
        { id: "step-2", memoized: false },
        { id: "step-1", memoized: true },
        { id: "step-2", memoized: true },
      ]);
      expect(state.afterNext).toEqual([
        { id: "step-1", memoized: true },
        { id: "step-1", memoized: true },
        { id: "step-2", memoized: true },
      ]);
    }
  },
);

matrixCheckpointing("bookend step.sleep", async (checkpointing) => {
  // Run a step before a `step.sleep` in the Inngest function

  const state = createState({
    afterStep: {
      insideCount: 0,
      output: 0,
    },
    beforeStep: {
      insideCount: 0,
      output: 0,
    },
    onStepStartCalls: [] as Middleware.OnStepStartArgs[],
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    readonly id = "test";
    override onStepStart(arg: Middleware.OnStepStartArgs) {
      state.onStepStartCalls.push(arg);
    }

    override async wrapStep({ ctx, next, stepInfo }: Middleware.WrapStepArgs) {
      const prependStepId = stepInfo.options.id + "-prepend";

      state.beforeStep.output = await ctx.step.run(prependStepId, async () => {
        state.beforeStep.insideCount++;
        return state.beforeStep.insideCount;
      });

      // The normal step
      const output = await next();

      state.afterStep.output = await ctx.step.run(prependStepId, async () => {
        state.afterStep.insideCount++;
        return state.afterStep.insideCount;
      });
      return output;
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    checkpointing,
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [TestMiddleware],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      state.runId = runId;
      await step.sleep("zzz", "1s");
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.beforeStep).toEqual({
    insideCount: 1,
    output: 1,
  });

  expect(state.afterStep).toEqual({
    insideCount: 1,
    output: 1,
  });
});

matrixCheckpointing("bookend with steps", async (checkpointing) => {
  // Run a step before and after the normal step in the Inngest function

  const state = createState({
    afterStep: {
      insideCount: 0,
      output: 0,
    },
    beforeStep: {
      insideCount: 0,
      output: 0,
    },
    normalStep: {
      insideCount: 0,
      output: 0,
    },
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    readonly id = "test";
    override async wrapStep({ ctx, next, stepInfo }: Middleware.WrapStepArgs) {
      state.beforeStep.output = await ctx.step.run("before", async () => {
        state.beforeStep.insideCount++;
        return state.beforeStep.insideCount;
      });

      // The normal step
      const output = await next();

      state.afterStep.output = await ctx.step.run("after", async () => {
        state.afterStep.insideCount++;
        return state.afterStep.insideCount;
      });
      return output;
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    checkpointing,
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [TestMiddleware],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      state.normalStep.output = await step.run("step-1", () => {
        state.normalStep.insideCount++;
        return state.normalStep.insideCount;
      });
      state.runId = runId;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.beforeStep).toEqual({
    insideCount: 1,
    output: 1,
  });
  expect(state.normalStep).toEqual({
    insideCount: 1,
    output: 1,
  });
  expect(state.afterStep).toEqual({
    insideCount: 1,
    output: 1,
  });
});

matrixCheckpointing(
  "2 middleware with stepOutputTransform",
  async (checkpointing) => {
    // Ensure that both output modification and stepOutputTransform are applied
    // in reverse order

    // Replace the "mw1" and "mwBoth" fields
    type ReplaceMW1Fields<T> = {
      [K in keyof T]: K extends "mw1" | "mwBoth" ? "replaced by mw1" : T[K];
    };
    interface MW1StaticTransform extends Middleware.StaticTransform {
      Out: ReplaceMW1Fields<this["In"]>;
    }
    class MW1 extends Middleware.BaseMiddleware {
      readonly id = "test";
      declare stepOutputTransform: MW1StaticTransform;

      override async wrapStepHandler({ next }: Middleware.WrapStepHandlerArgs) {
        const output = await next();
        if (!isRecord(output)) {
          return output;
        }

        return {
          ...output,
          mw1: "replaced by mw1",
          mwBoth: "replaced by mw1",
        };
      }
    }

    // Replace the "mw2" and "mwBoth" fields
    type ReplaceMW2Fields<T> = {
      [K in keyof T]: K extends "mw2" | "mwBoth" ? "replaced by mw2" : T[K];
    };
    interface MW2StaticTransform extends Middleware.StaticTransform {
      Out: ReplaceMW2Fields<this["In"]>;
    }

    class MW2 extends Middleware.BaseMiddleware {
      readonly id = "test";
      declare stepOutputTransform: MW2StaticTransform;

      override async wrapStepHandler({ next }: Middleware.WrapStepHandlerArgs) {
        const output = await next();
        if (!isRecord(output)) {
          return output;
        }

        return {
          ...output,
          mw2: "replaced by mw2",
          mwBoth: "replaced by mw2",
        };
      }
    }

    const state = createState({
      output: null as ExpectedFinalOutput | null,
    });

    type ExpectedFinalOutput = {
      readonly mw1: "replaced by mw1";
      readonly mw2: "replaced by mw2";
      readonly mwBoth: "replaced by mw1";
      readonly mwNone: "original";
    };

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      checkpointing,
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [MW1, MW2],
    });

    const fn = client.createFunction(
      { id: "fn", retries: 0, triggers: [{ event: eventName }] },
      async ({ step, runId }) => {
        const output = await step.run("my-step", () => {
          return {
            mw1: "original",
            mw2: "original",
            mwBoth: "original",
            mwNone: "original",
          } as const;
        });
        expectTypeOf(output).not.toBeAny();
        expectTypeOf(output).toEqualTypeOf<ExpectedFinalOutput>();

        state.output = output;
        state.runId = runId;
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    await state.waitForRunComplete();

    // Runtime values match `ExpectedFinalOutput`
    expect(state.output).toEqual({
      mw1: "replaced by mw1",
      mw2: "replaced by mw2",
      mwBoth: "replaced by mw1",
      mwNone: "original",
    });
  },
);

matrixCheckpointing("infinite recursion protection", async (checkpointing) => {
  // Creating a step inside `wrapStep` doesn't result in infinite recursion

  const state = createState({
    mw1: { stepIds: new Set<string>() },
    mw2: { stepIds: new Set<string>() },
    mw3: { stepIds: new Set<string>() },
    newStep: { count: 0 },
    normalStep: { count: 0 },
  });

  class MW1 extends Middleware.BaseMiddleware {
    readonly id = "test";
    override async wrapStep({ next, stepInfo }: Middleware.WrapStepArgs) {
      state.mw1.stepIds.add(stepInfo.options.id);
      return next();
    }
  }

  class MW2 extends Middleware.BaseMiddleware {
    readonly id = "test";
    override async wrapStep({ ctx, next, stepInfo }: Middleware.WrapStepArgs) {
      state.mw2.stepIds.add(stepInfo.options.id);
      await ctx.step.run("new", () => {
        state.newStep.count++;
      });
      return next();
    }
  }

  class MW3 extends Middleware.BaseMiddleware {
    readonly id = "test";
    override async wrapStep({ next, stepInfo }: Middleware.WrapStepArgs) {
      state.mw3.stepIds.add(stepInfo.options.id);
      return next();
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    checkpointing,
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [MW1, MW2, MW3],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      state.runId = runId;
      await step.run("normal", () => {
        state.normalStep.count++;
      });
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.newStep).toEqual({ count: 1 });
  expect(state.normalStep).toEqual({ count: 1 });
  expect(state.mw1.stepIds).toEqual(new Set(["normal", "new"]));
  expect(state.mw2.stepIds).toEqual(new Set(["normal"]));
  expect(state.mw3.stepIds).toEqual(new Set(["normal", "new"]));
});

matrixCheckpointing("throws in hook", async (checkpointing) => {
  // Errors in the hook are treated as function-level errors

  const state = createState({
    fn: { count: 0 },
    hook: { count: 0 },
    step: { count: 0 },
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    readonly id = "test";
    override wrapStep = async () => {
      state.hook.count++;
      throw new Error("oh no");
    };
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    checkpointing,
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [TestMiddleware],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      state.runId = runId;
      state.fn.count++;
      await step.run("normal-step", () => {
        state.step.count++;
      });
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunFailed();

  expect(state.fn).toEqual({ count: 1 });
  expect(state.hook).toEqual({ count: 1 });
  expect(state.step).toEqual({ count: 0 });
});

matrixCheckpointing("throws in hook step", async (checkpointing) => {
  // Errors in the hook are treated as function-level errors

  const state = createState({
    fn: { count: 0 },
    hook: { count: 0 },
    hookStep: { count: 0 },
    step: { count: 0 },
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    readonly id = "test";
    override async wrapStep({ ctx, next, stepInfo }: Middleware.WrapStepArgs) {
      state.hook.count++;

      await ctx.step.run("hook-step", () => {
        state.hookStep.count++;
        throw new Error("oh no");
      });
      return next();
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    checkpointing,
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [TestMiddleware],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      state.runId = runId;
      state.fn.count++;
      await step.run("normal-step", () => {
        state.step.count++;
      });
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunFailed();

  expect(state.fn).toEqual({ count: 2 });

  // 2 because the middleware is auto-skipped for "hook-step" (recursion
  // protection skips a middleware for steps it creates inside wrapStep)
  expect(state.hook).toEqual({ count: 2 });

  expect(state.hookStep).toEqual({ count: 1 });
  expect(state.step).toEqual({ count: 0 });
});

matrixCheckpointing("throws in normal step", async (checkpointing) => {
  // Errors in the normal step are treated as step-level errors

  const state = createState({
    fn: { count: 0 },
    hook: { count: 0 },
    step: { count: 0 },
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    readonly id = "test";
    override async wrapStep({ next }: Middleware.WrapStepArgs) {
      state.hook.count++;
      return next();
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    checkpointing,
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [TestMiddleware],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      state.runId = runId;
      state.fn.count++;
      await step.run("normal-step", () => {
        state.step.count++;
        throw new Error("oh no");
      });
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunFailed();

  expect(state.fn).toEqual({ count: 2 });
  expect(state.hook).toEqual({ count: 2 });
  expect(state.step).toEqual({ count: 1 });
});

test("checkpointing reentry", async () => {
  const state = createState({
    calls: [] as { id: string; memoized: boolean }[],
  });

  class MW extends Middleware.BaseMiddleware {
    readonly id = "test";
    override async wrapStep({ next, stepInfo }: Middleware.WrapStepArgs) {
      state.calls.push({
        id: stepInfo.options.id,
        memoized: stepInfo.memoized,
      });
      return next();
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    checkpointing: true,
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [MW],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      await step.run("step-before-sleep-1", async () => {});
      await step.run("step-before-sleep-2", async () => {});

      // Sleep to force reentry
      await step.sleep("zzz", "1s");

      await step.run("step-after-sleep-1", async () => {});
      await step.run("step-after-sleep-2", async () => {});

      state.runId = runId;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  // Sleep steps don't have handlers, so wrapStep doesn't fire during
  // fresh discovery. It only fires on the memoized pass (request 2).
  expect(state.calls).toEqual([
    { id: "step-before-sleep-1", memoized: false },
    { id: "step-before-sleep-2", memoized: false },
    { id: "step-before-sleep-1", memoized: true },
    { id: "step-before-sleep-2", memoized: true },
    { id: "zzz", memoized: true },
    { id: "step-after-sleep-1", memoized: false },
    { id: "step-after-sleep-2", memoized: false },
  ]);
});
