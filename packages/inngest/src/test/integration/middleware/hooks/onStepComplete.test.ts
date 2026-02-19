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

describe("args", () => {
  for (const level of ["client", "function"] as const) {
    test(`level: ${level}`, async () => {
      const state = createState({
        hookArgs: [] as Middleware.OnStepCompleteArgs[],
      });

      class TestMiddleware extends Middleware.BaseMiddleware {
        override onStepComplete(args: Middleware.OnStepCompleteArgs) {
          state.hookArgs.push(args);
        }
      }

      let clientMiddleware: Middleware.Class[] = [];
      let functionMiddleware: Middleware.Class[] = [];
      if (level === "client") {
        clientMiddleware = [TestMiddleware];
      } else {
        functionMiddleware = [TestMiddleware];
      }

      const eventName = randomSuffix("evt");
      const client = new Inngest({
        id: randomSuffix(testFileName),
        isDev: true,
        middleware: clientMiddleware,
      });
      const fn = client.createFunction(
        {
          id: "fn",
          retries: 0,
          middleware: functionMiddleware,
          triggers: [{ event: eventName }],
        },
        async ({ step, runId }) => {
          state.runId = runId;
          await step.run("my-step", () => "step result");
        },
      );
      await createTestApp({ client, functions: [fn] });

      await client.send({ name: eventName });
      await state.waitForRunComplete();

      expect(state.hookArgs).toEqual([
        {
          output: "step result",
          ctx: anyContext,
          functionInfo: { id: "fn" },
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
  }
});

test("multiple steps", async () => {
  const state = createState({
    calls: [] as Middleware.OnStepCompleteArgs[],
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onStepComplete(args: Middleware.OnStepCompleteArgs) {
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
    {
      id: "fn",
      retries: 0,
      triggers: [{ event: eventName }],
    },
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
      output: "result 1",
      ctx: anyContext,
      functionInfo: { id: "fn" },
      stepInfo: {
        hashedId: "cd59ee9a8137151d1499d3d2eb40ba51aa91e0aa",
        input: undefined,
        memoized: false,
        options: { id: "step-1", name: "step-1" },
        stepKind: "run",
      },
    },
    {
      output: { ids: expect.any(Array) },
      ctx: anyContext,
      functionInfo: { id: "fn" },
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

test("step error does not call onStepComplete", async () => {
  const state = createState({
    endCalls: 0,
    errorCalls: 0,
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onStepComplete() {
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
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
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

test("memoized step does not call onStepComplete", async () => {
  const state = createState({
    calls: 0,
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onStepComplete() {
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
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
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

test("throws", async () => {
  const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  const state = createState({
    hook: { count: 0 },
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onStepComplete() {
      state.hook.count++;
      throw new Error("oh no");
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
      await step.run("my-step", () => "result");
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.hook).toEqual({ count: 1 });
  expect(consoleSpy).toHaveBeenCalledWith("middleware error", {
    error: expect.any(Error),
    hook: "onStepComplete",
    mw: "TestMiddleware",
  });

  consoleSpy.mockRestore();
});
