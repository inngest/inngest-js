import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../index.ts";
import { createTestApp } from "../../devServerTestHarness.ts";
import { randomSuffix, testNameFromFileUrl } from "../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("modify event data", async () => {
  // Inject additional data into the event and verify that the function received
  // the modified data

  const state = {
    done: false,
    receivedEventData: null as unknown,
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override transformRunInput(arg: Middleware.TransformRunInputArgs) {
      return {
        ...arg,
        runInfo: {
          ...arg.runInfo,
          event: {
            ...arg.runInfo.event,
            data: {
              ...arg.runInfo.event.data,
              injected: "value",
            },
          },
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
    async ({ event }) => {
      state.receivedEventData = event.data;
      state.done = true;
      return "done";
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName, data: { original: "data" } });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);

  // Verify the function received the modified event data
  expect(state.receivedEventData).toEqual({
    injected: "value",
    original: "data",
  });
});

test("modify memoized step data", async () => {
  // Transform all memoized step data and verify that the function received the
  // transformed data

  const state = {
    done: false,
    stepOutputs: [] as unknown[],
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override transformRunInput(arg: Middleware.TransformRunInputArgs) {
      // Transform all memoized step data
      const transformedSteps = { ...arg.runInfo.steps };
      for (const [id, stepData] of Object.entries(transformedSteps)) {
        if (stepData && stepData.type === "data") {
          transformedSteps[id] = {
            type: "data",
            data: "transformed",
          };
        }
      }

      return {
        ...arg,
        runInfo: {
          ...arg.runInfo,
          steps: transformedSteps,
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
      const output = await step.run("my-step", () => {
        return "original";
      });
      state.stepOutputs.push(output);
      state.done = true;
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);

  // The function received "transformed" (the value after middleware
  // modification)
  expect(state.stepOutputs).toEqual(["transformed"]);
});

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
    override transformRunInput(arg: Middleware.TransformRunInputArgs) {
      return {
        ...arg,
        handler: async () => {
          state.logs.push("mw1: before handler");
          const result = await arg.handler();
          state.logs.push("mw1: after handler");
          return result;
        },
      };
    }
  }

  class Mw2 extends Middleware.BaseMiddleware {
    override transformRunInput(arg: Middleware.TransformRunInputArgs) {
      return {
        ...arg,
        handler: async () => {
          state.logs.push("mw2: before handler");
          const result = await arg.handler();
          state.logs.push("mw2: after handler");
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
    async () => {
      state.logs.push("fn: top");
      state.done = true;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);

  // First middleware wraps second middleware, which wraps the function
  expect(state.logs).toEqual([
    "mw1: before handler",
    "mw2: before handler",
    "fn: top",
    "mw2: after handler",
    "mw1: after handler",
  ]);
});

test("dependency injection", async () => {
  // Inject a dependency

  class Database {}
  const db = new Database();

  const state = {
    done: false,
    db: undefined as Database | undefined,
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override transformRunInput(arg: Middleware.TransformRunInputArgs) {
      return {
        ...arg,
        runInfo: {
          ...arg.runInfo,
          db,
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
    async ({ db }) => {
      expectTypeOf(db).not.toBeAny();
      state.db = db;
      state.done = true;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName, data: { original: "data" } });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);

  expect(state.db).toEqual(db);
});

test("add step method", async () => {
  // Add a step method to the step tools

  const state = {
    done: false,
    stepOutputs: [] as string[],
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override transformRunInput(arg: Middleware.TransformRunInputArgs) {
      return {
        ...arg,
        runInfo: {
          ...arg.runInfo,
          step: {
            ...arg.runInfo.step,
            myStep: (id: string) => arg.runInfo.step.run(id, () => "result"),
          },
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
      state.stepOutputs.push(
        await step.run("my-step", () => {
          return "original";
        }),
      );
      state.done = true;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName, data: { original: "data" } });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);

  expect(state.stepOutputs).toEqual(["original"]);
});
