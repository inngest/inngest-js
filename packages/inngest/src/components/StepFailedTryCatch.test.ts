import { ServerTiming } from "../helpers/ServerTiming.ts";
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
      timer: new ServerTiming(),
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
      timer: new ServerTiming(),
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
      timer: new ServerTiming(),
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
