import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../index.ts";
import { createTestApp } from "../../devServerTestHarness.ts";
import { randomSuffix, testNameFromFileUrl } from "../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("1 step", async () => {
  const state = {
    calls: [] as [Middleware.RunInfo, Middleware.StepInfo, unknown][],
    done: false,
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onStepEnd(
      runInfo: Middleware.RunInfo,
      stepInfo: Middleware.StepInfo,
      data: unknown,
    ) {
      state.calls.push([runInfo, stepInfo, data]);
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
      await step.run("my-step", () => {
        return "step result";
      });
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
  expect(state.calls).toEqual([
    [
      expectedRunInfo,
      {
        hashedId: "8376129f22207d6e1acaa1c92de099dcb1ba24db",
        id: "my-step",
        memoized: false,
        name: "my-step",
        stepKind: "run",
      },
      "step result",
    ],
  ]);
});

test("multiple steps", async () => {
  const state = {
    calls: [] as [Middleware.RunInfo, Middleware.StepInfo, unknown][],
    done: false,
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onStepEnd(
      runInfo: Middleware.RunInfo,
      stepInfo: Middleware.StepInfo,
      data: unknown,
    ) {
      state.calls.push([runInfo, stepInfo, data]);
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
      await step.run("step-1", () => "result 1");
      await step.sendEvent("step-2", { name: "test-event", data: {} });
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
  expect(state.calls).toEqual([
    [
      expectedRunInfo,
      {
        hashedId: "cd59ee9a8137151d1499d3d2eb40ba51aa91e0aa",
        id: "step-1",
        memoized: false,
        name: "step-1",
        stepKind: "run",
      },
      "result 1",
    ],
    [
      {
        ...expectedRunInfo,
        steps: {
          cd59ee9a8137151d1499d3d2eb40ba51aa91e0aa: {
            data: "result 1",
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
      { ids: expect.any(Array) },
    ],
  ]);
});

test("step error does not call onStepEnd", async () => {
  const state = {
    done: false,
    endCalls: 0,
    errorCalls: 0,
  };

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
    middlewareV2: [new TestMiddleware()],
  });

  const fn = client.createFunction(
    { id: "fn", retries: 0 },
    { event: eventName },
    async ({ step }) => {
      try {
        await step.run("failing-step", () => {
          throw new Error("step failed");
        });
      } catch {}
      state.done = true;
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);

  expect(state.endCalls).toBe(0);
  expect(state.errorCalls).toBe(1);
});

test("memoized step does not call onStepEnd", async () => {
  const state = {
    done: false,
    endCalls: 0,
    transformCalls: 0,
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onStepEnd() {
      state.endCalls++;
    }
    override async transformStep() {
      state.transformCalls++;
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
      // First step will be executed, then memoized on second run
      await step.run("step-1", () => "result 1");
      // Second step triggers a new run where step-1 is memoized
      await step.run("step-2", () => "result 2");
      state.done = true;
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);

  // onStepEnd should be called exactly twice (once per fresh execution)
  // transformStep is called for each step on each invocation:
  // - Invocation 1: step-1 fresh (1)
  // - Invocation 2: step-1 memoized (2), step-2 fresh (3)
  // - Invocation 3: step-1 memoized (4), step-2 memoized (5)
  expect(state.endCalls).toBe(2);
  expect(state.transformCalls).toBe(5);
});
