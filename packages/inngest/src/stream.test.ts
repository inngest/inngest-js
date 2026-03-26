import { describe, expect, test, vi } from "vitest";
import type { SseEvent } from "./components/execution/streaming.ts";
import { streamRun } from "./stream.ts";

/**
 * Helper: create an async iterable from an array of SseEvents.
 */
async function* eventsFrom(events: SseEvent[]): AsyncGenerator<SseEvent> {
  for (const sseEvent of events) {
    yield sseEvent;
  }
}

describe("streamRun", () => {
  test("emits data chunks and collects them", async () => {
    const collected: { data: string; hashedStepId?: string }[] = [];

    const rs = streamRun<string>("http://test", {
      onData: (d) => collected.push(d),
    });
    rs._fromSource(
      eventsFrom([
        { type: "stream", data: "hello" },
        { type: "stream", data: " world" },
      ]),
    );

    await rs;

    expect(collected).toEqual([
      { data: "hello", hashedStepId: undefined },
      { data: " world", hashedStepId: undefined },
    ]);
    expect(rs.chunks).toEqual(["hello", " world"]);
  });

  test("calls onFunctionCompleted when succeeded result event arrives", async () => {
    const results: { data: unknown }[] = [];

    const rs = streamRun("http://test", {
      onFunctionCompleted: (info) => results.push(info),
    });
    rs._fromSource(
      eventsFrom([
        { type: "stream", data: "chunk" },
        { type: "inngest.result", status: "succeeded", data: "final" },
      ]),
    );

    await rs;

    expect(results).toEqual([{ data: "final" }]);
  });

  test("failed result event terminates stream without onFunctionCompleted", async () => {
    const completed = vi.fn();
    const done = vi.fn();

    const rs = streamRun("http://test", {
      onFunctionCompleted: completed,
      onDone: done,
    });
    rs._fromSource(
      eventsFrom([
        { type: "stream", data: "chunk" },
        {
          type: "inngest.result",
          status: "failed",
          error: "permanent failure",
        },
      ]),
    );

    await rs;

    // Failed results are an implementation detail — the server-side endpoint
    // should catch step errors and return a Response. The client stream just
    // terminates cleanly.
    expect(completed).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledOnce();
  });

  test("rolls back chunks on step error using stepId", async () => {
    const rolledBack: number[] = [];

    const rs = streamRun<string>("http://test", {
      onRollback: ({ count }) => rolledBack.push(count),
    });
    rs._fromSource(
      eventsFrom([
        { type: "inngest.step", stepId: "s1", status: "running" },
        { type: "stream", data: "a", stepId: "s1" },
        { type: "stream", data: "b", stepId: "s1" },
        {
          type: "inngest.step",
          stepId: "s1",
          status: "errored",
          data: { willRetry: true, error: "boom" },
        },
      ]),
    );

    await rs;

    expect(rolledBack).toEqual([2]);
    expect(rs.chunks).toEqual([]);
  });

  test("emits step lifecycle hooks", async () => {
    const running: { hashedStepId: string }[] = [];
    const completed: string[] = [];

    const rs = streamRun("http://test", {
      onStepRunning: (info) => running.push(info),
      onStepCompleted: (info) => completed.push(info.hashedStepId),
    });
    rs._fromSource(
      eventsFrom([
        { type: "inngest.step", stepId: "s1", status: "running" },
        { type: "inngest.step", stepId: "s1", status: "completed" },
        { type: "inngest.step", stepId: "s2", status: "running" },
        {
          type: "inngest.step",
          stepId: "s2",
          status: "errored",
          data: { willRetry: false, error: "fail" },
        },
      ]),
    );

    await rs;

    expect(running).toEqual([{ hashedStepId: "s1" }, { hashedStepId: "s2" }]);
    expect(completed).toEqual(["s1"]);
  });

  test("yields parsed chunks via async iteration", async () => {
    const rs = streamRun<number>("http://test", {
      parse: (d) => Number(d),
    });
    rs._fromSource(
      eventsFrom([
        { type: "stream", data: "42" },
        { type: "stream", data: "7" },
      ]),
    );

    const results: number[] = [];
    for await (const chunk of rs) {
      results.push(chunk);
    }

    expect(results).toEqual([42, 7]);
  });

  test("synthesizes rollback on mid-step disconnect", async () => {
    const rolledBack: number[] = [];
    const rs = streamRun<string>("http://test", {
      onRollback: ({ count }) => rolledBack.push(count),
    });
    rs._fromSource(
      eventsFrom([
        { type: "inngest.step", stepId: "s1", status: "running" },
        { type: "stream", data: "partial", stepId: "s1" },
        // Stream ends without step:completed or step:errored
      ]),
    );

    await rs;

    expect(rolledBack).toEqual([1]);
    expect(rs.chunks).toEqual([]);
  });

  test("throws if consumed twice", async () => {
    const rs = streamRun("http://test");
    rs._fromSource(eventsFrom([]));

    await rs;

    await expect(rs).rejects.toThrow("already been consumed");
  });

  test("calls onMetadata when metadata event arrives", async () => {
    const metadata: Array<{ runId: string }> = [];

    const rs = streamRun("http://test", {
      onMetadata: (info) => metadata.push(info),
    });
    rs._fromSource(
      eventsFrom([{ type: "inngest.metadata", runId: "run-123" }]),
    );

    await rs;

    expect(metadata).toEqual([{ runId: "run-123" }]);
  });

  test("stops consuming after inngest.result event", async () => {
    const collected: string[] = [];
    const done = vi.fn();

    // Simulate a source that sends a result then keeps sending (server
    // didn't close the connection). The stream should stop after result.
    async function* neverEnding(): AsyncGenerator<SseEvent> {
      yield { type: "stream", data: "a" } as SseEvent;
      yield {
        type: "inngest.result",
        status: "succeeded",
        data: "done",
      } as SseEvent;
      // These should never be reached:
      yield { type: "stream", data: "SHOULD NOT APPEAR" } as SseEvent;
    }

    const rs = streamRun<string>("http://test", {
      onData: (d) => collected.push(d.data),
      onDone: done,
    });
    rs._fromSource(neverEnding());

    await rs;

    expect(collected).toEqual(["a"]);
    expect(done).toHaveBeenCalledOnce();
  });

  test("await drives hooks without manual iteration", async () => {
    const collected: string[] = [];
    const done = vi.fn();

    const rs = streamRun<string>("http://test", {
      onData: (d) => collected.push(d.data),
      onDone: done,
    });
    rs._fromSource(
      eventsFrom([
        { type: "stream", data: "x" },
        { type: "stream", data: "y" },
      ]),
    );

    await rs;

    expect(collected).toEqual(["x", "y"]);
    expect(done).toHaveBeenCalledOnce();
  });

  test("calls onStreamError and onDone when source throws", async () => {
    const onStreamError = vi.fn();
    const onDone = vi.fn();

    async function* exploding(): AsyncGenerator<SseEvent> {
      yield { type: "stream", data: "ok" } as SseEvent;
      throw new Error("network failure");
    }

    const rs = streamRun<string>("http://test", {
      onStreamError,
      onDone,
    });
    rs._fromSource(exploding());

    await expect(rs).rejects.toThrow("network failure");

    expect(onStreamError).toHaveBeenCalledWith({
      error: expect.objectContaining({ message: "network failure" }),
    });
    expect(onDone).toHaveBeenCalledOnce();
  });

  test("calls onDone even when stream is aborted", async () => {
    const onDone = vi.fn();
    const controller = new AbortController();

    async function* abortable(): AsyncGenerator<SseEvent> {
      yield { type: "stream", data: "a" } as SseEvent;
      controller.abort();
      // Simulate abort by throwing AbortError
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    const rs = streamRun<string>("http://test", {
      signal: controller.signal,
      onDone,
    });
    rs._fromSource(abortable());

    await expect(rs).rejects.toThrow();

    expect(onDone).toHaveBeenCalledOnce();
  });

  test("does not spuriously rollback chunks between steps on disconnect", async () => {
    const rolledBack: number[] = [];

    const rs = streamRun<string>("http://test", {
      onRollback: ({ count }) => rolledBack.push(count),
    });
    rs._fromSource(
      eventsFrom([
        { type: "inngest.step", stepId: "s1", status: "running" },
        { type: "stream", data: "a", stepId: "s1" },
        { type: "inngest.step", stepId: "s1", status: "completed" },
        // Chunks emitted between steps (no stepId — outside any step)
        { type: "stream", data: "between" },
        // Stream disconnects here — no step is active, so no rollback
      ]),
    );

    await rs;

    // No rollback should occur — we're not inside a step
    expect(rolledBack).toEqual([]);
    expect(rs.chunks).toEqual(["a", "between"]);
  });

  test("forwards hashedStepId to onStepRunning", async () => {
    const running: Array<{ hashedStepId: string }> = [];

    const rs = streamRun("http://test", {
      onStepRunning: (info) => running.push(info),
    });
    rs._fromSource(
      eventsFrom([
        {
          type: "inngest.step",
          stepId: "s1",
          status: "running",
          data: { some: "info" },
        },
      ]),
    );

    await rs;

    expect(running).toEqual([{ hashedStepId: "s1" }]);
  });

  test("parallel steps: only rolls back the errored step's chunks", async () => {
    const rolledBack: number[] = [];

    const rs = streamRun<string>("http://test", {
      onRollback: ({ count }) => rolledBack.push(count),
    });
    rs._fromSource(
      eventsFrom([
        { type: "inngest.step", stepId: "A", status: "running" },
        { type: "inngest.step", stepId: "B", status: "running" },
        { type: "stream", data: "A1", stepId: "A" },
        { type: "stream", data: "B1", stepId: "B" },
        { type: "stream", data: "A2", stepId: "A" },
        {
          type: "inngest.step",
          stepId: "B",
          status: "errored",
          data: { willRetry: true, error: "fail" },
        },
        { type: "inngest.step", stepId: "A", status: "completed" },
      ]),
    );

    await rs;

    // Only B's chunk was rolled back; A's chunks survive.
    expect(rolledBack).toEqual([1]);
    expect(rs.chunks).toEqual(["A1", "A2"]);
  });

  test("no rollback when errored step had no streamed chunks", async () => {
    const rolledBack: number[] = [];

    const rs = streamRun<string>("http://test", {
      onRollback: ({ count }) => rolledBack.push(count),
    });
    rs._fromSource(
      eventsFrom([
        { type: "inngest.step", stepId: "s1", status: "running" },
        {
          type: "inngest.step",
          stepId: "s1",
          status: "errored",
          data: { willRetry: true, error: "boom" },
        },
      ]),
    );

    await rs;

    // onRollback should not fire when there's nothing to roll back
    expect(rolledBack).toEqual([]);
  });

  test("exhausted retries then permanent failure", async () => {
    const rolledBack: number[] = [];
    const done = vi.fn();
    const completed = vi.fn();

    const rs = streamRun<string>("http://test", {
      onRollback: ({ count }) => rolledBack.push(count),
      onDone: done,
      onFunctionCompleted: completed,
    });
    rs._fromSource(
      eventsFrom([
        // Attempt 1: step runs, streams, then errors with willRetry
        { type: "inngest.step", stepId: "s1", status: "running" },
        { type: "stream", data: "attempt-1-a", stepId: "s1" },
        { type: "stream", data: "attempt-1-b", stepId: "s1" },
        {
          type: "inngest.step",
          stepId: "s1",
          status: "errored",
          data: { willRetry: true, error: "transient" },
        },
        // Attempt 2: same step retries, streams, errors again
        { type: "inngest.step", stepId: "s1", status: "running" },
        { type: "stream", data: "attempt-2-a", stepId: "s1" },
        {
          type: "inngest.step",
          stepId: "s1",
          status: "errored",
          data: { willRetry: true, error: "transient again" },
        },
        // Attempt 3: same step retries, streams, errors again
        { type: "inngest.step", stepId: "s1", status: "running" },
        { type: "stream", data: "attempt-3-a", stepId: "s1" },
        { type: "stream", data: "attempt-3-b", stepId: "s1" },
        { type: "stream", data: "attempt-3-c", stepId: "s1" },
        {
          type: "inngest.step",
          stepId: "s1",
          status: "errored",
          data: { willRetry: true, error: "transient yet again" },
        },
        // Permanent failure — retries exhausted
        { type: "inngest.result", status: "failed", error: "gave up" },
      ]),
    );

    await rs;

    // Each error rolled back that attempt's chunks
    expect(rolledBack).toEqual([2, 1, 3]);
    expect(rs.chunks).toEqual([]);
    expect(completed).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledOnce();
  });

  test("rollback with pipe-style data (stream events with stepId)", async () => {
    const rolledBack: number[] = [];

    const rs = streamRun<string>("http://test", {
      onRollback: ({ count }) => rolledBack.push(count),
    });
    rs._fromSource(
      eventsFrom([
        { type: "inngest.step", stepId: "pipe-step", status: "running" },
        // Pipe-style chunks still arrive as stream events with stepId
        { type: "stream", data: "piped-chunk-1", stepId: "pipe-step" },
        { type: "stream", data: "piped-chunk-2", stepId: "pipe-step" },
        { type: "stream", data: "piped-chunk-3", stepId: "pipe-step" },
        {
          type: "inngest.step",
          stepId: "pipe-step",
          status: "errored",
          data: { willRetry: true, error: "pipe failure" },
        },
      ]),
    );

    await rs;

    expect(rolledBack).toEqual([3]);
    expect(rs.chunks).toEqual([]);
  });

  test("step that streams nothing among streaming steps", async () => {
    const rolledBack: number[] = [];
    const running: string[] = [];
    const completed: string[] = [];

    const rs = streamRun<string>("http://test", {
      onRollback: ({ count }) => rolledBack.push(count),
      onStepRunning: ({ hashedStepId }) => running.push(hashedStepId),
      onStepCompleted: ({ hashedStepId }) => completed.push(hashedStepId),
    });
    rs._fromSource(
      eventsFrom([
        // Step A: streams data
        { type: "inngest.step", stepId: "A", status: "running" },
        { type: "stream", data: "from-A-1", stepId: "A" },
        { type: "stream", data: "from-A-2", stepId: "A" },
        { type: "inngest.step", stepId: "A", status: "completed" },
        // Step B: only lifecycle events, no stream data
        { type: "inngest.step", stepId: "B", status: "running" },
        { type: "inngest.step", stepId: "B", status: "completed" },
        // Step C: streams data
        { type: "inngest.step", stepId: "C", status: "running" },
        { type: "stream", data: "from-C-1", stepId: "C" },
        { type: "inngest.step", stepId: "C", status: "completed" },
        { type: "inngest.result", status: "succeeded", data: "all done" },
      ]),
    );

    await rs;

    // All chunks survive — no spurious rollbacks
    expect(rolledBack).toEqual([]);
    expect(rs.chunks).toEqual(["from-A-1", "from-A-2", "from-C-1"]);
    // Step B's lifecycle events were still delivered
    expect(running).toEqual(["A", "B", "C"]);
    expect(completed).toEqual(["A", "B", "C"]);
  });

  test("stepless streaming (no step lifecycle events)", async () => {
    const collected: { data: string; hashedStepId?: string }[] = [];
    const rolledBack: number[] = [];
    const completed = vi.fn();

    const rs = streamRun<string>("http://test", {
      onData: (d) => collected.push(d),
      onRollback: ({ count }) => rolledBack.push(count),
      onFunctionCompleted: completed,
    });
    rs._fromSource(
      eventsFrom([
        // Only stream events — no stepId, no step lifecycle
        { type: "stream", data: "no-step-1" },
        { type: "stream", data: "no-step-2" },
        { type: "stream", data: "no-step-3" },
        { type: "inngest.result", status: "succeeded", data: "done" },
      ]),
    );

    await rs;

    expect(collected).toEqual([
      { data: "no-step-1", hashedStepId: undefined },
      { data: "no-step-2", hashedStepId: undefined },
      { data: "no-step-3", hashedStepId: undefined },
    ]);
    expect(rs.chunks).toEqual(["no-step-1", "no-step-2", "no-step-3"]);
    // No rollback since there are no steps
    expect(rolledBack).toEqual([]);
    expect(completed).toHaveBeenCalledWith({ data: "done" });
  });

  test("multiple metadata events (re-entry)", async () => {
    const metadata: Array<{ runId: string }> = [];

    const rs = streamRun<string>("http://test", {
      onMetadata: (info) => metadata.push(info),
    });
    rs._fromSource(
      eventsFrom([
        { type: "inngest.metadata", runId: "run-first" },
        { type: "stream", data: "chunk-1" },
        // Second metadata on re-entry
        { type: "inngest.metadata", runId: "run-second" },
        { type: "stream", data: "chunk-2" },
        { type: "inngest.result", status: "succeeded", data: "ok" },
      ]),
    );

    await rs;

    expect(metadata).toEqual([{ runId: "run-first" }, { runId: "run-second" }]);
    expect(rs.chunks).toEqual(["chunk-1", "chunk-2"]);
  });

  test("committed chunks survive rollback when same step ID retries", async () => {
    const rolledBack: number[] = [];

    const rs = streamRun<string>("http://test", {
      onRollback: ({ count }) => rolledBack.push(count),
    });
    rs._fromSource(
      eventsFrom([
        // Step "A" runs and completes — its chunks are committed
        { type: "inngest.step", stepId: "A", status: "running" },
        { type: "stream", data: "first-A", stepId: "A" },
        { type: "inngest.step", stepId: "A", status: "completed" },
        // Same step ID runs again (retry) and errors
        { type: "inngest.step", stepId: "A", status: "running" },
        { type: "stream", data: "retry-A", stepId: "A" },
        {
          type: "inngest.step",
          stepId: "A",
          status: "errored",
          data: { willRetry: true, error: "retry fail" },
        },
      ]),
    );

    await rs;

    // Only the retry chunk should be rolled back, not the committed one
    expect(rolledBack).toEqual([1]);
    expect(rs.chunks).toEqual(["first-A"]);
  });
});
