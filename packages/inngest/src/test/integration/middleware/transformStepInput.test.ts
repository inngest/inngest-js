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

test("change step ID", async () => {
  // Change a step ID after it already ran, so that the step is treated as fresh
  // again. This means the step runs twice, with a different ID each time

  const state = {
    done: false,
    insideStepCount: 0,
    onStepStartCalls: [] as Middleware.OnStepStartArgs[],
  };

  let changeStepID = false;
  class TestMiddleware extends Middleware.BaseMiddleware {
    override onStepStart(arg: Middleware.OnStepStartArgs) {
      state.onStepStartCalls.push(arg);
    }

    override transformStepInput(arg: Middleware.TransformStepInputArgs) {
      if (changeStepID) {
        arg.stepInfo.id += "-new";
        arg.stepInfo.name += "-new";
      } else {
        changeStepID = true;
      }
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
      await step.run("step-1", () => {
        state.insideStepCount++;
        return state.insideStepCount;
      });
      state.done = true;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);

  expect(state.insideStepCount).toEqual(2);
  expect(state.onStepStartCalls).toEqual([
    {
      stepInfo: {
        hashedId: "cd59ee9a8137151d1499d3d2eb40ba51aa91e0aa",
        id: "step-1",
        memoized: false,
        name: "step-1",
        stepKind: "run",
      },
      runInfo: expect.any(Object),
    },
    {
      stepInfo: {
        hashedId: "35dd79ec13c32423d7f10672e0a0542d707657d8",
        id: "step-1-new",
        memoized: false,
        name: "step-1-new",
        stepKind: "run",
      },
      runInfo: expect.any(Object),
    },
  ]);
});

test("prepend step.sleep", async () => {
  // Run a step before the one in the Inngest function

  const state = {
    done: false,
    onStepStartCalls: [] as Middleware.OnStepStartArgs[],
    prependStep: {
      insideCount: 0,
      output: 0,
    },
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onStepStart(arg: Middleware.OnStepStartArgs) {
      state.onStepStartCalls.push(arg);
    }

    override transformStepInput(arg: Middleware.TransformStepInputArgs) {
      if (arg.stepInfo.id.endsWith("-prepend")) {
        return arg;
      }

      const prependStepId = arg.stepInfo.id + "-prepend";

      return {
        ...arg,
        handler: async () => {
          state.prependStep.output = await arg.runInfo.step.run(
            prependStepId,
            async () => {
              state.prependStep.insideCount++;
              return state.prependStep.insideCount;
            },
          );
          return arg.handler();
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
      await step.sleep("zzz", "1s");
      state.done = true;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);

  expect(state.prependStep).toEqual({
    insideCount: 1,
    output: 1,
  });
});

test.only("prepend step.run", async () => {
  // Run a step before the one in the Inngest function

  const state = {
    done: false,
    onStepStartCalls: [] as Middleware.OnStepStartArgs[],
    normalStep: {
      insideCount: 0,
      output: 0,
    },
    prependStep: {
      insideCount: 0,
      output: 0,
    },
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onStepStart(arg: Middleware.OnStepStartArgs) {
      state.onStepStartCalls.push(arg);
    }

    override transformStepInput(arg: Middleware.TransformStepInputArgs) {
      if (arg.stepInfo.id.endsWith("-prepend")) {
        return arg;
      }

      const prependStepId = arg.stepInfo.id + "-prepend";

      return {
        ...arg,
        handler: async () => {
          state.prependStep.output = await arg.runInfo.step.run(
            prependStepId,
            async () => {
              state.prependStep.insideCount++;
              return state.prependStep.insideCount;
            },
          );
          return arg.handler();
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
      state.normalStep.output = await step.run("step-1", () => {
        state.normalStep.insideCount++;
        return state.normalStep.insideCount;
      });
      state.done = true;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);

  expect(state.normalStep).toEqual({
    insideCount: 1,
    output: 1,
  });
  expect(state.prependStep).toEqual({
    insideCount: 1,
    output: 1,
  });
});

// Add these tests later:
// - Change input for all step kinds
