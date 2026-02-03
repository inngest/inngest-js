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
    override transformRun(
      handler: () => Promise<unknown>,
      runInfo: Middleware.RunInfo,
    ) {
      runInfo.event = {
        ...runInfo.event,
        data: {
          ...runInfo.event.data,
          injected: "value",
        },
      };
      return handler();
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
    override transformRun(
      handler: () => Promise<unknown>,
      runInfo: Middleware.RunInfo,
    ) {
      // Transform all memoized step data
      for (const [id, stepData] of Object.entries(runInfo.steps)) {
        if (stepData && stepData.type === "data") {
          (runInfo.steps as Record<string, { type: "data"; data: unknown }>)[
            id
          ] = {
            type: "data",
            data: "transformed",
          };
        }
      }

      return handler();
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
  // Verify that middleware are called in the correct order. We expect treat
  // middleware as a "stack":
  // - Before the handler, 1st middleware before 2nd middleware
  // - After the handler, 2nd middleware before 1st middleware

  const state = {
    done: false,
    logs: [] as string[],
  };

  class Mw1 extends Middleware.BaseMiddleware {
    override async transformRun(handler: () => Promise<unknown>) {
      state.logs.push("mw1: before handler");
      const result = await handler();
      state.logs.push("mw1: after handler");
      return result;
    }
  }

  class Mw2 extends Middleware.BaseMiddleware {
    override async transformRun(handler: () => Promise<unknown>) {
      state.logs.push("mw2: before handler");
      const result = await handler();
      state.logs.push("mw2: after handler");
      return result;
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
