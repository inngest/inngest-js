import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../index.ts";
import { createTestApp } from "../../devServerTestHarness.ts";
import { randomSuffix, testNameFromFileUrl } from "../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

class MyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

test("1 step", async () => {
  const state = {
    done: false,
    calls: [] as [Middleware.RunInfo, Middleware.StepInfo, Error][],
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onStepError(
      runInfo: Middleware.RunInfo,
      stepInfo: Middleware.StepInfo,
      error: Error,
    ) {
      state.calls.push([runInfo, stepInfo, error]);
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
        await step.run("my-step", () => {
          throw new MyError("my error");
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
      expect.any(MyError),
    ],
  ]);
  const error = state.calls[0]![2];
  expect(error.name).toBe("MyError");
  expect(error.message).toBe("my error");
});

test("multiple steps with errors", async () => {
  const state = {
    done: false,
    calls: [] as [Middleware.RunInfo, Middleware.StepInfo, Error][],
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onStepError(
      runInfo: Middleware.RunInfo,
      stepInfo: Middleware.StepInfo,
      error: Error,
    ) {
      state.calls.push([runInfo, stepInfo, error]);
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
        await step.run("step-1", () => {
          throw new MyError("error 1");
        });
      } catch {}

      try {
        await step.run("step-2", () => {
          throw new MyError("error 2");
        });
      } catch {}

      state.done = true;
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 10_000);

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
      expect.any(Error),
    ],
    [
      {
        ...expectedRunInfo,
        steps: {
          cd59ee9a8137151d1499d3d2eb40ba51aa91e0aa: {
            error: {
              message: "error 1",
              name: "MyError",
              stack: expect.any(String),
            },
            type: "error",
          },
        },
      },
      {
        hashedId: "e64b25e67dec6c8d30e63029286ad7b6d263931d",
        id: "step-2",
        memoized: false,
        name: "step-2",
        stepKind: "run",
      },
      expect.any(Error),
    ],
  ]);

  const step1Error = state.calls[0]![2];
  expect(step1Error.message).toBe("error 1");
  expect(step1Error.name).toBe("MyError");

  const step2Error = state.calls[1]![2];
  expect(step2Error.message).toBe("error 2");
  expect(step2Error.name).toBe("MyError");
});

test.only("no errors", async () => {
  const state = {
    count: 0,
    done: false,
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onStepError(
      runInfo: Middleware.RunInfo,
      stepInfo: Middleware.StepInfo,
      error: Error,
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
      await step.run("step-1", () => "success");
      state.done = true;
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);
  expect(state.count).toEqual(0);
});
