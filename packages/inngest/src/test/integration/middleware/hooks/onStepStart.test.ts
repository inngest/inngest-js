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
        hookArgs: [] as Middleware.OnStepStartArgs[],
      });

      class TestMiddleware extends Middleware.BaseMiddleware {
        readonly id = "test";
        override onStepStart(args: Middleware.OnStepStartArgs) {
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
          await step.run("my-step", () => "result");
        },
      );
      await createTestApp({ client, functions: [fn] });

      await client.send({ name: eventName });
      await state.waitForRunComplete();

      expect(state.hookArgs).toEqual([
        {
          ctx: anyContext,
          functionInfo: { id: "fn" },
          stepInfo: {
            hashedId: "8376129f22207d6e1acaa1c92de099dcb1ba24db",
            input: undefined,
            memoized: false,
            options: { id: "my-step", name: "my-step" },
            stepType: "run",
          },
        },
      ]);
    });
  }
});

test("1 step", async () => {
  const state = createState({
    logs: [] as string[],
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    readonly id = "test";
    override onStepStart() {
      state.logs.push("mw");
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
      state.logs.push("fn: top");
      await step.run("my-step", () => {
        state.logs.push("step: inside");
        return "result";
      });
      state.logs.push("fn: bottom");
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.logs).toEqual([
    // 1st request (fresh execution)
    "fn: top",
    "mw",
    "step: inside",

    // 2nd request (memoized - onStepStart NOT called)
    "fn: top",
    "fn: bottom",
  ]);
});

test("multiple steps", async () => {
  const state = createState({
    onStepStartCalls: [] as Middleware.OnStepStartArgs[],
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    readonly id = "test";
    override onStepStart(args: Middleware.OnStepStartArgs) {
      state.onStepStartCalls.push(args);
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
      await step.run("step-1", () => "result1");
      await step.sendEvent("step-2", { name: randomSuffix("other-evt") });
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.onStepStartCalls).toHaveLength(2);
  expect(state.onStepStartCalls).toEqual([
    {
      ctx: anyContext,
      functionInfo: { id: "fn" },
      stepInfo: {
        hashedId: "cd59ee9a8137151d1499d3d2eb40ba51aa91e0aa",
        input: undefined,
        memoized: false,
        options: { id: "step-1", name: "step-1" },
        stepType: "run",
      },
    },
    {
      ctx: anyContext,
      functionInfo: { id: "fn" },
      stepInfo: {
        hashedId: "e64b25e67dec6c8d30e63029286ad7b6d263931d",
        input: undefined,
        memoized: false,
        options: { id: "step-2", name: "step-2" },
        stepType: "sendEvent",
      },
    },
  ]);
});

test("unsupported step kinds", async () => {
  const state = createState({
    count: 0,
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    readonly id = "test";
    override onStepStart() {
      state.count++;
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
      await step.invoke("invoke", { function: childFn });
      await step.sleep("sleep", "1s");
      await step.waitForEvent("waitForEvent", {
        event: randomSuffix("never"),
        timeout: "1s",
      });
    },
  );
  const childFn = client.createFunction(
    { id: "child-fn", retries: 0 },
    () => {},
  );

  await createTestApp({ client, functions: [fn, childFn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();
  expect(state.count).toEqual(0);
});

test("throws", async () => {
  const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  const state = createState({
    hook: { count: 0 },
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    readonly id = "test";
    override onStepStart() {
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
  expect(consoleSpy).toHaveBeenCalledWith("middleware error");
  expect(consoleSpy).toHaveBeenCalledWith(expect.any(Error));
  expect(consoleSpy).toHaveBeenCalledWith({
    hook: "onStepStart",
    mw: "TestMiddleware",
  });

  consoleSpy.mockRestore();
});
