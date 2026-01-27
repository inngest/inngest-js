import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../index.ts";
import { createTestApp } from "../../devServerTestHarness.ts";
import { randomSuffix, testNameFromFileUrl, waitFor } from "../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("modify event data", async () => {
  // Inject additional data into the event and verify that the function received
  // the modified data

  const state = {
    done: false,
    receivedEventData: null as unknown,
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override transformFunctionInput(
      arg: Middleware.TransformFunctionInputArgs,
    ) {
      return {
        ...arg,
        ctx: {
          ...arg.ctx,
          event: {
            ...arg.ctx.event,
            data: {
              ...arg.ctx.event.data,
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
    middleware: [TestMiddleware],
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
  await waitFor(async () => {
    expect(state.done).toBe(true);
  });

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
    override transformFunctionInput(
      arg: Middleware.TransformFunctionInputArgs,
    ) {
      // Transform all memoized step data
      const transformedSteps = { ...arg.steps };
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
        steps: transformedSteps,
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
      const output = await step.run("my-step", () => {
        return "original";
      });
      state.stepOutputs.push(output);
      state.done = true;
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await waitFor(async () => {
    expect(state.done).toBe(true);
  });

  // The function received "transformed" (the value after middleware
  // modification)
  expect(state.stepOutputs).toEqual(["transformed"]);
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
    override transformFunctionInput(
      arg: Middleware.TransformFunctionInputArgs,
    ) {
      return {
        ...arg,
        ctx: {
          ...arg.ctx,
          db,
        },
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
    async ({ db }) => {
      expectTypeOf(db).not.toBeAny();
      expectTypeOf(db).toEqualTypeOf<Database>();
      state.db = db;
      state.done = true;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName, data: { original: "data" } });
  await waitFor(async () => {
    expect(state.done).toBe(true);
  });

  expect(state.db).toEqual(db);
});

test("add step method", async () => {
  // Add a step method to the step tools

  const state = {
    done: false,
    stepOutputs: [] as string[],
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override transformFunctionInput(
      arg: Middleware.TransformFunctionInputArgs,
    ) {
      return {
        ...arg,
        ctx: {
          ...arg.ctx,
          step: {
            ...arg.ctx.step,
            myStep: (id: string) => arg.ctx.step.run(id, () => "result"),
          },
        },
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
  await waitFor(async () => {
    expect(state.done).toBe(true);
  });

  expect(state.stepOutputs).toEqual(["original"]);
});
