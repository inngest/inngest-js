import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../../index.ts";
import { createTestApp } from "../../../devServerTestHarness.ts";
import {
  anyContext,
  createState,
  randomSuffix,
  testNameFromFileUrl,
} from "../../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("1 step", async () => {
  const state = createState({
    calls: [] as Middleware.OnStepEndArgs[],
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onStepEnd(args: Middleware.OnStepEndArgs) {
      state.calls.push(args);
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
    async ({ step, runId }) => {
      state.runId = runId;
      await step.run("my-step", () => {
        return "step result";
      });
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.calls).toEqual([
    {
      data: "step result",
      ctx: anyContext,
      stepInfo: {
        hashedId: "8376129f22207d6e1acaa1c92de099dcb1ba24db",
        input: undefined,
        memoized: false,
        options: { id: "my-step", name: "my-step" },
        stepKind: "run",
      },
    },
  ]);
});

test("multiple steps", async () => {
  const state = createState({
    calls: [] as Middleware.OnStepEndArgs[],
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onStepEnd(args: Middleware.OnStepEndArgs) {
      state.calls.push(args);
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
    async ({ step, runId }) => {
      state.runId = runId;
      await step.run("step-1", () => "result 1");
      await step.sendEvent("step-2", { name: "test-event", data: {} });
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.calls).toEqual([
    {
      data: "result 1",
      ctx: anyContext,
      stepInfo: {
        hashedId: "cd59ee9a8137151d1499d3d2eb40ba51aa91e0aa",
        input: undefined,
        memoized: false,
        options: { id: "step-1", name: "step-1" },
        stepKind: "run",
      },
    },
    {
      data: { ids: expect.any(Array) },
      ctx: anyContext,
      stepInfo: {
        hashedId: "e64b25e67dec6c8d30e63029286ad7b6d263931d",
        input: undefined,
        memoized: false,
        options: { id: "step-2", name: "step-2" },
        stepKind: "sendEvent",
      },
    },
  ]);
});

test("step error does not call onStepEnd", async () => {
  const state = createState({
    endCalls: 0,
    errorCalls: 0,
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onStepEnd() {
      state.endCalls++;
    }
    override onStepError() {
      state.errorCalls++;
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
    async ({ step, runId }) => {
      state.runId = runId;
      try {
        await step.run("failing-step", () => {
          throw new Error("step failed");
        });
      } catch {}
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.endCalls).toBe(0);
  expect(state.errorCalls).toBe(1);
});

test("memoized step does not call onStepEnd", async () => {
  const state = createState({
    calls: 0,
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onStepEnd() {
      state.calls++;
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
    async ({ step, runId }) => {
      state.runId = runId;
      // First step will be executed, then memoized on second run
      await step.run("step-1", () => "result 1");
      // Second step triggers a new run where step-1 is memoized
      await step.run("step-2", () => "result 2");
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.calls).toBe(2);
});
