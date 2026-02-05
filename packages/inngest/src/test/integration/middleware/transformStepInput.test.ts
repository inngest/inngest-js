import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../index.ts";
import { createTestApp } from "../../devServerTestHarness.ts";
import { randomSuffix, testNameFromFileUrl } from "../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("wrap step handler", async () => {
  const state = {
    done: false,
    handlerWrapped: false,
    stepResult: null as unknown,
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override transformStepInput(arg: Middleware.TransformStepInputArgs) {
      const originalHandler = arg.handler;
      return {
        ...arg,
        handler: async () => {
          state.handlerWrapped = true;
          return originalHandler();
        },
      };
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
      state.stepResult = await step.run("my-step", async () => {
        return "step result";
      });
      state.done = true;
      return "function result";
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);

  expect(state.handlerWrapped).toBe(true);
  expect(state.stepResult).toBe("step result");
});

test("multiple middleware in correct order (reverse/wrapping)", async () => {
  const state = {
    done: false,
    logs: [] as string[],
  };

  class Mw1 extends Middleware.BaseMiddleware {
    override transformStepInput(arg: Middleware.TransformStepInputArgs) {
      const originalHandler = arg.handler;
      return {
        ...arg,
        handler: async () => {
          state.logs.push("mw1 before");
          const result = await originalHandler();
          state.logs.push("mw1 after");
          return result;
        },
      };
    }
  }

  class Mw2 extends Middleware.BaseMiddleware {
    override transformStepInput(arg: Middleware.TransformStepInputArgs) {
      const originalHandler = arg.handler;
      return {
        ...arg,
        handler: async () => {
          state.logs.push("mw2 before");
          const result = await originalHandler();
          state.logs.push("mw2 after");
          return result;
        },
      };
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
      await step.run("my-step", async () => {
        state.logs.push("step executed");
        return "result";
      });
      state.done = true;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);

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
  const state = {
    done: false,
    inputCalls: [] as { id: string; memoized: boolean }[],
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override transformStepInput(arg: Middleware.TransformStepInputArgs) {
      state.inputCalls.push({
        id: arg.stepInfo.id,
        memoized: arg.stepInfo.memoized,
      });
      return arg;
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
      await step.run("step-1", async () => "result-1");
      await step.run("step-2", async () => "result-2");
      state.done = true;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);

  expect(state.inputCalls).toEqual([
    { id: "step-1", memoized: false },
    { id: "step-1", memoized: true },
    { id: "step-2", memoized: false },
    { id: "step-1", memoized: true },
    { id: "step-2", memoized: true },
  ]);
});

// Add these tests later:
// - Change step ID, so that the step is treated as fresh
// - Change input for all step kinds
