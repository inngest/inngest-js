import { expect, test } from "vitest";
import { Inngest, InngestMiddlewareV2, type StepInfo } from "../../../index.ts";
import { createTestApp } from "../../devServerTestHarness.ts";
import { randomSuffix, testNameFromFileUrl } from "../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("called once per step", async () => {
  const state = {
    onStepStartCalls: [] as StepInfo[],
    logs: [] as string[],
  };

  class TestMiddleware extends InngestMiddlewareV2 {
    override onStepStart(stepInfo: StepInfo) {
      state.onStepStartCalls.push(stepInfo);
      state.logs.push(`onStepStart: ${stepInfo.id}`);
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
  await vitest.waitFor(async () => {
    expect(state.logs).toEqual([
      // 1st request (fresh execution)
      "fn: top",
      "onStepStart: my-step",
      "step: inside",

      // 2nd request (memoized - onStepStart NOT called)
      "fn: top",
      "fn: bottom",
    ]);
  }, 5000);

  // onStepStart called exactly once (only on fresh execution)
  expect(state.onStepStartCalls).toHaveLength(1);
  const firstCall = state.onStepStartCalls[0];
  expect(firstCall).toBeDefined();
  expect(firstCall).toMatchObject({
    id: "my-step",
    memoized: false,
    stepKind: "run",
    name: "my-step",
  });
  expect(firstCall?.hashedId).toBeDefined();
});

test("called for multiple steps", async () => {
  const state = {
    onStepStartCalls: [] as StepInfo[],
  };

  class TestMiddleware extends InngestMiddlewareV2 {
    override onStepStart(stepInfo: StepInfo) {
      state.onStepStartCalls.push(stepInfo);
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
      await step.run("step-1", () => "result1");
      await step.sendEvent("step-2", {name: randomSuffix("other-evt")});
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    // Each step's onStepStart called exactly once
    expect(state.onStepStartCalls).toHaveLength(2);
  }, 5000);
  expect(state.onStepStartCalls.map((s) => s.id)).toEqual([
    "step-1",
    "step-2",
  ]);
  expect(state.onStepStartCalls.map((s) => s.stepKind)).toEqual([
    "run",
    "sendEvent",
  ]);
  expect(state.onStepStartCalls.every((s) => s.memoized === false)).toBe(
    true,
  );
});
