import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../index.ts";
import { createTestApp } from "../../devServerTestHarness.ts";
import { randomSuffix, testNameFromFileUrl } from "../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("1 step", async () => {
  const state = {
    done: false,
    onStepStartCalls: [] as [Middleware.RunInfo, Middleware.StepInfo][],
    logs: [] as string[],
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onStepStart(
      runInfo: Middleware.RunInfo,
      stepInfo: Middleware.StepInfo,
    ) {
      state.onStepStartCalls.push([runInfo, stepInfo]);
      state.logs.push("mw");
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
      state.done = true;
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);

  expect(state.logs).toEqual([
    // 1st request (fresh execution)
    "fn: top",
    "mw",
    "step: inside",

    // 2nd request (memoized - onStepStart NOT called)
    "fn: top",
    "fn: bottom",
  ]);

  const expectedEvent = {
    data: {},
    id: expect.any(String),
    name: eventName,
    ts: expect.any(Number),
    user: {},
  };
  const expectedRunInfo = {
    attempt: 0,
    event: expectedEvent,
    events: [expectedEvent],
    runId: expect.any(String),
    steps: {},
  };

  // onStepStart called exactly once (only on fresh execution)
  expect(state.onStepStartCalls).toHaveLength(1);
  expect(state.onStepStartCalls[0]).toEqual([
    expectedRunInfo,
    {
      hashedId: "8376129f22207d6e1acaa1c92de099dcb1ba24db",
      id: "my-step",
      memoized: false,
      name: "my-step",
      stepKind: "run",
    },
  ]);
});

test("multiple steps", async () => {
  const state = {
    done: false,
    onStepStartCalls: [] as [Middleware.RunInfo, Middleware.StepInfo][],
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onStepStart(
      runInfo: Middleware.RunInfo,
      stepInfo: Middleware.StepInfo,
    ) {
      state.onStepStartCalls.push([runInfo, stepInfo]);
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
      await step.sendEvent("step-2", { name: randomSuffix("other-evt") });
      state.done = true;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);

  const expectedEvent = {
    data: {},
    id: expect.any(String),
    name: eventName,
    ts: expect.any(Number),
    user: {},
  };
  const expectedRunInfo = {
    attempt: 0,
    event: expectedEvent,
    events: [expectedEvent],
    runId: expect.any(String),
    steps: {},
  };

  expect(state.onStepStartCalls).toHaveLength(2);
  expect(state.onStepStartCalls).toEqual([
    [
      expectedRunInfo,
      {
        hashedId: "cd59ee9a8137151d1499d3d2eb40ba51aa91e0aa",
        id: "step-1",
        memoized: false,
        name: "step-1",
        stepKind: "run",
      },
    ],
    [
      {
        ...expectedRunInfo,
        steps: {
          cd59ee9a8137151d1499d3d2eb40ba51aa91e0aa: {
            data: "result1",
            type: "data",
          },
        },
      },
      {
        hashedId: "e64b25e67dec6c8d30e63029286ad7b6d263931d",
        id: "step-2",
        memoized: false,
        name: "step-2",
        stepKind: "sendEvent",
      },
    ],
  ]);
});

test("unsupported step kinds", async () => {
  const state = {
    count: 0,
    done: false,
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onStepStart(
      runInfo: Middleware.RunInfo,
      stepInfo: Middleware.StepInfo,
    ) {
      state.count++;
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
      await step.invoke("invoke", { function: childFn });
      await step.sleep("sleep", "1s");
      await step.waitForEvent("waitForEvent", {
        event: randomSuffix("never"),
        timeout: "1s",
      });
      state.done = true;
    },
  );
  const childFn = client.createFunction(
    { id: "child-fn", retries: 0 },
    [],
    () => {},
  );

  await createTestApp({ client, functions: [fn, childFn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 10_000);
  expect(state.count).toEqual(0);
});
