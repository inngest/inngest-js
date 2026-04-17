import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { InngestApi } from "../../api/api.ts";
import { ExecutionVersion } from "../../helpers/consts.ts";
import { createClient } from "../../test/helpers.ts";
import { StepMode, StepOpCode } from "../../types.ts";
import { InngestFunction } from "../InngestFunction.ts";
import type { ExecutionResults } from "./InngestExecution.ts";

describe("V1 checkpoint retry behavior", () => {
  const mockEvent = { name: "test/event", data: { foo: "bar" } };

  // Mock timers to speed up tests (avoid actual backoff delays)
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * Helper to advance timers through all retry delays.
   * retryWithBackoff uses: baseDelay * 2^(attempt-1) + jitter
   * With 5 attempts and 100ms base, max total delay is ~1.5-3s
   */
  const advanceThroughRetries = async () => {
    // Advance through potential retry delays (generous to cover jitter)
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }
  };

  describe("StepMode.Sync (Durable Endpoints)", () => {
    describe("checkpointNewRun (first checkpoint)", () => {
      test("retries on transient failure and succeeds", async () => {
        const client = createClient({ id: "test" });

        let callCount = 0;
        const mockCheckpointNewRun = vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount < 3) {
            throw new Error("Network error");
          }
          return {
            data: {
              app_id: "app-123",
              fn_id: "fn-456",
              token: "token-789",
            },
          };
        });

        // Mock the inngestApi on the client
        (client as unknown as { inngestApi: Partial<InngestApi> }).inngestApi =
          {
            checkpointNewRun: mockCheckpointNewRun,
          } as Partial<InngestApi> as InngestApi;

        const fn = new InngestFunction(
          client,
          { id: "test-fn", triggers: [{ event: "test/event" }] },
          async () => "result",
        );

        const execution = fn["createExecution"]({
          version: ExecutionVersion.V1,
          partialOptions: {
            client,
            data: fromPartial({ event: mockEvent }),
            runId: "test-run-id",
            stepState: {},
            stepCompletionOrder: [],
            reqArgs: [],
            headers: {},
            stepMode: StepMode.Sync,
            createResponse: async (data) => ({
              status: 200,
              body: JSON.stringify(data),
              headers: {},
              version: ExecutionVersion.V1,
            }),
          },
        });

        // Start execution and advance timers concurrently
        const executionPromise = execution.start();
        await advanceThroughRetries();
        const result = await executionPromise;

        // Should have retried and eventually succeeded
        expect(mockCheckpointNewRun).toHaveBeenCalledTimes(3);
        expect(result.type).toBe("function-resolved");
      });

      test("returns function-rejected after all retries exhausted (InngestCommHandler converts to 500)", async () => {
        const client = createClient({ id: "test" });

        const mockCheckpointNewRun = vi
          .fn()
          .mockRejectedValue(new Error("Server unreachable"));

        (client as unknown as { inngestApi: Partial<InngestApi> }).inngestApi =
          {
            checkpointNewRun: mockCheckpointNewRun,
          } as Partial<InngestApi> as InngestApi;

        const fn = new InngestFunction(
          client,
          { id: "test-fn", triggers: [{ event: "test/event" }] },
          async () => "result",
        );

        const execution = fn["createExecution"]({
          version: ExecutionVersion.V1,
          partialOptions: {
            client,
            data: fromPartial({ event: mockEvent }),
            runId: "test-run-id",
            stepState: {},
            stepCompletionOrder: [],
            reqArgs: [],
            headers: {},
            stepMode: StepMode.Sync,
            createResponse: async (data) => ({
              status: 200,
              body: JSON.stringify(data),
              headers: {},
              version: ExecutionVersion.V1,
            }),
          },
        });

        const executionPromise = execution.start();
        await advanceThroughRetries();
        const result = await executionPromise;

        // Should have attempted 5 retries (default maxAttempts in retryWithBackoff)
        expect(mockCheckpointNewRun).toHaveBeenCalledTimes(5);

        // Execution returns function-rejected with the error
        // InngestCommHandler will then convert this to a 500 response
        expect(result.type).toBe("function-rejected");
        const rejected = result as ExecutionResults["function-rejected"];
        expect(rejected.error).toMatchObject({
          __serialized: true,
          name: "Error",
          message: "Server unreachable",
        });
      });
    });
  });

  describe("StepMode.AsyncCheckpointing", () => {
    // Note: For simple functions without steps, AsyncCheckpointing doesn't
    // actually call checkpoint() during execution - it just returns steps-found
    // with the result, and the server handles persistence.
    //
    // Checkpointing in AsyncCheckpointing mode only happens when:
    // 1. A step runs and needs to be buffered/checkpointed
    // 2. The buffer fills up or timer triggers
    //
    // Testing checkpoint retry in AsyncCheckpointing requires a function
    // with actual steps that get executed and checkpointed.

    test("simple function without steps returns result without checkpointing", async () => {
      const client = createClient({ id: "test" });

      const mockCheckpointStepsAsync = vi.fn().mockResolvedValue(undefined);

      (client as unknown as { inngestApi: Partial<InngestApi> }).inngestApi = {
        checkpointStepsAsync: mockCheckpointStepsAsync,
      } as Partial<InngestApi> as InngestApi;

      const fn = new InngestFunction(
        client,
        { id: "test-fn", triggers: [{ event: "test/event" }] },
        async () => "result",
      );

      const execution = fn["createExecution"]({
        version: ExecutionVersion.V1,
        partialOptions: {
          client,
          data: fromPartial({ event: mockEvent }),
          runId: "test-run-id",
          stepState: {},
          stepCompletionOrder: [],
          reqArgs: [],
          headers: {},
          stepMode: StepMode.AsyncCheckpointing,
          queueItemId: "queue-item-123",
          internalFnId: "internal-fn-456",
        },
      });

      const executionPromise = execution.start();
      await advanceThroughRetries();
      const result = await executionPromise;

      // For simple functions, no checkpoint call is made during execution
      // The SDK just returns the result for the server to handle
      expect(mockCheckpointStepsAsync).not.toHaveBeenCalled();
      expect(result.type).toBe("steps-found");
    });
  });
});

