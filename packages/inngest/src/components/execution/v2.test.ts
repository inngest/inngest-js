import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { InngestApi } from "../../api/api.ts";
import { ExecutionVersion } from "../../helpers/consts.ts";
import { createClient } from "../../test/helpers.ts";
import { StepMode } from "../../types.ts";
import { InngestFunction } from "../InngestFunction.ts";
import type { ExecutionResults } from "./InngestExecution.ts";
import { PREFERRED_CHECKPOINTING_EXECUTION_VERSION } from "./InngestExecution.ts";

describe("V2 checkpoint retry behavior", () => {
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
          version: ExecutionVersion.V2,
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
              version: ExecutionVersion.V2,
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
          version: ExecutionVersion.V2,
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
              version: ExecutionVersion.V2,
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
        version: ExecutionVersion.V2,
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

    test("flushes buffered steps before returning parallel steps to executor", async () => {
      const client = createClient({ id: "test" });

      const mockCheckpointStepsAsync = vi.fn().mockResolvedValue(undefined);

      (client as unknown as { inngestApi: Partial<InngestApi> }).inngestApi = {
        checkpointStepsAsync: mockCheckpointStepsAsync,
      } as Partial<InngestApi> as InngestApi;

      // Function with 2 sequential steps then 2 parallel steps.
      // With bufferedSteps: 5, the sequential steps stay buffered
      // and must be flushed when parallelism is discovered.
      const fn = new InngestFunction(
        client,
        { id: "test-fn", triggers: [{ event: "test/event" }] },
        async ({ step }) => {
          await step.run("sequential-1", () => "result-1");
          await step.run("sequential-2", () => "result-2");

          // These create parallel steps that can't be immediately executed
          await Promise.all([
            step.run("parallel-a", () => "a"),
            step.run("parallel-b", () => "b"),
          ]);
        },
      );

      const execution = fn["createExecution"]({
        version: PREFERRED_CHECKPOINTING_EXECUTION_VERSION,
        partialOptions: {
          client,
          data: fromPartial({ event: mockEvent }),
          runId: "test-run-id",
          stepState: {},
          stepCompletionOrder: [],
          reqArgs: [],
          headers: {},
          stepMode: StepMode.AsyncCheckpointing,
          checkpointingConfig: {
            bufferedSteps: 5,
            maxRuntime: 0,
            maxInterval: 0,
          },
          queueItemId: "queue-item-123",
          internalFnId: "internal-fn-456",
        },
      });

      const executionPromise = execution.start();
      await advanceThroughRetries();
      const result = await executionPromise;

      // The result should report the parallel steps back to the executor
      expect(result.type).toBe("steps-found");
      const stepsFound = result as ExecutionResults["steps-found"] & {
        type: string;
      };
      const reportedNames = stepsFound.steps.map((s) => s.name);
      expect(reportedNames).toContain("parallel-a");
      expect(reportedNames).toContain("parallel-b");

      // The buffered sequential steps must have been flushed via
      // checkpoint before returning. Without the flush, these steps
      // would be lost and subsequent requestedRunStep invocations
      // would fail with "step not found".
      expect(mockCheckpointStepsAsync).toHaveBeenCalled();

      const checkpointedSteps = mockCheckpointStepsAsync.mock.calls.flatMap(
        (call) => call[0].steps,
      );
      const checkpointedNames = checkpointedSteps.map(
        (s: { name?: string }) => s.name,
      );
      expect(checkpointedNames).toContain("sequential-1");
      expect(checkpointedNames).toContain("sequential-2");
    });
  });
});
