import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../index.ts";
import { createTestApp } from "../../devServerTestHarness.ts";
import { randomSuffix, testNameFromFileUrl } from "../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("success", async () => {
  const state = {
    calls: [] as [Middleware.RunInfo, Middleware.StepInfo][],
    done: false,
    logs: [] as string[],
    outputsInsideMiddleware: [] as unknown[],
    outputsFromStep: [] as string[],
  };

  class TestMiddleware extends Middleware.BaseMiddleware {
    override async transformStep(
      handler: () => Promise<unknown>,
      runInfo: Middleware.RunInfo,
      stepInfo: Middleware.StepInfo,
    ) {
      state.calls.push([runInfo, stepInfo]);
      state.logs.push("mw handler: before");
      state.outputsInsideMiddleware.push(await handler());
      state.logs.push("mw handler: after");
      return "transformed";
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
      const output = await step.run("step", () => {
        state.logs.push("step handler: inside");
        return "original";
      });
      state.outputsFromStep.push(output);
      state.done = true;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.done).toBe(true);
  }, 5000);

  expect(state.logs).toEqual([
    // 1st request
    "fn: top",
    "mw handler: before",
    "step handler: inside",
    "mw handler: after",

    // 2nd request
    "fn: top",
    "mw handler: before",
    "mw handler: after",
  ]);
  expect(state.outputsInsideMiddleware).toEqual([
    // 1st request
    "original",

    // 2nd request (memoized)
    "transformed",
  ]);
  expect(state.outputsFromStep).toEqual(["transformed"]);

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
    // 1st call: not memoized
    [
      expectedRunInfo,
      {
        hashedId: expect.any(String),
        id: "step",
        memoized: false,
        name: "step",
        stepKind: "run",
      },
    ],

    // 2nd call: memoized
    [
      {
        ...expectedRunInfo,
        steps: {
          bd370d1b6f9b3580a77083b3ed3256c621f44a99: {
            data: "transformed",
            type: "data",
          },
        },
      },
      {
        hashedId: expect.any(String),
        id: "step",
        memoized: true,
        name: "step",
        stepKind: "run",
      },
    ],
  ]);
});

test("error", async () => {
  const state = {
    errorsOutsideStep: [] as unknown[],
    errorsInsideMiddleware: [] as unknown[],
    logs: [] as string[],
    calls: [] as [Middleware.RunInfo, Middleware.StepInfo][],
  };

  class OriginalError extends Error {
    constructor(message: string) {
      super(message);
      this.name = this.constructor.name;
    }
  }

  class TransformedError extends Error {
    constructor(...args: ConstructorParameters<typeof Error>) {
      super(...args);
      this.name = this.constructor.name;
    }
  }

  class TestMiddleware extends Middleware.BaseMiddleware {
    override async transformStep(
      handler: () => Promise<unknown>,
      runInfo: Middleware.RunInfo,
      stepInfo: Middleware.StepInfo,
    ) {
      state.calls.push([runInfo, stepInfo]);
      try {
        state.logs.push("mw: before");
        const output = await handler();

        // Unreachable, but we'll still write the log push code to verify
        // later in assertions
        state.logs.push("mw: after");
        return output;
      } catch (error) {
        state.logs.push("mw: error");

        if (!stepInfo.memoized) {
          // Only wrap the error if the step isn't memoized
          error = new TransformedError("transformed", { cause: error });
        }

        state.errorsInsideMiddleware.push(error);
        throw error;
      }
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middlewareV2: [new TestMiddleware()],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 1 },
    { event: eventName },
    async ({ step }) => {
      state.logs.push("fn: top");

      try {
        await step.run("step", () => {
          state.logs.push("step: inside");
          throw new OriginalError("original");
        });
        state.logs.push("step: after");
      } catch (error) {
        state.logs.push("step: error");
        state.errorsOutsideStep.push(error);
        throw error;
      }
    },
  );
  await createTestApp({ client, functions: [fn] });

  // Trigger and wait for completion
  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
    expect(state.logs).toEqual([
      // 1st request
      "fn: top",
      "mw: before",
      "step: inside",
      "mw: error",

      // 2nd request
      "fn: top",
      "mw: before",
      "step: inside",
      "mw: error",

      // 3rd request
      "fn: top",
      "mw: before",
      "mw: error",
      "step: error",
    ]);
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
    // 1st attempt
    [
      expectedRunInfo,
      {
        hashedId: expect.any(String),
        id: "step",
        memoized: false,
        name: "step",
        stepKind: "run",
      },
    ],

    // 2nd attempt
    [
      {
        ...expectedRunInfo,
        attempt: 1,
      },
      {
        hashedId: expect.any(String),
        id: "step",
        memoized: false,
        name: "step",
        stepKind: "run",
      },
    ],

    // `step.run` throws (since attempts exhausted)
    [
      {
        ...expectedRunInfo,
        steps: {
          bd370d1b6f9b3580a77083b3ed3256c621f44a99: {
            error: {
              cause: {
                message: "original",
                name: "OriginalError",
                stack: expect.any(String),
              },
              message: "transformed",
              name: "TransformedError",
              stack: expect.any(String),
            },
            type: "error",
          },
        },
      },
      {
        hashedId: expect.any(String),
        id: "step",
        memoized: true,
        name: "step",
        stepKind: "run",
      },
    ],
  ]);
});
