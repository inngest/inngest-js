import { describe, expect, test, vi } from "vitest";
import type { SSEFrame } from "./components/execution/streaming.ts";
import {
  buildSSEFailedFrame,
  buildSSEMetadataFrame,
  buildSSERedirectFrame,
  buildSSEStepFrame,
  buildSSEStreamFrame,
  buildSSESucceededFrame,
} from "./components/execution/streaming.ts";
import { streamRun, subscribeToRun } from "./stream.ts";

// ---------------------------------------------------------------------------
// Helpers for subscribeToRun tests
// ---------------------------------------------------------------------------

/** Convert a typed SSEFrame to its raw SSE text using the production builders. */
function frameToSSE(f: SSEFrame): string {
  switch (f.type) {
    case "inngest.metadata":
      return buildSSEMetadataFrame(f.run_id);
    case "stream":
      return buildSSEStreamFrame(f.data, f.step_id);
    case "inngest.redirect_info":
      return buildSSERedirectFrame({
        run_id: f.run_id,
        token: f.token,
        url: f.url,
      });
    case "inngest.result":
      return f.status === "succeeded"
        ? buildSSESucceededFrame(f.data)
        : buildSSEFailedFrame(f.error);
    case "inngest.step":
      return buildSSEStepFrame(
        f.step_id,
        f.status,
        f.status === "errored"
          ? { will_retry: f.will_retry, error: f.error }
          : undefined,
      );
  }
}

/**
 * Serialize an array of typed SSEFrames into raw SSE text and wrap it in a
 * Response with a ReadableStream body — the same shape that `fetch()` returns.
 */
