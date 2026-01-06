import { StepMode, StepOpCode } from "../types";
import {
  createV1InngestExecution,
  _internals as v1Internals,
} from "./execution/v1";
import { Inngest } from "./Inngest";
import type { InngestFunction } from "./InngestFunction";
import { NonRetriableError } from "./NonRetriableError";

describe("StepFailed OpCode with try/catch", () => {
  const inngest = new Inngest({ id: "test" });

  test("step that throws NonRetriableError should be catchable in try/catch", async () => {
    let caughtError = false;

    const fn = inngest.createFunction(
      { id: "test-step-failed-try-catch", retries: 1 },
      { event: "test/event" },
      async ({ step }) => {
        try {
          await step.run("failing-step", () => {
            throw new NonRetriableError("This should be caught");
          });
          return "This shouldn't be returned";
        } catch {
          caughtError = true;
          return "Gracefully handled error!";
        }
      },
    );

    // Simulate memoized step state with a failed step
    const stepHashedId = v1Internals.hashId("failing-step");
    const execution = createV1InngestExecution({
      client: inngest,
      fn: fn as InngestFunction.Any,
      data: {
        event: { name: "test/event", data: {} },
        events: [{ name: "test/event", data: {} }],
        runId: "test-run",
        attempt: 0,
      },
      stepState: {
        [stepHashedId]: {
          id: stepHashedId,
          data: undefined,
          error: {
            name: "NonRetriableError",
            message: "This should be caught",
            stack: "NonRetriableError: This should be caught",
          },
          seen: false,
          fulfilled: false,
        },
      },
      stepCompletionOrder: [stepHashedId],
      reqArgs: [],
      isFailureHandler: false,
      runId: "test-run",
      headers: {},
      stepMode: StepMode.Async,
    });

    const result = await execution.start();

    // The try/catch should work - the error should be caught and function should complete successfully
    expect(caughtError).toBe(true);
    expect(result.type).toBe("function-resolved");
    if (result.type === "function-resolved") {
      expect(result.data).toBe("Gracefully handled error!");
    }
  });

  test("step that exhausts retries should be catchable in try/catch", async () => {
    let caughtError = false;

    const fn = inngest.createFunction(
      { id: "test-max-attempts-try-catch", retries: 1 },
      { event: "test/event" },
      async ({ step, attempt: _attempt, maxAttempts: _maxAttempts }) => {
        try {
          await step.run("failing-step-2", () => {
            throw new Error("This should be caught after max attempts");
          });
          return "This shouldn't be returned";
        } catch {
          caughtError = true;
          return `Caught error at max attempts`;
        }
      },
    );

    // Simulate that we're at max attempts with a memoized failed step
    const stepHashedId = v1Internals.hashId("failing-step-2");
    const execution = createV1InngestExecution({
      client: inngest,
      fn: fn as InngestFunction.Any,
      data: {
        event: { name: "test/event", data: {} },
        events: [{ name: "test/event", data: {} }],
        runId: "test-run",
        attempt: 0,
        maxAttempts: 1,
      },
      stepState: {
        [stepHashedId]: {
          id: stepHashedId,
          data: undefined,
          error: {
            name: "Error",
            message: "This should be caught after max attempts",
            stack: "Error: This should be caught after max attempts",
          },
          seen: false,
          fulfilled: false,
        },
      },
      stepCompletionOrder: [stepHashedId],
      reqArgs: [],
      isFailureHandler: false,
      runId: "test-run",
      headers: {},
      stepMode: StepMode.Async,
    });

    const result = await execution.start();

    // The try/catch should work - the error should be caught
    expect(caughtError).toBe(true);
    expect(result.type).toBe("function-resolved");
    if (result.type === "function-resolved") {
      expect(result.data).toBe("Caught error at max attempts");
    }
  });

  test("data with name/message that is not a serialized error resolves on resume", async () => {
    const fn = inngest.createFunction(
      { id: "test-error-shaped-data", retries: 1 },
      { event: "test/event" },
      async ({ step }) => {
        // First call returns an object that looks error-ish but is not serialized
        const value = await step.run("error-shaped", () => {
          return { name: "Alice", message: "Hello" } as unknown;
        });
        return value;
      },
    );

    const stepHashedId = v1Internals.hashId("error-shaped");
    const execution = createV1InngestExecution({
      client: inngest,
      fn: fn as InngestFunction.Any,
      data: {
        event: { name: "test/event", data: {} },
        events: [{ name: "test/event", data: {} }],
        runId: "test-run",
        attempt: 0,
      },
      stepState: {
        [stepHashedId]: {
          id: stepHashedId,
          data: { name: "Alice", message: "Hello" },
          error: undefined,
          seen: false,
          fulfilled: false,
        },
      },
      stepCompletionOrder: [stepHashedId],
      reqArgs: [],
      isFailureHandler: false,
      runId: "test-run",
      headers: {},
      stepMode: StepMode.Async,
    });

    const result = await execution.start();
    if (result.type === "function-resolved") {
      expect(result.data).toEqual({ name: "Alice", message: "Hello" });
    } else if (result.type === "step-ran") {
      expect(result.step.data).toEqual({ name: "Alice", message: "Hello" });
    } else {
      throw new Error(`Unexpected result type: ${result.type}`);
    }
  });
});

