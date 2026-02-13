import { expect, test } from "vitest";
import { type Context, Inngest, Middleware } from "../../../../index.ts";
import { createTestApp } from "../../../devServerTestHarness.ts";
import { createState, randomSuffix, testNameFromFileUrl } from "../../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("same as ctx in function handler", async () => {
  // Inject additional data into the event and verify that the function received
  // the modified data

  const state = createState({
    fn: {
      ctx: null as Context.Any | null,
    },
    hook: {
      ctx: null as Context.Any | null,
    },
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    override transformFunctionInput(
      arg: Middleware.TransformFunctionInputArgs,
    ) {
      state.hook.ctx = arg.ctx;
      return arg;
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
    async (ctx) => {
      state.runId = ctx.runId;
      state.fn.ctx = ctx;
      return "done";
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName, data: { original: "data" } });
  await state.waitForRunComplete();

  // Verify the function received the modified event data
  expect(state.hook.ctx).toEqual(state.fn.ctx);
});

test("modify event data", async () => {
  // Inject additional data into the event and verify that the function received
  // the modified data

  const state = createState({
    receivedEventData: null as unknown,
  });

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
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ event, runId }) => {
      state.runId = runId;
      state.receivedEventData = event.data;
      return "done";
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName, data: { original: "data" } });
  await state.waitForRunComplete();

  // Verify the function received the modified event data
  expect(state.receivedEventData).toEqual({
    injected: "value",
    original: "data",
  });
});

test("modify memoized step data", async () => {
  // Transform all memoized step data and verify that the function received the
  // transformed data

  const state = createState({
    stepOutputs: [] as unknown[],
  });

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
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      state.runId = runId;
      const output = await step.run("my-step", () => {
        return "original";
      });
      state.stepOutputs.push(output);
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  // The function received "transformed" (the value after middleware
  // modification)
  expect(state.stepOutputs).toEqual(["transformed"]);
});

test("dependency injection", async () => {
  // Inject a dependency

  class Database {}
  const db = new Database();

  const state = createState({
    db: undefined as Database | undefined,
  });

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
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ db, runId }) => {
      state.runId = runId;
      expectTypeOf(db).not.toBeAny();
      expectTypeOf(db).toEqualTypeOf<Database>();
      state.db = db;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName, data: { original: "data" } });
  await state.waitForRunComplete();

  expect(state.db).toEqual(db);
});

test("add step method", async () => {
  // Add a step method to the step tools

  const state = createState({
    stepOutputs: [] as string[],
  });

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
            myStep: (id: string) => arg.ctx.step.run(id, () => "replaced"),
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
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      state.runId = runId;
      state.stepOutputs.push(
        await step.myStep("my-step"),
      );
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName, data: { original: "data" } });
  await state.waitForRunComplete();

  expect(state.stepOutputs).toEqual(["replaced"]);
});
