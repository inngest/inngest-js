import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { InngestApi } from "../../api/api.ts";
import { stream } from "../../experimental/durable-endpoints/index.ts";
import { ExecutionVersion } from "../../helpers/consts.ts";
import {
  createDeferredPromise,
  resolveAfterPending,
} from "../../helpers/promises.ts";
import { createClient, runFnWithStack } from "../../test/helpers.ts";
import { StepMode, StepOpCode } from "../../types.ts";
import { internalLoggerSymbol } from "../Inngest.ts";
import { Middleware } from "../middleware/middleware.ts";

describe("execution lifecycle middleware", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("awaits invocation cleanup after successful completion", async () => {
    const cleanupStarted = createDeferredPromise<void>();
    const finishCleanup = createDeferredPromise<void>();
    const lifecycle: string[] = [];
    class Lifecycle extends Middleware.BaseMiddleware {
      readonly id = "lifecycle";
      override onRunComplete() {
        lifecycle.push("complete");
      }
      override async onExecutionEnd() {
        lifecycle.push("cleanup started");
        cleanupStarted.resolve();
        await finishCleanup.promise;
        lifecycle.push("cleanup finished");
      }
    }
    const client = createClient({ id: "test", middleware: [Lifecycle] });
    const fn = client.createFunction({ id: "fn" }, async () => "done");
    const resultPromise = runFnWithStack(fn, {}).then((result) => {
      lifecycle.push("returned");
      return result;
    });

    await cleanupStarted.promise;
    await resolveAfterPending();
    expect(lifecycle).toEqual(["complete", "cleanup started"]);
    finishCleanup.resolve();

    expect(await resultPromise).toMatchObject({
      type: "function-resolved",
      data: "done",
    });
    expect(lifecycle).toEqual([
      "complete",
      "cleanup started",
      "cleanup finished",
      "returned",
    ]);
  });

  test("ends each suspended invocation without completing the durable run", async () => {
    const ended = vi.fn();
    const completed = vi.fn();
    class Lifecycle extends Middleware.BaseMiddleware {
      readonly id = "lifecycle";
      override onExecutionEnd = ended;
      override onRunComplete = completed;
    }
    const client = createClient({ id: "test", middleware: [Lifecycle] });
    const fn = client.createFunction({ id: "fn" }, async ({ step }) => {
      await step.sleep("pause", "1s");
      return "done";
    });

    const result = await runFnWithStack(fn, {});
    expect(result).toMatchObject({
      type: "steps-found",
      steps: [expect.objectContaining({ op: StepOpCode.Sleep })],
    });
    expect(ended).toHaveBeenCalledTimes(1);
    expect(completed).not.toHaveBeenCalled();

    await runFnWithStack(fn, {});
    expect(ended).toHaveBeenCalledTimes(2);
    expect(completed).not.toHaveBeenCalled();
  });

  test.each(["success", "failure"] as const)(
    "isolates failed cleanup and preserves the function's %s",
    async (outcome) => {
      const cleanupError = new Error("cleanup failed");
      const laterCleanup = vi.fn();
      const runError = vi.fn();
      class FailingCleanup extends Middleware.BaseMiddleware {
        readonly id = "failing-cleanup";
        override onRunError = runError;
        override async onExecutionEnd() {
          throw cleanupError;
        }
      }
      class LaterCleanup extends Middleware.BaseMiddleware {
        readonly id = "later-cleanup";
        override onExecutionEnd = laterCleanup;
      }
      const client = createClient({
        id: "test",
        middleware: [LaterCleanup, FailingCleanup],
      });
      const logError = vi
        .spyOn(client[internalLoggerSymbol], "error")
        .mockImplementation(() => {});
      const fn = client.createFunction({ id: "fn" }, async () => {
        if (outcome === "failure") {
          throw new Error("handler failed");
        }
        return "done";
      });

      const result = await runFnWithStack(fn, {});
      if (outcome === "failure") {
        expect(result).toMatchObject({
          type: "function-rejected",
          error: expect.objectContaining({ message: "handler failed" }),
        });
        expect(runError).toHaveBeenCalledTimes(1);
      } else {
        expect(result).toMatchObject({
          type: "function-resolved",
          data: "done",
        });
        expect(runError).not.toHaveBeenCalled();
      }
      expect(laterCleanup).toHaveBeenCalledTimes(1);
      expect(logError).toHaveBeenCalledWith(
        {
          err: cleanupError,
          hook: "onExecutionEnd",
          mw: "failing-cleanup",
        },
        "middleware error",
      );
    },
  );

  test.each(["resolve", "reject"] as const)(
    "ignores an abandoned handler that cleanup causes to %s",
    async (settlement) => {
      const abandoned = createDeferredPromise<void>();
      const runError = vi.fn();
      const runComplete = vi.fn();
      class Lifecycle extends Middleware.BaseMiddleware {
        readonly id = "lifecycle";
        override onRunError = runError;
        override onRunComplete = runComplete;
        override async onExecutionEnd() {
          if (settlement === "reject") {
            abandoned.reject(new Error("interrupted during teardown"));
          } else {
            abandoned.resolve();
          }
          await resolveAfterPending();
        }
      }
      const client = createClient({ id: "test", middleware: [Lifecycle] });
      const fn = client.createFunction({ id: "fn" }, async ({ step }) => {
        await Promise.race([step.sleep("pause", "1s"), abandoned.promise]);
        return "abandoned handler finished";
      });

      const result = await runFnWithStack(fn, {});
      await resolveAfterPending();
      expect(result).toMatchObject({ type: "steps-found" });
      expect(runError).not.toHaveBeenCalled();
      expect(runComplete).not.toHaveBeenCalled();
    },
  );

  test("keeps execution alive after an early SSE response until streaming work ends", async () => {
    const finishStep = createDeferredPromise<void>();
    const cleanupFinished = createDeferredPromise<void>();
    const ended = vi.fn();
    class Lifecycle extends Middleware.BaseMiddleware {
      readonly id = "lifecycle";
      override onExecutionEnd() {
        ended();
        cleanupFinished.resolve();
      }
    }
    const client = createClient({ id: "test", middleware: [Lifecycle] });
    const api: Partial<InngestApi> = {
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
    };
    // Replace the private API only at this test boundary to avoid network I/O.
    const streamingClient = client as unknown as {
      inngestApi: Partial<InngestApi>;
    };
    streamingClient.inngestApi = api;
    const fn = client.createFunction({ id: "fn" }, async ({ step }) => {
      await step.run("streaming-step", async () => {
        stream.push("partial");
        await finishStep.promise;
        return "step result";
      });
      return "done";
    });
    const execution = fn["createExecution"]({
      partialOptions: {
        client,
        data: fromPartial({ event: { name: "test/event", data: {} } }),
        runId: "test-run-id",
        stepState: {},
        stepCompletionOrder: [],
        reqArgs: [],
        headers: {},
        stepMode: StepMode.Sync,
        acceptsSse: true,
        createResponse: async (data: unknown) => ({
          status: 200,
          body: JSON.stringify(data),
          headers: {},
          version: ExecutionVersion.V2,
        }),
      },
    });

    const result = await execution.start();
    expect(result.type).toBe("function-resolved");
    expect(ended).not.toHaveBeenCalled();

    finishStep.resolve();
    if (result.type !== "function-resolved") {
      throw new Error("Expected a streaming response");
    }
    await (result.data as Response).text();
    await cleanupFinished.promise;
    expect(ended).toHaveBeenCalledTimes(1);
  });
});
