import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { InngestApi } from "../../api/api.ts";
import { ExecutionVersion } from "../../helpers/consts.ts";
import { createClient } from "../../test/helpers.ts";
import { StepMode, StepOpCode } from "../../types.ts";
import { InngestFunction } from "../InngestFunction.ts";
import type { FoundStep } from "../InngestStepTools.ts";
import type { ExecutionResult, ExecutionResults } from "./InngestExecution.ts";

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

describe("Sync mode function-resolved response handling", () => {
  const mockEvent = { name: "test/event", data: {} };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const advanceThroughRetries = async () => {
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }
  };

  function createSyncExecution(
    handler: () => Promise<unknown>,
    opts?: { acceptsSSE?: boolean },
  ) {
    const client = createClient({ id: "test" });

    const mockCheckpointNewRun = vi.fn().mockResolvedValue({
      data: {
        app_id: "app-123",
        fn_id: "fn-456",
        token: "token-789",
      },
    });

    (client as unknown as { inngestApi: Partial<InngestApi> }).inngestApi = {
      checkpointNewRun: mockCheckpointNewRun,
    } as Partial<InngestApi> as InngestApi;

    const fn = new InngestFunction(
      client,
      { id: "test-fn", triggers: [{ event: "test/event" }] },
      handler,
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
        acceptsSSE: opts?.acceptsSSE ?? false,
        createResponse: async (data) => ({
          status: 200,
          body: JSON.stringify(data),
          headers: {},
          version: ExecutionVersion.V2,
        }),
      },
    });

    return { execution, mockCheckpointNewRun };
  }

  test("Response is passed through as-is (not SSE-wrapped)", async () => {
    const userResponse = new Response("file content", {
      headers: { "Content-Type": "text/plain" },
    });

    const { execution } = createSyncExecution(async () => userResponse);

    const resultPromise = execution.start();
    await advanceThroughRetries();
    const result = await resultPromise;

    expect(result.type).toBe("function-resolved");
    const resolved = result as ExecutionResult & { data: unknown };
    expect(resolved.data).toBeInstanceOf(Response);

    // The original Response is passed through — body is still consumable
    const body = await (resolved.data as Response).text();
    expect(body).toBe("file content");
  });

  test("Response pass-through takes precedence over acceptsSSE", async () => {
    const userResponse = new Response("file content", {
      headers: { "Content-Type": "text/plain" },
    });

    const { execution } = createSyncExecution(async () => userResponse, {
      acceptsSSE: true,
    });

    const resultPromise = execution.start();
    await advanceThroughRetries();
    const result = await resultPromise;

    expect(result.type).toBe("function-resolved");
    const resolved = result as ExecutionResult & { data: unknown };
    expect(resolved.data).toBeInstanceOf(Response);

    // Should be the user's original Response, NOT an SSE-wrapped one
    const body = await (resolved.data as Response).text();
    expect(body).toBe("file content");
  });

  test("plain value with acceptsSSE returns SSE response", async () => {
    const { execution } = createSyncExecution(async () => "hello", {
      acceptsSSE: true,
    });

    const resultPromise = execution.start();
    await advanceThroughRetries();
    const result = await resultPromise;

    expect(result.type).toBe("function-resolved");
    const resolved = result as ExecutionResult & { data: unknown };
    expect(resolved.data).toBeInstanceOf(Response);

    // Should be an SSE response with event frames
    const res = resolved.data as Response;
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const body = await res.text();
    expect(body).toContain("event: inngest.metadata");
    expect(body).toContain("event: inngest.result");
  });

  test("plain value without acceptsSSE uses non-streaming path", async () => {
    const { execution, mockCheckpointNewRun } = createSyncExecution(
      async () => "hello",
    );

    const resultPromise = execution.start();
    await advanceThroughRetries();
    const result = await resultPromise;

    expect(result.type).toBe("function-resolved");
    const resolved = result as ExecutionResult & { data: unknown };

    // Not a Response — plain data returned directly
    expect(resolved.data).toBe("hello");

    // Checkpoint was called synchronously (not in background)
    expect(mockCheckpointNewRun).toHaveBeenCalled();
  });

  test("Response pass-through checkpoints a RunComplete in the background", async () => {
    const { execution, mockCheckpointNewRun } = createSyncExecution(
      async () => new Response("file content"),
    );

    const resultPromise = execution.start();
    await advanceThroughRetries();
    await resultPromise;

    // Flush microtasks so the fire-and-forget checkpointReturnValue resolves
    await vi.advanceTimersByTimeAsync(0);

    // checkpointReturnValue(null) calls checkpointNewRun with RunComplete
    expect(mockCheckpointNewRun).toHaveBeenCalled();
    const call = mockCheckpointNewRun.mock.calls[0]![0];
    const runCompleteOp = call.steps.find(
      (s: { op: string }) => s.op === StepOpCode.RunComplete,
    );
    expect(runCompleteOp).toBeDefined();
  });
});

describe("resumeStepLocally", () => {
  const mockEvent = { name: "test/event", data: {} };

  function createEngine() {
    const client = createClient({ id: "test" });

    const mockCheckpointNewRun = vi.fn().mockResolvedValue({
      data: { app_id: "app-123", fn_id: "fn-456", token: "token-789" },
    });

    (client as unknown as { inngestApi: Partial<InngestApi> }).inngestApi = {
      checkpointNewRun: mockCheckpointNewRun,
    } as Partial<InngestApi> as InngestApi;

    const fn = new InngestFunction(
      client,
      { id: "test-fn", triggers: [{ event: "test/event" }] },
      async () => "result",
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

    // Access private internals via bracket notation
    const engine = execution as unknown as {
      state: {
        steps: Map<string, FoundStep>;
        stepState: Record<string, unknown>;
        executingStep?: unknown;
      };
      resumeStepLocally: (result: {
        id: string;
        op: string;
        data?: unknown;
      }) => FoundStep;
    };

    return { engine };
  }

  function createMockFoundStep(overrides: Partial<FoundStep> = {}): FoundStep {
    return fromPartial({
      hashedId: "step-1",
      handled: true,
      fulfilled: false,
      hasStepState: false,
      handle: vi.fn(() => true),
      ...overrides,
    });
  }

  test("resets handled flag to false before resuming", () => {
    const { engine } = createEngine();

    const mockStep = createMockFoundStep({ handled: true });
    engine.state.steps.set("step-1", mockStep);

    engine.resumeStepLocally({
      id: "step-1",
      op: StepOpCode.StepRun,
      data: "hello",
    });

    // handle() should have been called (by resumeStepWithResult), which
    // only works if handled was reset to false first
    expect(mockStep.handle).toHaveBeenCalled();
    // After resumeStepWithResult, fulfilled should be true
    expect(mockStep.fulfilled).toBe(true);
  });

  test("clears executingStep", () => {
    const { engine } = createEngine();

    const mockStep = createMockFoundStep();
    engine.state.steps.set("step-1", mockStep);
    engine.state.executingStep = { op: StepOpCode.StepRun };

    engine.resumeStepLocally({
      id: "step-1",
      op: StepOpCode.StepRun,
      data: "hello",
    });

    expect(engine.state.executingStep).toBeUndefined();
  });

  test("returns the resumed FoundStep", () => {
    const { engine } = createEngine();

    const mockStep = createMockFoundStep();
    engine.state.steps.set("step-1", mockStep);

    const result = engine.resumeStepLocally({
      id: "step-1",
      op: StepOpCode.StepRun,
      data: "hello",
    });

    expect(result).toBe(mockStep);
    expect(result.data).toBe("hello");
  });
});