describe("Step retry behavior with cached errors", () => {
  const inngest = new Inngest({ id: "test" });

  test("step with cached error re-runs when retries remaining", async () => {
    let stepRunCount = 0;

    const fn = inngest.createFunction(
      { id: "test-step-retry", retries: 3 },
      { event: "test/event" },
      async ({ step }) => {
        const result = await step.run("retrying-step", () => {
          stepRunCount++;
          return "success on retry";
        });
        return result;
      },
    );

    // Simulate cached error state with retries remaining (attempt 0, maxAttempts 3)
    const stepHashedId = v1Internals.hashId("retrying-step");
    const execution = createV1InngestExecution({
      client: inngest,
      fn: fn as InngestFunction.Any,
      data: {
        event: { name: "test/event", data: {} },
        events: [{ name: "test/event", data: {} }],
        runId: "test-run",
        attempt: 0,
        maxAttempts: 3,
      },
      stepState: {
        [stepHashedId]: {
          id: stepHashedId,
          data: undefined,
          error: {
            name: "Error",
            message: "Previous attempt failed",
            stack: "Error: Previous attempt failed",
          },
          seen: false,
          fulfilled: false,
        },
      },
      stepCompletionOrder: [stepHashedId],
      reqArgs: [],
      isFailureHandler: false,
      runId: "test-run",
      headers: {},
      stepMode: StepMode.Async,
    });

    const result = await execution.start();

    // Step should have been re-run
    expect(stepRunCount).toBe(1);
    expect(result.type).toBe("function-resolved");
    if (result.type === "function-resolved") {
      expect(result.data).toBe("success on retry");
    }
  });

  test("step with cached error throws when no retries remaining", async () => {
    let stepRunCount = 0;
    let caughtError: Error | undefined;

    const fn = inngest.createFunction(
      { id: "test-step-no-retry", retries: 1 },
      { event: "test/event" },
      async ({ step }) => {
        try {
          await step.run("final-attempt-step", () => {
            stepRunCount++;
            return "should not run";
          });
        } catch (err) {
          caughtError = err as Error;
          throw err;
        }
      },
    );

    // Simulate cached error state with NO retries remaining (attempt 0, maxAttempts 1)
    const stepHashedId = v1Internals.hashId("final-attempt-step");
    const execution = createV1InngestExecution({
      client: inngest,
      fn: fn as InngestFunction.Any,
      data: {
        event: { name: "test/event", data: {} },
        events: [{ name: "test/event", data: {} }],
        runId: "test-run",
        attempt: 0,
        maxAttempts: 1,
      },
      stepState: {
        [stepHashedId]: {
          id: stepHashedId,
          data: undefined,
          error: {
            name: "Error",
            message: "Final attempt failed",
            stack: "Error: Final attempt failed",
          },
          seen: false,
          fulfilled: false,
        },
      },
      stepCompletionOrder: [stepHashedId],
      reqArgs: [],
      isFailureHandler: false,
      runId: "test-run",
      headers: {},
      stepMode: StepMode.Async,
    });

    const result = await execution.start();

    // Step should NOT have been re-run - cached error should be thrown
    expect(stepRunCount).toBe(0);
    expect(caughtError).toBeDefined();
    expect(caughtError?.message).toBe("Final attempt failed");
    expect(result.type).toBe("function-rejected");
    if (result.type === "function-rejected") {
      expect(result.retriable).toBe(false);
    }
  });

  test("step error is retriable when not on final attempt", async () => {
    const fn = inngest.createFunction(
      { id: "test-retriable-error", retries: 3 },
      { event: "test/event" },
      async ({ step }) => {
        await step.run("failing-step", () => {
          throw new Error("Step failed");
        });
      },
    );

    const execution = createV1InngestExecution({
      client: inngest,
      fn: fn as InngestFunction.Any,
      data: {
        event: { name: "test/event", data: {} },
        events: [{ name: "test/event", data: {} }],
        runId: "test-run",
        attempt: 0,
        maxAttempts: 3,
      },
      stepState: {},
      stepCompletionOrder: [],
      reqArgs: [],
      isFailureHandler: false,
      runId: "test-run",
      headers: {},
      stepMode: StepMode.Async,
    });

    const result = await execution.start();

    expect(result.type).toBe("step-ran");
    if (result.type === "step-ran") {
      expect(result.step.op).toBe(StepOpCode.StepError);
    }
  });

  test("step error is non-retriable on final attempt", async () => {
    const fn = inngest.createFunction(
      { id: "test-final-attempt-error", retries: 3 },
      { event: "test/event" },
      async ({ step }) => {
        await step.run("failing-step", () => {
          throw new Error("Step failed");
        });
      },
    );

    // Final attempt: attempt 2, maxAttempts 3 (0-indexed, so attempt+1 >= maxAttempts)
    const execution = createV1InngestExecution({
      client: inngest,
      fn: fn as InngestFunction.Any,
      data: {
        event: { name: "test/event", data: {} },
        events: [{ name: "test/event", data: {} }],
        runId: "test-run",
        attempt: 2,
        maxAttempts: 3,
      },
      stepState: {},
      stepCompletionOrder: [],
      reqArgs: [],
      isFailureHandler: false,
      runId: "test-run",
      headers: {},
      stepMode: StepMode.Async,
    });

    const result = await execution.start();

    expect(result.type).toBe("step-ran");
    if (result.type === "step-ran") {
      expect(result.step.op).toBe(StepOpCode.StepFailed);
    }
  });
});
