import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../../index.ts";
import { createTestApp } from "../../../devServerTestHarness.ts";
import {
  assertStepError,
  createState,
  isRecord,
  randomSuffix,
  testNameFromFileUrl,
} from "../../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

describe("output", async () => {
  test("1 middleware", async () => {
    const state = createState({
      hook: {
        outputs: [] as unknown[],
      },
      step: {
        insideCount: 0,
        output: "",
      },
    });

    class MW extends Middleware.BaseMiddleware {
      override async wrapStep({ next, stepInfo }: Middleware.WrapStepArgs) {
        const output = await next();
        state.hook.outputs.push(output);
        if (stepInfo.memoized) {
          return output;
        }

        return `wrapped: ${output}`;
      }
    }

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [MW],
    });
    const fn = client.createFunction(
      { id: "fn", retries: 0, triggers: [{ event: eventName }] },
      async ({ step, runId }) => {
        state.step.output = await step.run("my-step", async () => {
          state.step.insideCount++;
          return "original";
        });
        state.runId = runId;
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    await state.waitForRunComplete();

    expect(state.hook.outputs).toEqual(["original", "wrapped: original"]);
    expect(state.step).toEqual({
      insideCount: 1,
      output: "wrapped: original",
    });
  });

  test("2 middleware", async () => {
    const state = createState({
      hook: {
        outputs: [] as unknown[],
      },
      step: {
        insideCount: 0,
        output: "",
      },
    });

    class MW1 extends Middleware.BaseMiddleware {
      override async wrapStep({ next, stepInfo }: Middleware.WrapStepArgs) {
        const output = await next();
        state.hook.outputs.push(output);
        if (stepInfo.memoized) {
          return output;
        }

        return `mw1: ${output}`;
      }
    }

    class MW2 extends Middleware.BaseMiddleware {
      override async wrapStep({ next, stepInfo }: Middleware.WrapStepArgs) {
        const output = await next();
        state.hook.outputs.push(output);
        if (stepInfo.memoized) {
          return output;
        }

        return `mw2: ${output}`;
      }
    }

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [MW1, MW2],
    });
    const fn = client.createFunction(
      { id: "fn", retries: 0, triggers: [{ event: eventName }] },
      async ({ step, runId }) => {
        state.step.output = await step.run("my-step", async () => {
          state.step.insideCount++;
          return "original";
        });
        state.runId = runId;
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    await state.waitForRunComplete();

    expect(state.hook.outputs).toEqual([
      "original",
      "mw2: original",
      "mw1: mw2: original",
      "mw1: mw2: original",
    ]);
    expect(state.step).toEqual({
      insideCount: 1,
      output: "mw1: mw2: original",
    });
  });
});

