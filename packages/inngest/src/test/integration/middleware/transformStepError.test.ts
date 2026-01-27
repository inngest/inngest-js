import { expect, test } from "vitest";
import { Inngest, Middleware, StepError } from "../../../index.ts";
import { createTestApp } from "../../devServerTestHarness.ts";
import { randomSuffix, testNameFromFileUrl } from "../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("transform step error", async () => {
  const state = {
    done: false,
    transformedErrors: [] as Error[],
    caughtError: null as Error | null,
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override transformStepError(arg: Middleware.TransformStepErrorArgs) {
      state.transformedErrors.push(arg.error);
      return new Error(`wrapped: ${arg.error.message}`);
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middlewareV2: [new TestMiddleware()],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0 },
    { event: eventName },
    async ({ step }) => {
      try {
        await step.run("failing-step", async () => {
          throw new Error("step error");
        });
      } catch (err) {
        state.caughtError = err as Error;
      }
      state.done = true;
      return "function result";
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);

  // transformStepError is called when memoized step error is read
  expect(state.transformedErrors.length).toBe(1);
  expect(state.transformedErrors[0]).toBeInstanceOf(StepError);
  expect(state.caughtError?.message).toBe("wrapped: step error");
});

test("multiple middleware in correct order (forward piping)", async () => {
  const state = {
    done: false,
    logs: [] as string[],
    caughtError: null as Error | null,
  };

  class Mw1 extends Middleware.BaseMiddleware {
    override transformStepError(arg: Middleware.TransformStepErrorArgs) {
      state.logs.push(`mw1: ${arg.error.message}`);
      return new Error(`mw1(${arg.error.message})`);
    }
  }

  class Mw2 extends Middleware.BaseMiddleware {
    override transformStepError(arg: Middleware.TransformStepErrorArgs) {
      state.logs.push(`mw2: ${arg.error.message}`);
      return new Error(`mw2(${arg.error.message})`);
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middlewareV2: [new Mw1(), new Mw2()],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0 },
    { event: eventName },
    async ({ step }) => {
      try {
        await step.run("failing-step", async () => {
          throw new Error("original error");
        });
      } catch (err) {
        state.caughtError = err as Error;
      }
      state.done = true;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);

  // Error transforms are called in forward order (mw1 first, then mw2)
  // Each sees the error from the previous middleware
  expect(state.logs).toEqual([
    "mw1: original error",
    "mw2: mw1(original error)",
  ]);
  expect(state.caughtError?.message).toBe("mw2(mw1(original error))");
});

test("not called on successful step", async () => {
  const state = {
    done: false,
    outputCalls: 0,
    errorCalls: 0,
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override transformStepOutput(arg: Middleware.TransformStepOutputArgs) {
      state.outputCalls++;
      return arg.output;
    }
    override transformStepError() {
      state.errorCalls++;
      return new Error("ignored");
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middlewareV2: [new TestMiddleware()],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0 },
    { event: eventName },
    async ({ step }) => {
      await step.run("successful-step", async () => {
        return "success";
      });
      state.done = true;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);

  // On success, transformStepOutput is called, not transformStepError
  expect(state.outputCalls).toBe(1);
  expect(state.errorCalls).toBe(0);
});
