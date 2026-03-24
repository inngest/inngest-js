import { describe, expect, test, vi } from "vitest";
import type { SSEFrame } from "./components/execution/streaming.ts";
import { streamRun } from "./stream.ts";

/**
 * Helper: create an async iterable from an array of SSEFrames.
 */
async function* framesFrom(frames: SSEFrame[]): AsyncGenerator<SSEFrame> {
  for (const frame of frames) {
    yield frame;
  }
}

describe("streamRun", () => {
  test("emits data chunks and collects them", async () => {
    const collected: string[] = [];

    const rs = streamRun<string>("http://test", {
      onData: (d) => collected.push(d),
    });
    rs._fromSource(
      framesFrom([
        { type: "stream", data: "hello" },
        { type: "stream", data: " world" },
      ]),
    );

    await rs;

    expect(collected).toEqual(["hello", " world"]);
    expect(rs.chunks).toEqual(["hello", " world"]);
  });

  test("calls onFunctionSucceeded when succeeded result frame arrives", async () => {
    const results: unknown[] = [];

    const rs = streamRun("http://test", {
      onFunctionSucceeded: (d) => results.push(d),
    });
    rs._fromSource(
      framesFrom([
        { type: "stream", data: "chunk" },
        { type: "inngest.result", status: "succeeded", data: "final" },
      ]),
    );

    await rs;

    expect(results).toEqual(["final"]);
  });

  test("calls onFunctionFailed when failed result frame arrives", async () => {
    const errors: string[] = [];

    const rs = streamRun("http://test", {
      onFunctionFailed: (e) => errors.push(e),
    });
    rs._fromSource(
      framesFrom([
        { type: "stream", data: "chunk" },
        {
          type: "inngest.result",
          status: "failed",
          error: "Dog Speak is Much Too Hard to Translate",
        },
      ]),
    );

    await rs;

    expect(errors).toEqual(["Dog Speak is Much Too Hard to Translate"]);
  });

  test("rolls back chunks on step error using step_id", async () => {
    const rolledBack: number[] = [];

    const rs = streamRun<string>("http://test", {
      onRollback: (count) => rolledBack.push(count),
    });
    rs._fromSource(
      framesFrom([
        { type: "inngest.step", step_id: "s1", status: "running" },
        { type: "stream", data: "a", step_id: "s1" },
        { type: "stream", data: "b", step_id: "s1" },
        {
          type: "inngest.step",
          step_id: "s1",
          status: "errored",
          will_retry: true,
          error: "boom",
        },
      ]),
    );

    await rs;

    expect(rolledBack).toEqual([2]);
    expect(rs.chunks).toEqual([]);
  });

  test("emits step lifecycle hooks", async () => {
    const running: string[] = [];
    const completed: string[] = [];
    const errored: string[] = [];

    const rs = streamRun("http://test", {
      onStepRunning: (id) => running.push(id),
      onStepCompleted: (id) => completed.push(id),
      onStepErrored: (id) => errored.push(id),
    });
    rs._fromSource(
      framesFrom([
        { type: "inngest.step", step_id: "s1", status: "running" },
        { type: "inngest.step", step_id: "s1", status: "completed" },
        { type: "inngest.step", step_id: "s2", status: "running" },
        {
          type: "inngest.step",
          step_id: "s2",
          status: "errored",
          will_retry: false,
          error: "fail",
        },
      ]),
    );

    await rs;

    expect(running).toEqual(["s1", "s2"]);
    expect(completed).toEqual(["s1"]);
    expect(errored).toEqual(["s2"]);
  });

  test("yields parsed chunks via async iteration", async () => {
    const rs = streamRun<number>("http://test", {
      parse: (d) => Number(d),
    });
    rs._fromSource(
      framesFrom([
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
    const errored: Array<{ id: string; info: unknown }> = [];

    const rs = streamRun<string>("http://test", {
      onRollback: (count) => rolledBack.push(count),
      onStepErrored: (id, info) => errored.push({ id, info }),
    });
    rs._fromSource(
      framesFrom([
        { type: "inngest.step", step_id: "s1", status: "running" },
        { type: "stream", data: "partial", step_id: "s1" },
        // Stream ends without step:completed or step:errored
      ]),
    );

    await rs;

    expect(rolledBack).toEqual([1]);
    expect(errored[0]?.id).toBe("s1");
    expect(errored[0]?.info).toMatchObject({
      willRetry: false,
      error: "stream disconnected",
    });
  });

  test("throws if consumed twice", async () => {
    const rs = streamRun("http://test");
    rs._fromSource(framesFrom([]));

    await rs;

    await expect(rs).rejects.toThrow("already been consumed");
  });

  test("calls onMetadata when metadata frame arrives", async () => {
    const metadata: Array<{ runId: string }> = [];

    const rs = streamRun("http://test", {
      onMetadata: (runId) => metadata.push({ runId }),
    });
    rs._fromSource(
      framesFrom([{ type: "inngest.metadata", run_id: "run-123" }]),
    );

    await rs;

    expect(metadata).toEqual([{ runId: "run-123" }]);
  });

  test("stops consuming after inngest.result frame", async () => {
    const collected: string[] = [];
    const done = vi.fn();

    // Simulate a source that sends a result then keeps sending (server
    // didn't close the connection). The stream should stop after result.
    async function* neverEnding(): AsyncGenerator<SSEFrame> {
      yield { type: "stream", data: "a" } as SSEFrame;
      yield {
        type: "inngest.result",
        status: "succeeded",
        data: "done",
      } as SSEFrame;
      // These should never be reached:
      yield { type: "stream", data: "SHOULD NOT APPEAR" } as SSEFrame;
    }

    const rs = streamRun<string>("http://test", {
      onData: (d) => collected.push(d),
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
      onData: (d) => collected.push(d),
      onDone: done,
    });
    rs._fromSource(
      framesFrom([
        { type: "stream", data: "x" },
        { type: "stream", data: "y" },
      ]),
    );

    await rs;

    expect(collected).toEqual(["x", "y"]);
    expect(done).toHaveBeenCalledOnce();
  });

  test("calls onError and onDone when source throws", async () => {
    const onError = vi.fn();
    const onDone = vi.fn();

    async function* exploding(): AsyncGenerator<SSEFrame> {
      yield { type: "stream", data: "ok" } as SSEFrame;
      throw new Error("network failure");
    }

    const rs = streamRun<string>("http://test", {
      onError,
      onDone,
    });
    rs._fromSource(exploding());

    await expect(rs).rejects.toThrow("network failure");

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0]![0] as Error).message).toBe(
      "network failure",
    );
    expect(onDone).toHaveBeenCalledOnce();
  });

  test("calls onDone even when stream is aborted", async () => {
    const onDone = vi.fn();
    const controller = new AbortController();

    async function* abortable(): AsyncGenerator<SSEFrame> {
      yield { type: "stream", data: "a" } as SSEFrame;
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
      onRollback: (count) => rolledBack.push(count),
    });
    rs._fromSource(
      framesFrom([
        { type: "inngest.step", step_id: "s1", status: "running" },
        { type: "stream", data: "a", step_id: "s1" },
        { type: "inngest.step", step_id: "s1", status: "completed" },
        // Chunks emitted between steps (no step_id — outside any step)
        { type: "stream", data: "between" },
        // Stream disconnects here — no step is active, so no rollback
      ]),
    );

    await rs;

    // No rollback should occur — we're not inside a step
    expect(rolledBack).toEqual([]);
    expect(rs.chunks).toEqual(["a", "between"]);
  });

  test("forwards data to onStepRunning", async () => {
    const running: Array<{ id: string; data: unknown }> = [];

    const rs = streamRun("http://test", {
      onStepRunning: (id, data) => running.push({ id, data }),
    });
    rs._fromSource(
      framesFrom([
        {
          type: "inngest.step",
          step_id: "s1",
          status: "running",
          data: { some: "info" },
        },
      ]),
    );

    await rs;

    expect(running).toEqual([{ id: "s1", data: { some: "info" } }]);
  });

  test("parallel steps: only rolls back the errored step's chunks", async () => {
    const rolledBack: number[] = [];

    const rs = streamRun<string>("http://test", {
      onRollback: (count) => rolledBack.push(count),
    });
    rs._fromSource(
      framesFrom([
        { type: "inngest.step", step_id: "A", status: "running" },
        { type: "inngest.step", step_id: "B", status: "running" },
        { type: "stream", data: "A1", step_id: "A" },
        { type: "stream", data: "B1", step_id: "B" },
        { type: "stream", data: "A2", step_id: "A" },
        {
          type: "inngest.step",
          step_id: "B",
          status: "errored",
          will_retry: true,
          error: "fail",
        },
        { type: "inngest.step", step_id: "A", status: "completed" },
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
      onRollback: (count) => rolledBack.push(count),
    });
    rs._fromSource(
      framesFrom([
        { type: "inngest.step", step_id: "s1", status: "running" },
        {
          type: "inngest.step",
          step_id: "s1",
          status: "errored",
          will_retry: true,
          error: "boom",
        },
      ]),
    );

    await rs;

    // onRollback should not fire when there's nothing to roll back
    expect(rolledBack).toEqual([]);
  });

  test("committed chunks survive rollback when same step ID retries", async () => {
    const rolledBack: number[] = [];

    const rs = streamRun<string>("http://test", {
      onRollback: (count) => rolledBack.push(count),
    });
    rs._fromSource(
      framesFrom([
        // Step "A" runs and completes — its chunks are committed
        { type: "inngest.step", step_id: "A", status: "running" },
        { type: "stream", data: "first-A", step_id: "A" },
        { type: "inngest.step", step_id: "A", status: "completed" },
        // Same step ID runs again (retry) and errors
        { type: "inngest.step", step_id: "A", status: "running" },
        { type: "stream", data: "retry-A", step_id: "A" },
        {
          type: "inngest.step",
          step_id: "A",
          status: "errored",
          will_retry: true,
          error: "retry fail",
        },
      ]),
    );

    await rs;

    // Only the retry chunk should be rolled back, not the committed one
    expect(rolledBack).toEqual([1]);
    expect(rs.chunks).toEqual(["first-A"]);
  });
});