describe("V1 checkpointing maxRuntime", () => {
  const mockEvent = { name: "test/event", data: { foo: "bar" } };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("hit maxRuntime in stepless function does not cause duplicate execution", async () => {
    // Regression test: the old handler immediately returned a DiscoveryRequest,
    // which re-invoked the function from scratch. For stepless functions this
    // looped forever.
    const client = createClient({ id: "test" });
    let enterCount = 0;

    const fn = new InngestFunction(
      client,
      {
        id: "test-fn",
        triggers: [{ event: "test/event" }],
        checkpointing: {
          maxRuntime: 1,
        },
      },
      async () => {
        enterCount++;
        // Simulate work that exceeds maxRuntime
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return "done";
      },
    );

    const execution = fn["createExecution"]({
      version: ExecutionVersion.V1,
      partialOptions: {
        client,
        data: fromPartial({ event: mockEvent }),
        runId: "test-run-id",
        stepState: {},
        stepCompletionOrder: [],
        reqArgs: [],
        headers: {},
        stepMode: StepMode.AsyncCheckpointing,
        queueItemId: "queue-item-123",
        internalFnId: "internal-fn-456",
        checkpointingConfig: {
          maxRuntime: 50, // 50ms - will be exceeded by the 200ms sleep
          bufferedSteps: 1,
          maxInterval: 0,
        },
      },
    });

    const resultPromise = execution.start();
    await vi.advanceTimersByTimeAsync(500);
    const result = await resultPromise;

    // The function should complete normally, not re-enter
    expect(enterCount).toBe(1);
    expect(result.type).toBe("steps-found");

    // The result should NOT contain a DiscoveryRequest op
    if (result.type === "steps-found") {
      const stepsFound = result as ExecutionResults["steps-found"];
      const hasDiscoveryRequest = stepsFound.steps.some(
        (s) => s.op === StepOpCode.DiscoveryRequest,
      );
      expect(hasDiscoveryRequest).toBe(false);
    }
  });

  test("hit maxRuntime between steps returns steps to executor", async () => {
    // When maxRuntime is hit between steps, the next step.run() should return
    // the step to the executor instead of executing it in-process.
    const client = createClient({ id: "test" });

    const mockCheckpointStepsAsync = vi.fn().mockResolvedValue(undefined);
    (client as unknown as { inngestApi: Partial<InngestApi> }).inngestApi = {
      checkpointStepsAsync: mockCheckpointStepsAsync,
    } as Partial<InngestApi> as InngestApi;

    const fn = new InngestFunction(
      client,
      {
        id: "test-fn",
        triggers: [{ event: "test/event" }],
        checkpointing: {
          maxRuntime: 1,
        },
      },
      async ({ step }) => {
        await step.run("before", async () => "step-result");
        // Sleep that exceeds maxRuntime will happen between steps
        await new Promise((resolve) => setTimeout(resolve, 200));
        await step.run("after", async () => "step-2-result");
        return "done";
      },
    );

    const execution = fn["createExecution"]({
      version: ExecutionVersion.V1,
      partialOptions: {
        client,
        data: fromPartial({ event: mockEvent }),
        runId: "test-run-id",
        stepState: {},
        stepCompletionOrder: [],
        reqArgs: [],
        headers: {},
        stepMode: StepMode.AsyncCheckpointing,
        queueItemId: "queue-item-123",
        internalFnId: "internal-fn-456",
        checkpointingConfig: {
          maxRuntime: 50, // 50ms - will be exceeded between step "before" and "after"
          bufferedSteps: 1,
          maxInterval: 0,
        },
      },
    });

    const resultPromise = execution.start();
    await vi.advanceTimersByTimeAsync(500);
    const result = await resultPromise;

    // Should return steps-found since the "after" step should be returned
    // to the executor rather than executed in-process
    expect(result.type).toBe("steps-found");

    // The result should NOT contain a DiscoveryRequest
    if (result.type === "steps-found") {
      const stepsFound = result as ExecutionResults["steps-found"];
      const hasDiscoveryRequest = stepsFound.steps.some(
        (s) => s.op === StepOpCode.DiscoveryRequest,
      );
      expect(hasDiscoveryRequest).toBe(false);
    }
  });
});