function mockSSEResponse(frames: SSEFrame[]): Response {
  const encoder = new TextEncoder();
  const text = frames.map(frameToSSE).join("");

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** Collect all frames from an async generator into an array. */
async function collectFrames(
  gen: AsyncGenerator<SSEFrame>,
): Promise<SSEFrame[]> {
  const frames: SSEFrame[] = [];
  for await (const frame of gen) {
    frames.push(frame);
  }
  return frames;
}

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

// ---------------------------------------------------------------------------
// subscribeToRun tests
// ---------------------------------------------------------------------------

describe("subscribeToRun", () => {
  test("follows redirect after direct stream closes (baseline)", async () => {
    const directFrames: SSEFrame[] = [
      { type: "inngest.metadata", run_id: "run-1" },
      { type: "stream", data: "a" },
      {
        type: "inngest.redirect_info",
        run_id: "run-1",
        token: "tok",
        url: "http://redirect",
      },
      { type: "stream", data: "b" },
    ];
    const redirectFrames: SSEFrame[] = [
      { type: "inngest.metadata", run_id: "run-1" },
      { type: "stream", data: "c" },
      { type: "inngest.result", status: "succeeded", data: "done" },
    ];

    const fetchSpy = vi.fn<typeof globalThis.fetch>();
    fetchSpy.mockResolvedValueOnce(mockSSEResponse(directFrames));
    fetchSpy.mockResolvedValueOnce(mockSSEResponse(redirectFrames));

    const frames = await collectFrames(
      subscribeToRun({ url: "http://de", fetch: fetchSpy }),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://de");
    expect(fetchSpy.mock.calls[1]![0]).toBe("http://redirect");

    const types = frames.map((f) => f.type);
    expect(types).toEqual([
      "inngest.metadata",
      "stream",
      "inngest.redirect_info",
      "stream",
      "inngest.metadata",
      "stream",
      "inngest.result",
    ]);
  });

  test("eagerly connects to redirect URL when redirect_info is received", async () => {
    // Track when each fetch call starts relative to the direct stream ending.
    let directStreamDone = false;
    let eagerFetchStartedBeforeDirectDone = false;

    const redirectFrames: SSEFrame[] = [
      { type: "stream", data: "c" },
      { type: "inngest.result", status: "succeeded", data: "ok" },
    ];

    const fetchSpy = vi.fn<typeof globalThis.fetch>();

    // Direct stream: use a custom ReadableStream so we can detect when it
    // finishes being read vs when the second fetch is started.
    const directSSE: SSEFrame[] = [
      { type: "stream", data: "a" },
      {
        type: "inngest.redirect_info",
        run_id: "r",
        token: "t",
        url: "http://redirect",
      },
      { type: "stream", data: "b" },
    ];

    const encoder = new TextEncoder();
    const directSSEText = directSSE.map(frameToSSE).join("");

    const slowDirectBody = new ReadableStream<Uint8Array>({
      async start(controller) {
        // Enqueue all frames
        controller.enqueue(encoder.encode(directSSEText));
        // Delay before closing to give the eager fetch time to fire
        await new Promise((r) => setTimeout(r, 20));
        directStreamDone = true;
        controller.close();
      },
    });

    fetchSpy.mockImplementation(async (url) => {
      if (url === "http://de") {
        return new Response(slowDirectBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      // This is the redirect fetch — record whether it started before the
      // direct stream finished.
      if (!directStreamDone) {
        eagerFetchStartedBeforeDirectDone = true;
      }
      return mockSSEResponse(redirectFrames);
    });

    const frames = await collectFrames(
      subscribeToRun({ url: "http://de", fetch: fetchSpy }),
    );

    expect(eagerFetchStartedBeforeDirectDone).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Frames still arrive in the correct order: all direct frames first.
    const streamData = frames
      .filter((f): f is SSEFrame & { type: "stream" } => f.type === "stream")
      .map((f) => f.data);
    expect(streamData).toEqual(["a", "b", "c"]);
  });

  test("yields all direct stream frames before any redirect stream frames", async () => {
    const fetchSpy = vi.fn<typeof globalThis.fetch>();
    fetchSpy.mockResolvedValueOnce(
      mockSSEResponse([
        { type: "stream", data: "a" },
        {
          type: "inngest.redirect_info",
          run_id: "r",
          token: "t",
          url: "http://redirect",
        },
        { type: "stream", data: "b" },
      ]),
    );
    fetchSpy.mockResolvedValueOnce(
      mockSSEResponse([{ type: "stream", data: "c" }]),
    );

    const frames = await collectFrames(
      subscribeToRun({ url: "http://de", fetch: fetchSpy }),
    );

    const streamData = frames
      .filter((f): f is SSEFrame & { type: "stream" } => f.type === "stream")
      .map((f) => f.data);
    expect(streamData).toEqual(["a", "b", "c"]);
  });

  test("falls back to fresh fetch when eager fetch fails", async () => {
    const fetchSpy = vi.fn<typeof globalThis.fetch>();

    // Direct stream with redirect.
    fetchSpy.mockResolvedValueOnce(
      mockSSEResponse([
        { type: "stream", data: "a" },
        {
          type: "inngest.redirect_info",
          run_id: "r",
          token: "t",
          url: "http://redirect",
        },
      ]),
    );
    // Eager fetch fails.
    fetchSpy.mockRejectedValueOnce(new Error("network blip"));
    // Fallback fetch succeeds.
    fetchSpy.mockResolvedValueOnce(
      mockSSEResponse([
        { type: "stream", data: "b" },
        { type: "inngest.result", status: "succeeded", data: "ok" },
      ]),
    );

    const frames = await collectFrames(
      subscribeToRun({ url: "http://de", fetch: fetchSpy }),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const streamData = frames
      .filter((f): f is SSEFrame & { type: "stream" } => f.type === "stream")
      .map((f) => f.data);
    expect(streamData).toEqual(["a", "b"]);
  });

  test("does not retry when abort signal fires", async () => {
    const controller = new AbortController();
    const fetchSpy = vi.fn<typeof globalThis.fetch>();

    // Direct stream: abort mid-read.
    const encoder = new TextEncoder();
    const redirectFrame: SSEFrame = {
      type: "inngest.redirect_info",
      run_id: "r",
      token: "t",
      url: "http://redirect",
    };
    let abortController: ReadableStreamDefaultController<Uint8Array>;
    const directBody = new ReadableStream<Uint8Array>({
      start(ctrl) {
        abortController = ctrl;
        ctrl.enqueue(encoder.encode(frameToSSE(redirectFrame)));
      },
      pull() {
        // Abort on the second pull (after the redirect frame has been read).
        controller.abort();
        abortController.error(
          new DOMException("The operation was aborted.", "AbortError"),
        );
      },
    });

    fetchSpy.mockImplementation(async (url) => {
      if (url === "http://de") {
        return new Response(directBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      // Eager/fallback fetch — should receive the signal.
      return mockSSEResponse([]);
    });

    const gen = subscribeToRun({
      url: "http://de",
      fetch: fetchSpy,
      signal: controller.signal,
    });

    await expect(collectFrames(gen)).rejects.toThrow();

    // Exactly one redirect call (the eager fetch) — no fallback retry.
    const redirectCalls = fetchSpy.mock.calls.filter(
      (c) => c[0] === "http://redirect",
    );
    expect(redirectCalls.length).toBe(1);
  });

  test("cleans up eager response body when direct stream errors", async () => {
    const cancelSpy = vi.fn();
    const fetchSpy = vi.fn<typeof globalThis.fetch>();

    const encoder = new TextEncoder();
    const redirectFrame: SSEFrame = {
      type: "inngest.redirect_info",
      run_id: "r",
      token: "t",
      url: "http://redirect",
    };

    // Direct stream: emit a redirect frame, then yield to let the eager fetch
    // start, then error on the next read.
    let errorController: ReadableStreamDefaultController<Uint8Array>;
    const directBody = new ReadableStream<Uint8Array>({
      start(ctrl) {
        errorController = ctrl;
        ctrl.enqueue(encoder.encode(frameToSSE(redirectFrame)));
      },
      pull() {
        // Error on the second pull (after the redirect frame has been read).
        errorController.error(new Error("connection reset"));
      },
    });

    // Build a response whose body.cancel() we can spy on.
    const streamFrame: SSEFrame = { type: "stream", data: "x" };
    const eagerBody = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(encoder.encode(frameToSSE(streamFrame)));
        ctrl.close();
      },
      cancel: cancelSpy,
    });

    fetchSpy.mockImplementation(async (url) => {
      if (url === "http://de") {
        return new Response(directBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return new Response(eagerBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    await expect(
      collectFrames(subscribeToRun({ url: "http://de", fetch: fetchSpy })),
    ).rejects.toThrow("connection reset");

    // Give the finally block's async cleanup a tick to run.
    await new Promise((r) => setTimeout(r, 50));
    expect(cancelSpy).toHaveBeenCalled();
  });

  test("skips eager fetch when redirect_info has no url", async () => {
    const fetchSpy = vi.fn<typeof globalThis.fetch>();
    fetchSpy.mockResolvedValueOnce(
      mockSSEResponse([
        {
          type: "inngest.redirect_info",
          run_id: "r",
          token: "t",
        } as SSEFrame,
      ]),
    );

    const frames = await collectFrames(
      subscribeToRun({ url: "http://de", fetch: fetchSpy }),
    );

    // Only one fetch — no eager fetch, no redirect follow.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.type).toBe("inngest.redirect_info");
  });

  test("only starts one eager fetch even if multiple redirect frames arrive", async () => {
    const fetchSpy = vi.fn<typeof globalThis.fetch>();
    fetchSpy.mockResolvedValueOnce(
      mockSSEResponse([
        {
          type: "inngest.redirect_info",
          run_id: "r",
          token: "t",
          url: "http://first",
        },
        {
          type: "inngest.redirect_info",
          run_id: "r",
          token: "t2",
          url: "http://second",
        },
      ]),
    );
    // The eager fetch (to http://first) succeeds.
    fetchSpy.mockResolvedValueOnce(
      mockSSEResponse([{ type: "stream", data: "from-redirect" }]),
    );

    await collectFrames(subscribeToRun({ url: "http://de", fetch: fetchSpy }));

    // Two fetches total: original + one eager. No second eager fetch.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test("forwards abort signal to eager fetch", async () => {
    const controller = new AbortController();
    const signals: Array<AbortSignal | undefined> = [];
    const fetchSpy = vi.fn<typeof globalThis.fetch>();

    fetchSpy.mockImplementation(async (_url, init) => {
      signals.push((init as RequestInit)?.signal ?? undefined);
      return mockSSEResponse([
        {
          type: "inngest.redirect_info",
          run_id: "r",
          token: "t",
          url: "http://redirect",
        },
      ]);
    });

    await collectFrames(
      subscribeToRun({
        url: "http://de",
        fetch: fetchSpy,
        signal: controller.signal,
      }),
    );

    // Both the direct and eager fetch should have received the signal.
    expect(signals.length).toBeGreaterThanOrEqual(2);
    for (const sig of signals) {
      expect(sig).toBe(controller.signal);
    }
  });

  test("falls back to fresh fetch when eager fetch returns non-200", async () => {
    const fetchSpy = vi.fn<typeof globalThis.fetch>();

    // Direct stream with redirect.
    fetchSpy.mockResolvedValueOnce(
      mockSSEResponse([
        { type: "stream", data: "a" },
        {
          type: "inngest.redirect_info",
          run_id: "r",
          token: "t",
          url: "http://redirect",
        },
      ]),
    );
    // Eager fetch returns 502.
    fetchSpy.mockResolvedValueOnce(
      new Response(null, { status: 502, statusText: "Bad Gateway" }),
    );
    // Fallback fetch succeeds.
    fetchSpy.mockResolvedValueOnce(
      mockSSEResponse([
        { type: "stream", data: "b" },
        { type: "inngest.result", status: "succeeded", data: "ok" },
      ]),
    );

    const frames = await collectFrames(
      subscribeToRun({ url: "http://de", fetch: fetchSpy }),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    // Fallback used the correct URL.
    expect(fetchSpy.mock.calls[2]![0]).toBe("http://redirect");

    const streamData = frames
      .filter((f): f is SSEFrame & { type: "stream" } => f.type === "stream")
      .map((f) => f.data);
    expect(streamData).toEqual(["a", "b"]);
  });

  test("completes without redirect when no redirect frame is received", async () => {
    const fetchSpy = vi.fn<typeof globalThis.fetch>();
    fetchSpy.mockResolvedValueOnce(
      mockSSEResponse([
        { type: "inngest.metadata", run_id: "run-1" },
        { type: "stream", data: "hello" },
        { type: "inngest.result", status: "succeeded", data: "done" },
      ]),
    );

    const frames = await collectFrames(
      subscribeToRun({ url: "http://de", fetch: fetchSpy }),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(3);

    const types = frames.map((f) => f.type);
    expect(types).toEqual(["inngest.metadata", "stream", "inngest.result"]);
  });
});
