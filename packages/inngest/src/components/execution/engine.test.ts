import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { InngestApi } from "../../api/api.ts";
import { ExecutionVersion } from "../../helpers/consts.ts";
import { createClient } from "../../test/helpers.ts";
import { StepMode, StepOpCode } from "../../types.ts";
import { InngestFunction } from "../InngestFunction.ts";
import type { MetadataUpdate } from "../InngestMetadata.ts";
import type { GenericStepTools } from "../InngestStepTools.ts";
import { NonRetriableError } from "../NonRetriableError.ts";
import type { ExecutionResults } from "./InngestExecution.ts";

describe("Execution engine checkpoint retry behavior", () => {
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

  /**
   * Helper to reduce test setup duplication. Creates a client with a mocked
   * inngestApi, wraps the handler in an InngestFunction, and builds the
   * execution. Returns the execution plus the mocks for assertions.
   */
  const setupExecution = ({
    mockApi,
    handler,
    stepMode,
    checkpointingConfig,
    extraPartialOptions = {},
  }: {
    mockApi: Partial<InngestApi>;
    handler: (ctx: { step: GenericStepTools }) => Promise<unknown>;
    stepMode: StepMode;
    checkpointingConfig?: {
      bufferedSteps: number;
      maxRuntime: number;
      maxInterval: number;
    };
    extraPartialOptions?: Record<string, unknown>;
  }) => {
    const client = createClient({ id: "test" });

    (client as unknown as { inngestApi: Partial<InngestApi> }).inngestApi =
      mockApi as InngestApi;

    const fn = new InngestFunction(
      client,
      { id: "test-fn", triggers: [{ event: "test/event" }] },
      handler as unknown as Parameters<typeof client.createFunction>[1],
    );

    const syncOptions =
      stepMode === StepMode.Sync
        ? {
            createResponse: async (data: unknown) => ({
              status: 200,
              body: JSON.stringify(data),
              headers: {},
              version: ExecutionVersion.V2,
            }),
          }
        : {};

    const execution = fn["createExecution"]({
      partialOptions: {
        client,
        data: fromPartial({ event: mockEvent }),
        runId: "test-run-id",
        stepState: {},
        stepCompletionOrder: [],
        reqArgs: [],
        headers: {},
        stepMode,
        ...(checkpointingConfig ? { checkpointingConfig } : {}),
        ...syncOptions,
        ...extraPartialOptions,
      },
    });

    return { execution, client, fn };
  };

  /**
   * Shorthand: create execution, start it, advance timers, return result.
   */
  const runExecution = async (...args: Parameters<typeof setupExecution>) => {
    const setup = setupExecution(...args);
    const executionPromise = setup.execution.start();
    await advanceThroughRetries();
    const result = await executionPromise;
    return { ...setup, result };
  };

  describe("StepMode.Sync (Durable Endpoints)", () => {
    describe("checkpointNewRun (first checkpoint)", () => {
      test("retries on transient failure and succeeds", async () => {
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

        const { result } = await runExecution({
          mockApi: { checkpointNewRun: mockCheckpointNewRun },
          handler: async () => "result",
          stepMode: StepMode.Sync,
        });

        // Should have retried and eventually succeeded
        expect(mockCheckpointNewRun).toHaveBeenCalledTimes(3);
        expect(result.type).toBe("function-resolved");
      });

      test("returns function-rejected after all retries exhausted (InngestCommHandler converts to 500)", async () => {
        const mockCheckpointNewRun = vi
          .fn()
          .mockRejectedValue(new Error("Server unreachable"));

        const { result } = await runExecution({
          mockApi: { checkpointNewRun: mockCheckpointNewRun },
          handler: async () => "result",
          stepMode: StepMode.Sync,
        });

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

    describe("metadata propagation to checkpoint payload", () => {
      test("includes metadata from state.metadata in the checkpoint steps", async () => {
        const client = createClient({ id: "test" });

        const mockCheckpointNewRun = vi.fn().mockResolvedValue({
          data: {
            app_id: "app-123",
            fn_id: "fn-456",
            token: "token-789",
          },
        });

        const mockCheckpointSteps = vi.fn().mockResolvedValue(undefined);

        (client as unknown as { inngestApi: Partial<InngestApi> }).inngestApi =
          {
            checkpointNewRun: mockCheckpointNewRun,
            checkpointSteps: mockCheckpointSteps,
          } as Partial<InngestApi> as InngestApi;

        const fn = new InngestFunction(
          client,
          { id: "test-fn", triggers: [{ event: "test/event" }] },
          async ({ step }) => {
            const result = await step.run("my-step", () => "step-result");
            return result;
          },
        );

        const execution = fn["createExecution"]({
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

        // Pre-populate metadata for the step (keyed by unhashed display name)
        const metadataUpdates: MetadataUpdate[] = [
          {
            kind: "userland.test",
            scope: "step",
            op: "merge",
            values: { status: "processing" },
          },
        ];
        (
          execution as unknown as {
            state: { metadata: Map<string, MetadataUpdate[]> };
          }
        ).state.metadata = new Map([["my-step", metadataUpdates]]);

        const executionPromise = execution.start();
        await advanceThroughRetries();
        const result = await executionPromise;

        expect(result.type).toBe("function-resolved");

        // The first checkpoint (checkpointNewRun) should include the step
        // with metadata from the execution
        expect(mockCheckpointNewRun).toHaveBeenCalledTimes(1);
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const firstCheckpointSteps = mockCheckpointNewRun.mock.calls[0]![0]
          .steps as Array<{ metadata?: MetadataUpdate[] }>;
        const stepWithMetadata = firstCheckpointSteps.find(
          (s) => s.metadata && s.metadata.length > 0,
        );

        expect(stepWithMetadata).toBeDefined();
        expect(stepWithMetadata!.metadata).toEqual(metadataUpdates);
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
      const mockCheckpointStepsAsync = vi.fn().mockResolvedValue(undefined);

      const { result } = await runExecution({
        mockApi: { checkpointStepsAsync: mockCheckpointStepsAsync },
        handler: async () => "result",
        stepMode: StepMode.AsyncCheckpointing,
        extraPartialOptions: {
          queueItemId: "queue-item-123",
          internalFnId: "internal-fn-456",
        },
      });

      // For simple functions, no checkpoint call is made during execution
      // The SDK just returns the result for the server to handle
      expect(mockCheckpointStepsAsync).not.toHaveBeenCalled();
      expect(result.type).toBe("steps-found");
      const stepsFound = result as ExecutionResults["steps-found"];
      expect(stepsFound.steps).toHaveLength(1);
      expect(stepsFound.steps[0]!.data).toBe("result");
    });

    test("flushes buffered steps before returning parallel steps to executor", async () => {
      const mockCheckpointStepsAsync = vi.fn().mockResolvedValue(undefined);

      // Function with 2 sequential steps then 2 parallel steps.
      // With bufferedSteps: 5, the sequential steps stay buffered
      // and must be flushed when parallelism is discovered.
      const { result } = await runExecution({
        mockApi: { checkpointStepsAsync: mockCheckpointStepsAsync },
        handler: async ({ step }) => {
          await step.run("sequential-1", () => "result-1");
          await step.run("sequential-2", () => "result-2");

          // These parallel steps can't be executed in-process
          await Promise.all([
            step.run("parallel-a", () => "a"),
            step.run("parallel-b", () => "b"),
          ]);
        },
        stepMode: StepMode.AsyncCheckpointing,
        checkpointingConfig: {
          bufferedSteps: 5,
          maxRuntime: 0,
          maxInterval: 0,
        },
        extraPartialOptions: {
          queueItemId: "queue-item-123",
          internalFnId: "internal-fn-456",
        },
      });

      // The result should report the parallel steps back to the executor
      expect(result.type).toBe("steps-found");
      const stepsFound = result as ExecutionResults["steps-found"] & {
        type: string;
      };

      // The parallel steps should be in the response
      const reportedStepNames = stepsFound.steps.map((s) => s.displayName);
      expect(reportedStepNames).toContain("parallel-a");
      expect(reportedStepNames).toContain("parallel-b");

      // The sequential steps should have been flushed via checkpoint
      // BEFORE returning the parallel steps
      expect(mockCheckpointStepsAsync).toHaveBeenCalled();
      const checkpointedSteps =
        mockCheckpointStepsAsync.mock.calls[0]![0].steps;
      const checkpointedNames = checkpointedSteps.map(
        (s: { name?: string }) => s.name,
      );
      expect(checkpointedNames).toContain("sequential-1");
      expect(checkpointedNames).toContain("sequential-2");
    });

    describe("Bug 1: flush-only checkpoint failure must not silently lose steps", () => {
      // When attemptCheckpointAndResume(undefined, false, true) is called
      // (flush-only, no stepResult) and checkpoint() throws, the execution
      // must fall back to returning the buffered steps to the executor via
      // the normal async flow (steps-found 206), not silently drop them.
      //
      // Fix: the catch block returns steps-found with all buffered steps.
      // The caller checks the return value — if non-undefined, it returns
      // the fallback directly instead of proceeding. The executor persists
      // the completed steps and rediscovers any parallel/errored steps on
      // the next invocation (one extra round-trip, but no data loss).

      test("should fall back to returning buffered steps when flush-before-parallel-steps fails", async () => {
        const mockCheckpointStepsAsync = vi
          .fn()
          .mockRejectedValue(new Error("Checkpoint service unavailable"));

        // 2 sequential steps (buffered), then parallel steps trigger flush
        const { result } = await runExecution({
          mockApi: { checkpointStepsAsync: mockCheckpointStepsAsync },
          handler: async ({ step }) => {
            await step.run("seq-1", () => "result-1");
            await step.run("seq-2", () => "result-2");

            await Promise.all([
              step.run("parallel-a", () => "a"),
              step.run("parallel-b", () => "b"),
            ]);
          },
          stepMode: StepMode.AsyncCheckpointing,
          checkpointingConfig: {
            bufferedSteps: 5,
            maxRuntime: 0,
            maxInterval: 0,
          },
          extraPartialOptions: {
            queueItemId: "queue-item-123",
            internalFnId: "internal-fn-456",
          },
        });

        // The checkpoint flush was attempted (and failed)
        expect(mockCheckpointStepsAsync).toHaveBeenCalled();

        // The fallback returns the buffered completed steps to the
        // executor so it can persist them via the normal async flow.
        expect(result.type).toBe("steps-found");
        const stepsFound = result as ExecutionResults["steps-found"] & {
          type: string;
        };
        const reportedStepNames = stepsFound.steps.map((s) => s.displayName);

        // The completed sequential steps must be included — they must
        // not be silently lost
        expect(reportedStepNames).toContain("seq-1");
        expect(reportedStepNames).toContain("seq-2");

        // The parallel steps are NOT in the fallback response — they
        // were never executed or buffered. The executor will rediscover
        // them on the next invocation once seq-1 and seq-2 are in
        // stepState. One extra round-trip, but no data loss.
      });

      test("should fall back to returning buffered steps when flush-before-step-error fails", async () => {
        // Checkpoint always fails
        const mockCheckpointStepsAsync = vi
          .fn()
          .mockRejectedValue(new Error("Checkpoint service unavailable"));

        // 2 sequential steps then a failing step.
        // bufferedSteps: 5 so nothing flushes normally. The step
        // failure triggers the flush.
        const { result } = await runExecution({
          mockApi: { checkpointStepsAsync: mockCheckpointStepsAsync },
          handler: async ({ step }) => {
            await step.run("seq-1", () => "result-1");
            await step.run("seq-2", () => "result-2");
            await step.run("will-fail", () => {
              throw new Error("Step execution error");
            });
          },
          stepMode: StepMode.AsyncCheckpointing,
          checkpointingConfig: {
            bufferedSteps: 5,
            maxRuntime: 0,
            maxInterval: 0,
          },
          extraPartialOptions: {
            queueItemId: "queue-item-123",
            internalFnId: "internal-fn-456",
          },
        });

        // The pre-error flush was attempted (and failed)
        expect(mockCheckpointStepsAsync).toHaveBeenCalled();

        // The fallback returns the buffered completed steps so the
        // executor can persist them. The failed step (will-fail) was
        // never buffered — it errored during execution and was never
        // passed to attemptCheckpointAndResume. On the next invocation,
        // seq-1 and seq-2 will be in stepState, the function re-runs,
        // and will-fail is re-executed and its error handled normally.
        expect(result.type).toBe("steps-found");
        const stepsFound = result as ExecutionResults["steps-found"] & {
          type: string;
        };
        const reportedStepNames = stepsFound.steps.map((s) => s.displayName);

        // Only the buffered steps are in the fallback response
        expect(reportedStepNames).toContain("seq-1");
        expect(reportedStepNames).toContain("seq-2");

        // will-fail is NOT in the response — it was never buffered
        expect(reportedStepNames).not.toContain("will-fail");
      });
    });

    describe("Bug 2: checkpoint failure fallback must include all buffered steps", () => {
      // When a step triggers a regular flush (buffer reaches bufferedSteps)
      // and checkpoint() throws, the fallback must return ALL buffered
      // steps to the executor via the normal async flow, not just the
      // triggering step.

      test("fallback after buffer-full flush failure should return all buffered steps", async () => {
        const mockCheckpointStepsAsync = vi
          .fn()
          .mockRejectedValue(new Error("Checkpoint service unavailable"));

        // 3 sequential steps with bufferedSteps: 3.
        // Steps 1 and 2 get buffered. Step 3 fills the buffer and
        // triggers a flush. The flush fails.
        const { result } = await runExecution({
          mockApi: { checkpointStepsAsync: mockCheckpointStepsAsync },
          handler: async ({ step }) => {
            await step.run("seq-1", () => "result-1");
            await step.run("seq-2", () => "result-2");
            await step.run("seq-3", () => "result-3");
          },
          stepMode: StepMode.AsyncCheckpointing,
          checkpointingConfig: {
            bufferedSteps: 3,
            maxRuntime: 0,
            maxInterval: 0,
          },
          extraPartialOptions: {
            queueItemId: "queue-item-123",
            internalFnId: "internal-fn-456",
          },
        });

        // The checkpoint was attempted with all 3 steps
        expect(mockCheckpointStepsAsync).toHaveBeenCalled();
        const checkpointedSteps =
          mockCheckpointStepsAsync.mock.calls[0]![0].steps;
        const checkpointedNames = checkpointedSteps.map(
          (s: { name?: string }) => s.name,
        );
        expect(checkpointedNames).toContain("seq-1");
        expect(checkpointedNames).toContain("seq-2");
        expect(checkpointedNames).toContain("seq-3");

        // When the checkpoint fails, the fallback must return ALL
        // buffered steps to the executor. Both step-ran and steps-found
        // produce a 206 with the steps array — the executor persists
        // completed steps (those with data) either way.
        expect(result.type).toBe("steps-found");
        const stepsFound = result as ExecutionResults["steps-found"] & {
          type: string;
        };
        const reportedStepNames = stepsFound.steps.map((s) => s.displayName);

        // ALL three steps must be in the response — not just seq-3
        expect(reportedStepNames).toContain("seq-1");
        expect(reportedStepNames).toContain("seq-2");
        expect(reportedStepNames).toContain("seq-3");
      });
    });

    describe("Bug 3: function-rejected must force-flush buffered steps", () => {
      // The function-rejected handler must force-flush the buffer
      // regardless of whether it has reached bufferedSteps threshold.

      test("should flush buffered steps before returning function-rejected", async () => {
        const mockCheckpointStepsAsync = vi.fn().mockResolvedValue(undefined);

        // 2 sequential steps succeed, then the function itself throws.
        // bufferedSteps: 5, so the 2 steps stay in the buffer.
        const { result } = await runExecution({
          mockApi: { checkpointStepsAsync: mockCheckpointStepsAsync },
          handler: async ({ step }) => {
            await step.run("seq-1", () => "result-1");
            await step.run("seq-2", () => "result-2");

            // Unhandled error in user code (not in a step)
            throw new Error("Unexpected error in function body");
          },
          stepMode: StepMode.AsyncCheckpointing,
          checkpointingConfig: {
            bufferedSteps: 5,
            maxRuntime: 0,
            maxInterval: 0,
          },
          extraPartialOptions: {
            queueItemId: "queue-item-123",
            internalFnId: "internal-fn-456",
          },
        });

        // The function should still be rejected with the original error
        expect(result.type).toBe("function-rejected");
        const rejected = result as ExecutionResults["function-rejected"];
        expect(rejected.error).toMatchObject({
          message: "Unexpected error in function body",
        });

        // But BEFORE returning the rejection, the buffered steps must
        // be flushed via checkpoint. The function-rejected handler must
        // force the flush regardless of the bufferedSteps threshold.
        expect(mockCheckpointStepsAsync).toHaveBeenCalled();

        const checkpointedSteps =
          mockCheckpointStepsAsync.mock.calls[0]![0].steps;
        const checkpointedNames = checkpointedSteps.map(
          (s: { name?: string }) => s.name,
        );
        expect(checkpointedNames).toContain("seq-1");
        expect(checkpointedNames).toContain("seq-2");
      });

      test("should fall back to returning buffered steps when forced flush fails during function-rejected", async () => {
        // Checkpoint always fails
        const mockCheckpointStepsAsync = vi
          .fn()
          .mockRejectedValue(new Error("Checkpoint service unavailable"));

        // 2 sequential steps succeed, then the function itself throws.
        // bufferedSteps: 5, so the 2 steps stay in the buffer.
        // The function-rejected handler force-flushes, but checkpoint
        // fails — the fallback must return buffered steps rather than
        // losing them.
        const { result } = await runExecution({
          mockApi: { checkpointStepsAsync: mockCheckpointStepsAsync },
          handler: async ({ step }) => {
            await step.run("seq-1", () => "result-1");
            await step.run("seq-2", () => "result-2");

            // Unhandled error in user code (not in a step)
            throw new Error("Unexpected error in function body");
          },
          stepMode: StepMode.AsyncCheckpointing,
          checkpointingConfig: {
            bufferedSteps: 5,
            maxRuntime: 0,
            maxInterval: 0,
          },
          extraPartialOptions: {
            queueItemId: "queue-item-123",
            internalFnId: "internal-fn-456",
          },
        });

        // The checkpoint flush was attempted (and failed)
        expect(mockCheckpointStepsAsync).toHaveBeenCalled();

        // When the forced flush fails, the fallback returns the buffered
        // steps to the executor so they aren't lost.
        expect(result.type).toBe("steps-found");
        const stepsFound = result as ExecutionResults["steps-found"] & {
          type: string;
        };
        const reportedStepNames = stepsFound.steps.map((s) => s.displayName);

        // Exactly the 2 buffered sequential steps must be included —
        // no extra steps and no function rejection error leaked in
        expect(stepsFound.steps).toHaveLength(2);
        expect(reportedStepNames).toContain("seq-1");
        expect(reportedStepNames).toContain("seq-2");

        // The function rejection error must NOT be surfaced in the
        // steps-found response — it will be re-raised on the next
        // invocation once the buffered steps are in stepState.
        for (const step of stepsFound.steps) {
          expect(step.error).toBeUndefined();
        }
      });
    });

    test("does not flush when buffer is below threshold and force is false", async () => {
      const mockCheckpointStepsAsync = vi.fn().mockResolvedValue(undefined);

      // 2 steps with bufferedSteps: 5 — buffer never fills, no flush
      const { result } = await runExecution({
        mockApi: { checkpointStepsAsync: mockCheckpointStepsAsync },
        handler: async ({ step }) => {
          await step.run("seq-1", () => "result-1");
          await step.run("seq-2", () => "result-2");
        },
        stepMode: StepMode.AsyncCheckpointing,
        checkpointingConfig: {
          bufferedSteps: 5,
          maxRuntime: 0,
          maxInterval: 0,
        },
        extraPartialOptions: {
          queueItemId: "queue-item-123",
          internalFnId: "internal-fn-456",
        },
      });

      // Steps stay buffered — no checkpoint call since 2 < 5
      expect(mockCheckpointStepsAsync).not.toHaveBeenCalled();
      expect(result.type).toBe("steps-found");
    });

    test("buffer is cleared after successful checkpoint", async () => {
      const mockCheckpointStepsAsync = vi.fn().mockResolvedValue(undefined);

      // 4 sequential steps with bufferedSteps: 2.
      // Steps 1-2 fill the buffer and trigger a flush. Steps 3-4 fill
      // the buffer again — if the buffer wasn't cleared after the first
      // flush, the second flush would contain all 4 steps (double-send).
      const { result } = await runExecution({
        mockApi: { checkpointStepsAsync: mockCheckpointStepsAsync },
        handler: async ({ step }) => {
          await step.run("seq-1", () => "result-1");
          await step.run("seq-2", () => "result-2");
          await step.run("seq-3", () => "result-3");
          await step.run("seq-4", () => "result-4");
        },
        stepMode: StepMode.AsyncCheckpointing,
        checkpointingConfig: {
          bufferedSteps: 2,
          maxRuntime: 0,
          maxInterval: 0,
        },
        extraPartialOptions: {
          queueItemId: "queue-item-123",
          internalFnId: "internal-fn-456",
        },
      });

      expect(result.type).toBe("steps-found");
      // Two separate checkpoint calls, each with exactly 2 steps
      expect(mockCheckpointStepsAsync).toHaveBeenCalledTimes(2);

      const firstCallSteps = mockCheckpointStepsAsync.mock.calls[0]![0].steps;
      const secondCallSteps = mockCheckpointStepsAsync.mock.calls[1]![0].steps;
      expect(firstCallSteps).toHaveLength(2);
      expect(secondCallSteps).toHaveLength(2);

      const firstNames = firstCallSteps.map(
        (s: { displayName?: string }) => s.displayName,
      );
      const secondNames = secondCallSteps.map(
        (s: { displayName?: string }) => s.displayName,
      );
      expect(firstNames).toEqual(["seq-1", "seq-2"]);
      expect(secondNames).toEqual(["seq-3", "seq-4"]);
    });

    test("function-resolved flushes remaining buffered steps", async () => {
      const mockCheckpointStepsAsync = vi.fn().mockResolvedValue(undefined);

      // 2 steps complete, function resolves. bufferedSteps: 5, so
      // the steps stay buffered. The function-resolved handler must
      // include them in the response so they aren't lost.
      const { result } = await runExecution({
        mockApi: { checkpointStepsAsync: mockCheckpointStepsAsync },
        handler: async ({ step }) => {
          await step.run("seq-1", () => "result-1");
          await step.run("seq-2", () => "result-2");
          return "done";
        },
        stepMode: StepMode.AsyncCheckpointing,
        checkpointingConfig: {
          bufferedSteps: 5,
          maxRuntime: 0,
          maxInterval: 0,
        },
        extraPartialOptions: {
          queueItemId: "queue-item-123",
          internalFnId: "internal-fn-456",
        },
      });

      expect(result.type).toBe("steps-found");
      const stepsFound = result as ExecutionResults["steps-found"];

      // The response must include the buffered steps AND the
      // RunComplete marker with the function's return value.
      const names = stepsFound.steps.map((s) => s.displayName);
      expect(names).toContain("seq-1");
      expect(names).toContain("seq-2");

      const completeStep = stepsFound.steps.find((s) => s.op === "RunComplete");
      expect(completeStep).toBeDefined();
      expect(completeStep!.data).toBe("done");
    });
  });

  describe("StepMode.Sync with steps", () => {
    test("checkpoints steps via checkpointSteps after initial run", async () => {
      const mockCheckpointNewRun = vi.fn().mockResolvedValue({
        data: { app_id: "app-123", fn_id: "fn-456", token: "token-789" },
      });
      const mockCheckpointSteps = vi.fn().mockResolvedValue(undefined);

      const { result } = await runExecution({
        mockApi: {
          checkpointNewRun: mockCheckpointNewRun,
          checkpointSteps: mockCheckpointSteps,
        },
        handler: async ({ step }) => {
          await step.run("step-1", () => "result-1");
          await step.run("step-2", () => "result-2");
          return "done";
        },
        stepMode: StepMode.Sync,
      });

      expect(result.type).toBe("function-resolved");
      // First checkpoint creates the run
      expect(mockCheckpointNewRun).toHaveBeenCalledTimes(1);
      // Subsequent steps use checkpointSteps
      expect(mockCheckpointSteps).toHaveBeenCalled();
    });
  });

  describe("StepMode.Sync (SSE streaming)", () => {
    const makeSseApi = (
      overrides?: Partial<InngestApi>,
    ): Partial<InngestApi> => ({
      checkpointNewRun: vi.fn().mockResolvedValue({
        data: {
          app_id: "app-123",
          fn_id: "fn-456",
          token: "token-789",
          realtime_token: "rt-token",
        },
      }),
      checkpointSteps: vi.fn().mockResolvedValue(undefined),
      getRealtimeStreamRedirect: vi
        .fn()
        .mockResolvedValue({ url: "http://test/sse" }),
      checkpointStream: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    });

    test("checkpoint failure resolves with function-rejected instead of throwing", async () => {
      const setup = setupExecution({
        mockApi: makeSseApi({
          checkpointNewRun: vi.fn().mockRejectedValue(new Error("Server down")),
        }),
        handler: async ({ step }) => {
          await step.run("a", () => "ok");
          return "done";
        },
        stepMode: StepMode.Sync,
        extraPartialOptions: { acceptsSse: true },
      });

      const resultPromise = setup.execution.start();
      await advanceThroughRetries();
      const result = await resultPromise;

      expect(result).toHaveProperty("type", "function-rejected");
    });

    test("NonRetriableError in step checkpoints as StepFailed with serialized error data", async () => {
      const api = makeSseApi();

      await runExecution({
        mockApi: api,
        handler: async ({ step }) => {
          await step.run("will-fail", () => {
            throw new NonRetriableError("permanent");
          });
        },
        stepMode: StepMode.Sync,
        extraPartialOptions: { acceptsSse: true },
      });

      const allSteps = [
        ...(api.checkpointNewRun as ReturnType<typeof vi.fn>).mock.calls,
        ...(api.checkpointSteps as ReturnType<typeof vi.fn>).mock.calls,
      ].flatMap((call) => call[0]?.steps ?? []);

      const failedStep = allSteps.find(
        (s: { op?: string }) => s.op === StepOpCode.StepFailed,
      );

      expect(failedStep).toBeDefined();
      expect(failedStep.op).toBe(StepOpCode.StepFailed);
      expect(failedStep.data).toMatchObject({
        __serialized: true,
        name: "NonRetriableError",
        message: "permanent",
      });
    });
  });

  // When a step in AsyncCheckpointing runs longer than the in-progress
  // threshold (1s), the SDK fires a leading-edge `StepPlanned` and
  // collapses the trailing `StepRun`'s timing to a zero-length marker
  // at `t_end`.
  describe("Execution engine in-progress step", () => {
    const inProgressOpts = {
      stepMode: StepMode.AsyncCheckpointing as const,
      checkpointingConfig: { bufferedSteps: 1, maxRuntime: 0, maxInterval: 0 },
      extraPartialOptions: {
        queueItemId: "queue-item-123",
        internalFnId: "internal-fn-456",
      },
    };

    // Resolvable Promise helper — separate from the SDK's deferred utility
    // so failures here don't depend on internal helpers.
    const defer = <T>() => {
      let resolve!: (v: T) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };

    // Steps from all flushed checkpoint payloads.
    const buffered = (mock: ReturnType<typeof vi.fn>) =>
      mock.mock.calls.flatMap((call) => call[0]?.steps ?? []);

    test("short step → no leading-edge POST", async () => {
      const mockCheckpointStepProgress = vi
        .fn()
        .mockResolvedValue({ ok: true });
      const mockCheckpointStepsAsync = vi.fn().mockResolvedValue(undefined);

      const { result } = await runExecution({
        mockApi: {
          checkpointStepProgress: mockCheckpointStepProgress,
          checkpointStepsAsync: mockCheckpointStepsAsync,
        },
        handler: async ({ step }) => {
          await step.run("a", () => "a");
        },
        ...inProgressOpts,
      });

      expect(mockCheckpointStepProgress).not.toHaveBeenCalled();
      // Short step: data ships via the normal flow (buffer flush or
      // step-ran result, depending on bufferedSteps). Either way, no
      // leading-edge POST.
      const stepFromResult =
        result.type === "step-ran"
          ? [(result as { step: { op: StepOpCode } }).step]
          : result.type === "steps-found"
            ? (result as ExecutionResults["steps-found"]).steps
            : [];
      const allSteps = [
        ...stepFromResult,
        ...buffered(mockCheckpointStepsAsync),
      ];
      const stepRuns = allSteps.filter((s) => s.op === StepOpCode.StepRun);
      expect(stepRuns.length).toBeGreaterThanOrEqual(1);
    });

    test("long step + leading succeeds → trailing StepRun with collapsed timing", async () => {
      const stepBody = defer<string>();
      const mockCheckpointStepProgress = vi
        .fn()
        .mockResolvedValue({ ok: true });
      const mockCheckpointStepsAsync = vi.fn().mockResolvedValue(undefined);

      const setup = setupExecution({
        mockApi: {
          checkpointStepProgress: mockCheckpointStepProgress,
          checkpointStepsAsync: mockCheckpointStepsAsync,
        },
        handler: async ({ step }) => {
          await step.run("a", () => stepBody.promise);
        },
        ...inProgressOpts,
      });

      const execPromise = setup.execution.start();

      // Cross the threshold; leading-edge POST should fire.
      await vi.advanceTimersByTimeAsync(1500);
      expect(mockCheckpointStepProgress).toHaveBeenCalledTimes(1);
      const planned = mockCheckpointStepProgress.mock.calls[0]![0].steps[0] as {
        op: StepOpCode;
        timing: { a: number; b: number };
      };
      expect(planned.op).toBe(StepOpCode.StepPlanned);
      // Wire convention: zero-length span at `a`.
      expect(planned.timing.b).toBe(0);
      expect(planned.timing.a).toBeGreaterThan(0);

      stepBody.resolve("a");
      await advanceThroughRetries();
      await execPromise;

      // Trailing StepRun should be in the checkpoint buffer flush.
      const allSteps = buffered(mockCheckpointStepsAsync);
      const runs = allSteps.filter((s) => s.op === StepOpCode.StepRun);
      expect(runs).toHaveLength(1);
      const run = runs[0]!;
      // Collapsed trailing marker: zero-length at `t_end`.
      expect(run.timing.b).toBe(0);
      expect(run.timing.a).toBeGreaterThan(0);
      // No additional StepPlanned in the buffer (leading already shipped).
      expect(allSteps.filter((s) => s.op === StepOpCode.StepPlanned)).toEqual(
        [],
      );
      // Only one leading-edge POST.
      expect(mockCheckpointStepProgress).toHaveBeenCalledTimes(1);
    });

    test("long step + leading rejects → combined trailing (Planned + Run in buffer)", async () => {
      const stepBody = defer<string>();
      const mockCheckpointStepProgress = vi
        .fn()
        .mockRejectedValue(new Error("executor offline"));
      const mockCheckpointStepsAsync = vi.fn().mockResolvedValue(undefined);

      const setup = setupExecution({
        mockApi: {
          checkpointStepProgress: mockCheckpointStepProgress,
          checkpointStepsAsync: mockCheckpointStepsAsync,
        },
        handler: async ({ step }) => {
          await step.run("a", () => stepBody.promise);
        },
        ...inProgressOpts,
      });

      const execPromise = setup.execution.start();
      await vi.advanceTimersByTimeAsync(1500);
      expect(mockCheckpointStepProgress).toHaveBeenCalledTimes(1);

      stepBody.resolve("a");
      await advanceThroughRetries();
      await execPromise;

      const allSteps = buffered(mockCheckpointStepsAsync);
      const planned = allSteps.filter((s) => s.op === StepOpCode.StepPlanned);
      const runs = allSteps.filter((s) => s.op === StepOpCode.StepRun);
      expect(planned).toHaveLength(1);
      expect(runs).toHaveLength(1);
      // Planned precedes Run.
      expect(allSteps.indexOf(planned[0]!)).toBeLessThan(
        allSteps.indexOf(runs[0]!),
      );
      expect(planned[0]!.timing.b).toBe(0);
      expect(runs[0]!.timing.b).toBe(0);
    });

    test("long step + leading hangs → grace expires, combined trailing", async () => {
      const stepBody = defer<string>();
      // POST never resolves.
      const mockCheckpointStepProgress = vi
        .fn()
        .mockImplementation(() => new Promise(() => {}));
      const mockCheckpointStepsAsync = vi.fn().mockResolvedValue(undefined);

      const setup = setupExecution({
        mockApi: {
          checkpointStepProgress: mockCheckpointStepProgress,
          checkpointStepsAsync: mockCheckpointStepsAsync,
        },
        handler: async ({ step }) => {
          await step.run("a", () => stepBody.promise);
        },
        ...inProgressOpts,
      });

      const execPromise = setup.execution.start();
      await vi.advanceTimersByTimeAsync(1500);
      expect(mockCheckpointStepProgress).toHaveBeenCalledTimes(1);

      stepBody.resolve("a");
      // Advance past the grace window (LEADING_POST_GRACE_MS = 250ms).
      await vi.advanceTimersByTimeAsync(500);
      await advanceThroughRetries();
      await execPromise;

      const allSteps = buffered(mockCheckpointStepsAsync);
      expect(
        allSteps.filter((s) => s.op === StepOpCode.StepPlanned),
      ).toHaveLength(1);
      expect(allSteps.filter((s) => s.op === StepOpCode.StepRun)).toHaveLength(
        1,
      );
    });

    test("long step that throws → still emits Planned + StepError with collapsed timing", async () => {
      const stepBody = defer<string>();
      const mockCheckpointStepProgress = vi
        .fn()
        .mockResolvedValue({ ok: true });
      const mockCheckpointStepsAsync = vi.fn().mockResolvedValue(undefined);

      const setup = setupExecution({
        mockApi: {
          checkpointStepProgress: mockCheckpointStepProgress,
          checkpointStepsAsync: mockCheckpointStepsAsync,
        },
        handler: async ({ step }) => {
          await step.run("a", () => stepBody.promise);
        },
        ...inProgressOpts,
      });

      const execPromise = setup.execution.start();
      await vi.advanceTimersByTimeAsync(1500);
      expect(mockCheckpointStepProgress).toHaveBeenCalledTimes(1);

      stepBody.reject(new NonRetriableError("nope"));
      await advanceThroughRetries();
      const result = await execPromise;

      // Failed steps don't go through the checkpoint buffer — the error
      // op rides back to the executor on the execution result (step-ran).
      expect(result.type).toBe("step-ran");
      const stepRan = result as {
        type: "step-ran";
        step: { op: StepOpCode; timing: { a: number; b: number } };
      };
      expect([StepOpCode.StepError, StepOpCode.StepFailed]).toContain(
        stepRan.step.op,
      );
      // Trailing timing collapsed since leading edge fired.
      expect(stepRan.step.timing.b).toBe(0);
      expect(stepRan.step.timing.a).toBeGreaterThan(0);
    });

    test("two sequential long step.runs → independent trackers, no cross-talk", async () => {
      const aBody = defer<string>();
      const bBody = defer<string>();
      const mockCheckpointStepProgress = vi
        .fn()
        .mockResolvedValue({ ok: true });
      const mockCheckpointStepsAsync = vi.fn().mockResolvedValue(undefined);

      const setup = setupExecution({
        mockApi: {
          checkpointStepProgress: mockCheckpointStepProgress,
          checkpointStepsAsync: mockCheckpointStepsAsync,
        },
        handler: async ({ step }) => {
          await step.run("a", () => aBody.promise);
          await step.run("b", () => bBody.promise);
        },
        ...inProgressOpts,
      });

      // Auto-resolve each body after the leading-edge timer has fired,
      // avoiding brittle manual interleaving with the engine's generator
      // loop. Each body waits ~1.5s of fake time before resolving.
      setTimeout(() => aBody.resolve("a"), 3000);
      setTimeout(() => bBody.resolve("b"), 6000);

      const execPromise = setup.execution.start();
      // Drive timers far enough to cover both step bodies + grace.
      for (let i = 0; i < 30; i++) {
        await vi.advanceTimersByTimeAsync(500);
      }
      await execPromise;

      // Two distinct leading-edge POSTs, one per step.
      const plannedCalls = mockCheckpointStepProgress.mock.calls.flatMap(
        (c) => c[0].steps,
      );
      expect(plannedCalls).toHaveLength(2);
      const plannedNames = plannedCalls.map(
        (s: { displayName?: string }) => s.displayName,
      );
      expect(plannedNames).toEqual(expect.arrayContaining(["a", "b"]));

      // Two distinct trailing StepRuns, both collapsed.
      const allBuffered = buffered(mockCheckpointStepsAsync);
      const runs = allBuffered.filter((s) => s.op === StepOpCode.StepRun);
      expect(runs).toHaveLength(2);
      const runNames = runs.map((r) => r.displayName);
      expect(runNames).toEqual(expect.arrayContaining(["a", "b"]));
      for (const r of runs) {
        expect(r.timing.b).toBe(0);
      }
    });

    test("non-checkpointing mode → no leading-edge POST", async () => {
      const stepBody = defer<string>();
      const mockCheckpointStepProgress = vi
        .fn()
        .mockResolvedValue({ ok: true });

      const setup = setupExecution({
        mockApi: {
          checkpointStepProgress: mockCheckpointStepProgress,
          checkpointStepsAsync: vi.fn().mockResolvedValue(undefined),
        },
        handler: async ({ step }) => {
          await step.run("a", () => stepBody.promise);
        },
        stepMode: StepMode.Async,
      });

      const execPromise = setup.execution.start();
      await vi.advanceTimersByTimeAsync(1500);
      stepBody.resolve("a");
      await advanceThroughRetries();
      await execPromise;

      expect(mockCheckpointStepProgress).not.toHaveBeenCalled();
    });
  });
});
