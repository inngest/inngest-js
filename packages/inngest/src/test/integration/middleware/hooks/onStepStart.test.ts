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
    onStepStartCalls: [] as Middleware.OnStepStartArgs[],
    logs: [] as string[],
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onStepStart(args: Middleware.OnStepStartArgs) {
      state.onStepStartCalls.push(args);
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
    { id: "fn", retries: 0 },
    { event: eventName },
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

  expect(state.onStepStartCalls).toEqual([
    {
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
    onStepStartCalls: [] as Middleware.OnStepStartArgs[],
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
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
    { id: "fn", retries: 0 },
    { event: eventName },
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
      stepInfo: {
        hashedId: "cd59ee9a8137151d1499d3d2eb40ba51aa91e0aa",
        input: undefined,
        memoized: false,
        options: { id: "step-1", name: "step-1" },
        stepKind: "run",
      },
    },
    {
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

test("unsupported step kinds", async () => {
  const state = createState({
    count: 0,
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
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
    { id: "fn", retries: 0 },
    { event: eventName },
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
    [],
    () => {},
  );

  await createTestApp({ client, functions: [fn, childFn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();
  expect(state.count).toEqual(0);
});
