import { describe, expect, test } from "vitest";
import { Inngest, InngestMiddlewareV2, type StepInfo } from "../../../index.ts";
import { createTestApp } from "../../devServerTestHarness.ts";
import {
  assertStepError,
  randomSuffix,
  testNameFromFileUrl,
} from "../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("success", async () => {
  const state = {
    logs: [] as string[],
    outputsInsideMiddleware: [] as unknown[],
    outputsFromStep: [] as string[],
  };

  class TestMiddleware extends InngestMiddlewareV2 {
    override async transformStep(handler: () => unknown, stepInfo: StepInfo) {
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
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await vitest.waitFor(async () => {
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
  }, 5000);

  expect(state.outputsInsideMiddleware).toEqual([
    // 1st request
    "original",

    // 2nd request (memoized)
    "transformed",
  ]);
  expect(state.outputsFromStep).toEqual(["transformed"]);
});

test("error", async () => {
  const state = {
    errorsOutsideStep: [] as unknown[],
    errorsInsideMiddleware: [] as unknown[],
    logs: [] as string[],
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

  class TestMiddleware extends InngestMiddlewareV2 {
    override async transformStep(
      handler: () => unknown,
      { memoized }: StepInfo,
    ) {
      try {
        state.logs.push("mw: before");
        const output = await handler();

        // Unreachable, but we'll still write the log push code to verify
        // later in assertions
        state.logs.push("mw: after");
        return output;
      } catch (error) {
        state.logs.push("mw: error");

        if (!memoized) {
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

  expect(state.errorsInsideMiddleware).length(3);

  // In middleware, the first 2 errors are TransformedError (from requests 1
  // and 2)
  for (const error of state.errorsInsideMiddleware.slice(0, 2)) {
    expect(error).toBeInstanceOf(TransformedError);
    const tError = error as TransformedError;
    expect(tError.message).toBe("transformed");
    expect(tError.name).toBe("TransformedError");
    expect(tError.cause).toBeInstanceOf(OriginalError);
    const cause = tError.cause as OriginalError;
    expect(cause.message).toBe("original");
    expect(cause.name).toBe("OriginalError");
  }

  const expectedStepError = {
    cause: {
      message: "original",
      name: "OriginalError",
    },
    message: "transformed",
    name: "TransformedError",
  };

  // In middleware, the 3rd error is the memoized StepError (from request 3)
  assertStepError(state.errorsInsideMiddleware[2], expectedStepError);

  // In the function handler, the error is the memoized StepError
  expect(state.errorsOutsideStep).length(1);
  assertStepError(state.errorsOutsideStep[0], expectedStepError);
});
