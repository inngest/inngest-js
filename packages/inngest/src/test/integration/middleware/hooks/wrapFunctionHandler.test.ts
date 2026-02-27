import {
  createState,
  createTestApp,
  randomSuffix,
  testNameFromFileUrl,
  waitFor,
} from "@inngest/test-harness";
import { expect, test } from "vitest";
import { Inngest, Middleware, NonRetriableError } from "../../../../index.ts";
import { matrixCheckpointing } from "../../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

// --- Handler wrapping tests (from old wrapFunctionHandler) ---

test("multiple middleware in correct order", async () => {
  // Verify that middleware are called in the correct order for wrapping.
  // Each middleware wraps the handler, so:
  // - Mw1 wraps Mw2's handler
  // - Mw2 wraps the actual function
  // Result: mw1 before -> mw2 before -> fn -> mw2 after -> mw1 after

  const state = createState({ logs: [] as string[] });

  class Mw1 extends Middleware.BaseMiddleware {
    readonly id = "test";
    override async wrapFunctionHandler({
      next,
    }: Middleware.WrapFunctionHandlerArgs) {
      state.logs.push("mw1: before handler");
      const result = await next();
      state.logs.push("mw1: after handler");
      return result;
    }
  }

  class Mw2 extends Middleware.BaseMiddleware {
    readonly id = "test";
    override async wrapFunctionHandler({
      next,
    }: Middleware.WrapFunctionHandlerArgs) {
      state.logs.push("mw2: before handler");
      const result = await next();
      state.logs.push("mw2: after handler");
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
    async ({ runId }) => {
      state.runId = runId;
      state.logs.push("fn: top");
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  // First middleware wraps second middleware, which wraps the function
  expect(state.logs).toEqual([
    "mw1: before handler",
    "mw2: before handler",
    "fn: top",
    "mw2: after handler",
    "mw1: after handler",
  ]);
});

test("bookend with steps", async () => {
  // Run a step before and after the Inngest function handler

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
    override wrapFunctionHandler: Middleware.BaseMiddleware["wrapFunctionHandler"] =
      async ({ ctx, next }) => {
        state.beforeStep.output = await ctx.step.run("before", async () => {
          state.beforeStep.insideCount++;
          return state.beforeStep.insideCount;
        });

        // The function handler
        const output = await next();

        state.afterStep.output = await ctx.step.run("after", async () => {
          state.afterStep.insideCount++;
          return state.afterStep.insideCount;
        });

        return output;
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
      state.normalStep.output = await step.run("step-1", () => {
        state.normalStep.insideCount++;
        return state.normalStep.insideCount;
      });
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

describe("modify output", () => {
  matrixCheckpointing("1 middleware", async (checkpointing) => {
    const state = createState({ transformedResults: [] as unknown[] });

    class TestMiddleware extends Middleware.BaseMiddleware {
      readonly id = "test";
      override async wrapFunctionHandler({
        next,
      }: Middleware.WrapFunctionHandlerArgs) {
        const output = await next();
        state.transformedResults.push(output);
        return { wrapped: output };
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
      async ({ runId }) => {
        state.runId = runId;
        return "original result";
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    const output = await state.waitForRunComplete();

    expect(state.transformedResults).toEqual(["original result"]);
    expect(output).toEqual({ wrapped: "original result" });
  });

  matrixCheckpointing("2 middleware", async (checkpointing) => {
    const state = createState({ logs: [] as string[] });

    class Mw1 extends Middleware.BaseMiddleware {
      readonly id = "test";
      override async wrapFunctionHandler({
        next,
      }: Middleware.WrapFunctionHandlerArgs) {
        const output = await next();
        state.logs.push(`mw1: ${output}`);
        return `mw1(${output})`;
      }
    }

    class Mw2 extends Middleware.BaseMiddleware {
      readonly id = "test";
      override async wrapFunctionHandler({
        next,
      }: Middleware.WrapFunctionHandlerArgs) {
        const output = await next();
        state.logs.push(`mw2: ${output}`);
        return `mw2(${output})`;
      }
    }

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      checkpointing,
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [Mw1, Mw2],
    });
    const fn = client.createFunction(
      { id: "fn", retries: 0, triggers: [{ event: eventName }] },
      async ({ runId }) => {
        state.runId = runId;
        return "result";
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    const output = await state.waitForRunComplete();
    expect(output).toEqual("mw1(mw2(result))");

    // Onion order: inner middleware (mw2) sees result first, outer (mw1) sees
    // wrapped result
    expect(state.logs).toEqual(["mw2: result", "mw1: mw2(result)"]);
  });
});

describe("modify error", () => {
  class OriginalError extends Error {
    constructor(message: string) {
      super(message);
      this.name = this.constructor.name;
    }
  }

  class WrappedError extends Error {
    constructor(message: string, options?: ErrorOptions) {
      super(message, options);
      this.name = this.constructor.name;
    }
  }

  test("transform error", async () => {
    const state = createState({ capturedErrors: [] as Error[] });

    class TestMiddleware extends Middleware.BaseMiddleware {
      readonly id = "test";
      override async wrapFunctionHandler({
        next,
      }: Middleware.WrapFunctionHandlerArgs) {
        try {
          return await next();
        } catch (error) {
          state.capturedErrors.push(error as Error);
          throw new WrappedError("wrapped", { cause: error });
        }
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
      async ({ runId }) => {
        state.runId = runId;
        throw new OriginalError("original");
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    await state.waitForRunFailed();

    expect(state.capturedErrors).toHaveLength(1);
    expect(state.capturedErrors[0]).toBeInstanceOf(OriginalError);
    expect(state.capturedErrors[0]!.message).toBe("original");
  });

  test("multiple middleware error in onion order", async () => {
    const state = createState({ logs: [] as string[] });

    class Mw1 extends Middleware.BaseMiddleware {
      readonly id = "test";
      override async wrapFunctionHandler({
        next,
      }: Middleware.WrapFunctionHandlerArgs) {
        try {
          return await next();
        } catch (error) {
          const err = error as Error;
          state.logs.push(`mw1: ${err.message}`);
          throw new Error(`mw1(${err.message})`);
        }
      }
    }

    class Mw2 extends Middleware.BaseMiddleware {
      readonly id = "test";
      override async wrapFunctionHandler({
        next,
      }: Middleware.WrapFunctionHandlerArgs) {
        try {
          return await next();
        } catch (error) {
          const err = error as Error;
          state.logs.push(`mw2: ${err.message}`);
          throw new Error(`mw2(${err.message})`);
        }
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
      async ({ runId }) => {
        state.runId = runId;
        throw new Error("error");
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    await state.waitForRunFailed();

    // Onion order: inner middleware (mw2) sees error first, outer (mw1) sees
    // wrapped error
    expect(state.logs).toEqual(["mw2: error", "mw1: mw2(error)"]);
  });

  test("error not caught when success", async () => {
    const state = createState({ outputCalls: 0, errorCalls: 0 });

    class TestMiddleware extends Middleware.BaseMiddleware {
      readonly id = "test";
      override async wrapFunctionHandler({
        next,
      }: Middleware.WrapFunctionHandlerArgs) {
        try {
          const output = await next();
          state.outputCalls++;
          return output;
        } catch (error) {
          state.errorCalls++;
          throw error;
        }
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
      async ({ runId }) => {
        state.runId = runId;
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    await state.waitForRunComplete();

    expect(state.outputCalls).toBe(1);
    expect(state.errorCalls).toBe(0);
  });

  test("success not reached when error", async () => {
    const state = createState({ outputCalls: 0, errorCalls: 0 });

    class TestMiddleware extends Middleware.BaseMiddleware {
      readonly id = "test";
      override async wrapFunctionHandler({
        next,
      }: Middleware.WrapFunctionHandlerArgs) {
        try {
          const output = await next();
          state.outputCalls++;
          return output;
        } catch (error) {
          state.errorCalls++;
          throw error;
        }
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
      async ({ runId }) => {
        state.runId = runId;
        throw new Error("function error");
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    await state.waitForRunFailed();

    expect(state.outputCalls).toBe(0);
    expect(state.errorCalls).toBe(1);
  });

  test("convert to NonRetriableError prevents retries", async () => {
    const state = createState({ fnCallCount: 0 });

    class TestMiddleware extends Middleware.BaseMiddleware {
      readonly id = "test";
      override async wrapFunctionHandler({
        next,
      }: Middleware.WrapFunctionHandlerArgs) {
        try {
          return await next();
        } catch (error) {
          throw new NonRetriableError("non-retriable", { cause: error });
        }
      }
    }

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [TestMiddleware],
    });
    const fn = client.createFunction(
      { id: "fn", retries: 2, triggers: [{ event: eventName }] },
      async ({ runId }) => {
        state.runId = runId;
        state.fnCallCount++;
        throw new Error("original error");
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    await state.waitForRunFailed();

    // Function should only run once — NonRetriableError prevents retries
    expect(state.fnCallCount).toBe(1);
  });
});

describe("throws", () => {
  test("in hook", async () => {
    // Errors in the hook are treated as function-level errors

    const state = createState({
      fn: { count: 0 },
      hook: { count: 0 },
    });

    class TestMiddleware extends Middleware.BaseMiddleware {
      readonly id = "test";
      override wrapFunctionHandler: Middleware.BaseMiddleware["wrapFunctionHandler"] =
        async ({ ctx }) => {
          state.runId = ctx.runId;
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
      async () => {
        state.fn.count++;
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    await state.waitForRunFailed();

    expect(state.fn).toEqual({ count: 0 });
    expect(state.hook).toEqual({ count: 1 });
  });

  test("in hook step", async () => {
    // Errors in a step created by the hook are treated as function-level errors

    const state = createState({
      fn: { count: 0 },
      hook: { count: 0 },
      hookStep: { count: 0 },
    });

    class TestMiddleware extends Middleware.BaseMiddleware {
      readonly id = "test";
      override wrapFunctionHandler: Middleware.BaseMiddleware["wrapFunctionHandler"] =
        async ({ ctx, next }) => {
          state.runId = ctx.runId;
          state.hook.count++;
          await ctx.step.run("hook-step", () => {
            state.hookStep.count++;
            throw new Error("oh no");
          });
          return next();
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
      async () => {
        state.fn.count++;
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    await state.waitForRunFailed();

    expect(state.fn).toEqual({ count: 0 });
    expect(state.hook).toEqual({ count: 2 });
    expect(state.hookStep).toEqual({ count: 1 });
  });

  test("in function", async () => {
    // Errors in the function handler are treated as function-level errors

    const state = createState({
      fn: { count: 0 },
      hook: { count: 0 },
    });

    class TestMiddleware extends Middleware.BaseMiddleware {
      readonly id = "test";
      override wrapFunctionHandler = async ({
        next,
      }: Middleware.WrapFunctionHandlerArgs) => {
        state.hook.count++;
        return next();
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
      async ({ runId }) => {
        state.runId = runId;
        state.fn.count++;
        throw new Error("oh no");
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    await state.waitForRunFailed();

    expect(state.fn).toEqual({ count: 1 });
    expect(state.hook).toEqual({ count: 1 });
  });
});
