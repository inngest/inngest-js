import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../../index.ts";
import { createTestApp } from "../../../devServerTestHarness.ts";
import { randomSuffix, testNameFromFileUrl, waitFor } from "../../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

// --- Handler wrapping tests (from old wrapFunctionHandler) ---

test("multiple middleware in correct order", async () => {
  // Verify that middleware are called in the correct order for wrapping.
  // Each middleware wraps the handler, so:
  // - Mw1 wraps Mw2's handler
  // - Mw2 wraps the actual function
  // Result: mw1 before -> mw2 before -> fn -> mw2 after -> mw1 after

  const state = {
    done: false,
    logs: [] as string[],
  };

  class Mw1 extends Middleware.BaseMiddleware {
    override wrapFunctionHandler(): Middleware.WrapFunctionHandlerReturn {
      return async ({ next }) => {
        state.logs.push("mw1: before handler");
        const result = await next();
        state.logs.push("mw1: after handler");
        return result;
      };
    }
  }

  class Mw2 extends Middleware.BaseMiddleware {
    override wrapFunctionHandler(): Middleware.WrapFunctionHandlerReturn {
      return async ({ next }) => {
        state.logs.push("mw2: before handler");
        const result = await next();
        state.logs.push("mw2: after handler");
        return result;
      };
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [Mw1, Mw2],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0 },
    { event: eventName },
    async () => {
      state.logs.push("fn: top");
      state.done = true;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await waitFor(async () => {
    expect(state.done).toBe(true);
  });

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

  const state = {
    afterStep: {
      insideCount: 0,
      output: 0,
    },
    beforeStep: {
      insideCount: 0,
      output: 0,
    },
    done: false,
    normalStep: {
      insideCount: 0,
      output: 0,
    },
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override wrapFunctionHandler(): Middleware.WrapFunctionHandlerReturn {
      return async ({ next, ctx }) => {
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

        state.done = true;
        return output;
      };
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [TestMiddleware],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0 },
    { event: eventName },
    async ({ step }) => {
      state.normalStep.output = await step.run("step-1", () => {
        state.normalStep.insideCount++;
        return state.normalStep.insideCount;
      });
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await waitFor(async () => {
    expect(state.done).toBe(true);
  });

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
  test("1 middleware", async () => {
    const state = {
      done: false,
      transformedResults: [] as unknown[],
    };

    class TestMiddleware extends Middleware.BaseMiddleware {
      override wrapFunctionHandler(): Middleware.WrapFunctionHandlerReturn {
        return async ({ next }) => {
          const output = await next();
          state.transformedResults.push(output);
          return { wrapped: output };
        };
      }
    }

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [TestMiddleware],
    });
    const fn = client.createFunction(
      { id: "fn", retries: 0 },
      { event: eventName },
      async () => {
        state.done = true;
        return "original result";
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    await waitFor(async () => {
      expect(state.done).toBe(true);
    });

    expect(state.transformedResults).toEqual(["original result"]);
  });

  test("2 middleware", async () => {
    const state = {
      done: false,
      logs: [] as string[],
    };

    class Mw1 extends Middleware.BaseMiddleware {
      override wrapFunctionHandler(): Middleware.WrapFunctionHandlerReturn {
        return async ({ next }) => {
          const output = await next();
          state.logs.push(`mw1: ${output}`);
          return `mw1(${output})`;
        };
      }
    }

    class Mw2 extends Middleware.BaseMiddleware {
      override wrapFunctionHandler(): Middleware.WrapFunctionHandlerReturn {
        return async ({ next }) => {
          const output = await next();
          state.logs.push(`mw2: ${output}`);
          return `mw2(${output})`;
        };
      }
    }

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [Mw1, Mw2],
    });
    const fn = client.createFunction(
      { id: "fn", retries: 0 },
      { event: eventName },
      async () => {
        state.done = true;
        return "result";
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    await waitFor(async () => {
      expect(state.done).toBe(true);
    });

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
    const state = {
      done: false,
      capturedErrors: [] as Error[],
    };

    class TestMiddleware extends Middleware.BaseMiddleware {
      override wrapFunctionHandler(): Middleware.WrapFunctionHandlerReturn {
        return async ({ next }) => {
          try {
            return await next();
          } catch (error) {
            state.capturedErrors.push(error as Error);
            throw new WrappedError("wrapped", { cause: error });
          }
        };
      }
    }

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [TestMiddleware],
    });
    const fn = client.createFunction(
      { id: "fn", retries: 0 },
      { event: eventName },
      async () => {
        state.done = true;
        throw new OriginalError("original");
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    await waitFor(async () => {
      expect(state.done).toBe(true);
    });

    expect(state.capturedErrors).toHaveLength(1);
    expect(state.capturedErrors[0]).toBeInstanceOf(OriginalError);
    expect(state.capturedErrors[0]!.message).toBe("original");
  });

  test("multiple middleware error in onion order", async () => {
    const state = {
      done: false,
      logs: [] as string[],
    };

    class Mw1 extends Middleware.BaseMiddleware {
      override wrapFunctionHandler(): Middleware.WrapFunctionHandlerReturn {
        return async ({ next }) => {
          try {
            return await next();
          } catch (error) {
            const err = error as Error;
            state.logs.push(`mw1: ${err.message}`);
            throw new Error(`mw1(${err.message})`);
          }
        };
      }
    }

    class Mw2 extends Middleware.BaseMiddleware {
      override wrapFunctionHandler(): Middleware.WrapFunctionHandlerReturn {
        return async ({ next }) => {
          try {
            return await next();
          } catch (error) {
            const err = error as Error;
            state.logs.push(`mw2: ${err.message}`);
            throw new Error(`mw2(${err.message})`);
          }
        };
      }
    }

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [Mw1, Mw2],
    });
    const fn = client.createFunction(
      { id: "fn", retries: 0 },
      { event: eventName },
      async () => {
        state.done = true;
        throw new Error("error");
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    await waitFor(async () => {
      expect(state.done).toBe(true);
    });

    // Onion order: inner middleware (mw2) sees error first, outer (mw1) sees
    // wrapped error
    expect(state.logs).toEqual(["mw2: error", "mw1: mw2(error)"]);
  });

  test("error not caught when success", async () => {
    const state = {
      done: false,
      outputCalls: 0,
      errorCalls: 0,
    };

    class TestMiddleware extends Middleware.BaseMiddleware {
      override wrapFunctionHandler(): Middleware.WrapFunctionHandlerReturn {
        return async ({ next }) => {
          try {
            const output = await next();
            state.outputCalls++;
            return output;
          } catch (error) {
            state.errorCalls++;
            throw error;
          }
        };
      }
    }

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [TestMiddleware],
    });
    const fn = client.createFunction(
      { id: "fn", retries: 0 },
      { event: eventName },
      async () => {
        state.done = true;
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    await waitFor(async () => {
      expect(state.done).toBe(true);
    });

    expect(state.outputCalls).toBe(1);
    expect(state.errorCalls).toBe(0);
  });

  test("success not reached when error", async () => {
    const state = {
      done: false,
      outputCalls: 0,
      errorCalls: 0,
    };

    class TestMiddleware extends Middleware.BaseMiddleware {
      override wrapFunctionHandler(): Middleware.WrapFunctionHandlerReturn {
        return async ({ next }) => {
          try {
            const output = await next();
            state.outputCalls++;
            return output;
          } catch (error) {
            state.errorCalls++;
            throw error;
          }
        };
      }
    }

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [TestMiddleware],
    });
    const fn = client.createFunction(
      { id: "fn", retries: 0 },
      { event: eventName },
      async () => {
        state.done = true;
        throw new Error("function error");
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    await waitFor(async () => {
      expect(state.done).toBe(true);
    });

    expect(state.outputCalls).toBe(0);
    expect(state.errorCalls).toBe(1);
  });
});