describe("error", async () => {
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

  test("1 middleware", async () => {
    const state = createState({
      mw: {
        errors: [] as unknown[],
      },
      step: {
        insideCount: 0,
        error: null as unknown,
      },
    });

    class MW extends Middleware.BaseMiddleware {
      override async wrapStep({ next, stepInfo }: Middleware.WrapStepArgs) {
        try {
          await next();
        } catch (error) {
          state.mw.errors.push(error);
          if (stepInfo.memoized) {
            throw error;
          }
          throw new InsideMWError("wrapped", { cause: error });
        }
      }
    }

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [MW],
    });
    const fn = client.createFunction(
      { id: "fn", retries: 0, triggers: [{ event: eventName }] },
      async ({ step, runId }) => {
        try {
          await step.run("my-step", async () => {
            state.step.insideCount++;
            throw new InsideStepError("original");
          });
        } catch (error) {
          state.step.error = error;
        }
        state.runId = runId;
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    await state.waitForRunComplete();

    expect(state.mw.errors).toHaveLength(2);
    expect(state.mw.errors[0]).toEqual(new InsideStepError("original"));
    assertStepError(state.mw.errors[1], {
      message: "original",
      name: "InsideStepError",
    });

    expect(state.step).toEqual({
      insideCount: 1,
      error: state.mw.errors[1],
    });
  });

  test("2 middleware", async () => {
    const state = createState({
      mw1: {
        errors: [] as unknown[],
      },
      mw2: {
        errors: [] as unknown[],
      },
      step: {
        insideCount: 0,
        error: null as unknown,
      },
    });

    class MW1 extends Middleware.BaseMiddleware {
      override async wrapStep({ next, stepInfo }: Middleware.WrapStepArgs) {
        try {
          await next();
        } catch (error) {
          state.mw1.errors.push(error);
          if (stepInfo.memoized) {
            throw error;
          }
          throw new InsideMWError("mw1", { cause: error });
        }
      }
    }

    class MW2 extends Middleware.BaseMiddleware {
      override async wrapStep({ next, stepInfo }: Middleware.WrapStepArgs) {
        try {
          await next();
        } catch (error) {
          state.mw2.errors.push(error);
          if (stepInfo.memoized) {
            throw error;
          }
          throw new InsideMWError("mw2", { cause: error });
        }
      }
    }

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [MW1, MW2],
    });
    const fn = client.createFunction(
      { id: "fn", retries: 0, triggers: [{ event: eventName }] },
      async ({ step, runId }) => {
        try {
          await step.run("my-step", async () => {
            state.step.insideCount++;
            throw new InsideStepError("original");
          });
        } catch (error) {
          state.step.error = error;
        }
        state.runId = runId;
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    await state.waitForRunComplete();

    // MW2 catches error first
    expect(state.mw2.errors).toHaveLength(2);
    expect(state.mw2.errors[0]).toEqual(new InsideStepError("original"));
    assertStepError(state.mw2.errors[1], {
      message: "original",
      name: "InsideStepError",
    });

    // MW1 catches error second
    expect(state.mw1.errors).toHaveLength(2);
    expect(state.mw1.errors[0]).toEqual(
      new InsideMWError("mw2", { cause: new InsideStepError("original") }),
    );
    assertStepError(state.mw1.errors[1], {
      message: "original",
      name: "InsideStepError",
    });

    expect(state.step).toEqual({
      insideCount: 1,
      error: state.mw1.errors[1],
    });
  });
});

test("wrap step handler", async () => {
  const state = createState({
    handlerWrapped: false,
    stepResult: null as unknown,
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    override wrapStep({ next }: Middleware.WrapStepArgs) {
      state.handlerWrapped = true;
      return next();
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [TestMiddleware],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      state.stepResult = await step.run("my-step", async () => {
        return "step result";
      });
      state.runId = runId;
      return "function result";
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.handlerWrapped).toBe(true);
  expect(state.stepResult).toBe("step result");
});

test("multiple middleware in correct order (reverse/wrapping)", async () => {
  const state = createState({
    logs: [] as string[],
  });

  class Mw1 extends Middleware.BaseMiddleware {
    override async wrapStep({ next }: Middleware.WrapStepArgs) {
      state.logs.push("mw1 before");
      const result = await next();
      state.logs.push("mw1 after");
      return result;
    }
  }

  class Mw2 extends Middleware.BaseMiddleware {
    override async wrapStep({ next }: Middleware.WrapStepArgs) {
      state.logs.push("mw2 before");
      const result = await next();
      state.logs.push("mw2 after");
      return result;
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [Mw1, Mw2],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      await step.run("my-step", async () => {
        state.logs.push("step executed");
        return "result";
      });
      state.runId = runId;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  // Input transforms wrap in reverse order: mw1 is outermost, mw2 is innermost
  // So execution order is: mw1 before -> mw2 before -> step -> mw2 after -> mw1 after
  expect(state.logs).toEqual([
    "mw1 before",
    "mw2 before",
    "step executed",
    "mw2 after",
    "mw1 after",
    "mw1 before",
    "mw2 before",
    "mw2 after",
    "mw1 after",
  ]);
});

test("called when both fresh and memoized", async () => {
  const state = createState({
    inputCalls: [] as { id: string; memoized: boolean }[],
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    override async wrapStep({ next, stepInfo }: Middleware.WrapStepArgs) {
      state.inputCalls.push({
        id: stepInfo.options.id,
        memoized: stepInfo.memoized,
      });
      return next();
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [TestMiddleware],
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

  expect(state.inputCalls).toEqual([
    { id: "step-1", memoized: false },
    { id: "step-1", memoized: true },
    { id: "step-2", memoized: false },
    { id: "step-1", memoized: true },
    { id: "step-2", memoized: true },
  ]);
});

test("bookend step.sleep", async () => {
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
    override onStepStart(arg: Middleware.OnStepStartArgs) {
      state.onStepStartCalls.push(arg);
    }

    override async wrapStep({ ctx, next, stepInfo }: Middleware.WrapStepArgs) {
      if (stepInfo.options.id.endsWith("-prepend")) {
        return next();
      }

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

test("bookend with steps", async () => {
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
    override async wrapStep({ ctx, next, stepInfo }: Middleware.WrapStepArgs) {
      if (["before", "after"].includes(stepInfo.options.id)) {
        return next();
      }

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

test("2 middleware with stepOutputTransform", async () => {
  // Ensure that both output modification and stepOutputTransform are applied in
  // reverse order

  // Replace the "mw1" and "mwBoth" fields
  type ReplaceMW1Fields<T> = {
    [K in keyof T]: K extends "mw1" | "mwBoth" ? "replaced by mw1" : T[K];
  };
  interface MW1StaticTransform extends Middleware.StaticTransform {
    Out: ReplaceMW1Fields<this["In"]>;
  }
  class MW1 extends Middleware.BaseMiddleware {
    declare stepOutputTransform: MW1StaticTransform;

    override async wrapStep({ next, stepInfo }: Middleware.WrapStepArgs) {
      const output = await next();
      if (stepInfo.memoized) {
        return output;
      }
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
    declare stepOutputTransform: MW2StaticTransform;

    override async wrapStep({ next, stepInfo }: Middleware.WrapStepArgs) {
      const output = await next();
      if (stepInfo.memoized) {
        return output;
      }
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
});

describe("throws", () => {
  test("in hook", async () => {
    // Errors in the hook are treated as function-level errors

    const state = createState({
      fn: { count: 0 },
      hook: { count: 0 },
      step: { count: 0 },
    });

    class TestMiddleware extends Middleware.BaseMiddleware {
      override wrapStep = async () => {
        state.hook.count++;
        throw new Error("oh no");
      };
    }

    const eventName = randomSuffix("evt");
    const client = new Inngest({
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

  test("in hook step", async () => {
    // Errors in the hook are treated as function-level errors

    const state = createState({
      fn: { count: 0 },
      hook: { count: 0 },
      hookStep: { count: 0 },
      step: { count: 0 },
    });

    class TestMiddleware extends Middleware.BaseMiddleware {
      override async wrapStep({
        ctx,
        next,
        stepInfo,
      }: Middleware.WrapStepArgs) {
        state.hook.count++;

        if (stepInfo.options.id === "hook-step") {
          return next();
        }

        await ctx.step.run("hook-step", () => {
          state.hookStep.count++;
          throw new Error("oh no");
        });
        return next();
      }
    }

    const eventName = randomSuffix("evt");
    const client = new Inngest({
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

    // 4 because the `wrapStep` method *also* runs for the step defined in the
    // hook
    expect(state.hook).toEqual({ count: 4 });

    expect(state.hookStep).toEqual({ count: 1 });
    expect(state.step).toEqual({ count: 0 });
  });

  test("in normal step", async () => {
    // Errors in the normal step are treated as step-level errors

    const state = createState({
      fn: { count: 0 },
      hook: { count: 0 },
      step: { count: 0 },
    });

    class TestMiddleware extends Middleware.BaseMiddleware {
      override async wrapStep({ next }: Middleware.WrapStepArgs) {
        state.hook.count++;
        return next();
      }
    }

    const eventName = randomSuffix("evt");
    const client = new Inngest({
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
});
