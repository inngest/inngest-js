import { describe, expect, test, vi } from "vitest";
import type { SSEFrame } from "./components/execution/streaming.ts";
import { RunStream } from "./stream.ts";

/**
 * Helper: create an async iterable from an array of SSEFrames.
 */
async function* framesFrom(frames: SSEFrame[]): AsyncGenerator<SSEFrame> {
  for (const frame of frames) {
    yield frame;
  }
}

describe("RunStream", () => {
  test("emits data chunks and collects them", async () => {
    const collected: string[] = [];

    const rs = new RunStream<string>({ url: "http://test" });
    rs._fromSource(
      framesFrom([
        { type: "stream", data: "hello" },
        { type: "stream", data: " world" },
      ]),
    );
    rs.onData((d) => collected.push(d));

    for await (const chunk of rs) {
      // iteration drives the pump
    }

    expect(collected).toEqual(["hello", " world"]);
    expect(rs.chunks).toEqual(["hello", " world"]);
  });

  test("calls onResult when result frame arrives", async () => {
    const results: unknown[] = [];

    const rs = new RunStream({ url: "http://test" });
    rs._fromSource(
      framesFrom([
        { type: "stream", data: "chunk" },
        { type: "inngest.result", data: "final" },
      ]),
    );
    rs.onResult((d) => results.push(d));

    for await (const _ of rs) {
      // drain
    }

    expect(results).toEqual(["final"]);
  });

  test("rolls back chunks on step error", async () => {
    const rolledBack: unknown[][] = [];

    const rs = new RunStream<string>({ url: "http://test" });
    rs._fromSource(
      framesFrom([
        { type: "inngest.step", step_id: "s1", status: "running" },
        { type: "stream", data: "a" },
        { type: "stream", data: "b" },
        {
          type: "inngest.step",
          step_id: "s1",
          status: "errored",
          data: { will_retry: true, error: "boom", attempt: 0 },
        },
      ]),
    );
    rs.onRollback((chunks) => rolledBack.push([...chunks]));

    for await (const _ of rs) {
      // drain
    }

    expect(rolledBack).toEqual([["a", "b"]]);
    expect(rs.chunks).toEqual([]);
  });

  test("emits step lifecycle hooks", async () => {
    const running: string[] = [];
    const completed: string[] = [];
    const errored: string[] = [];

    const rs = new RunStream({ url: "http://test" });
    rs._fromSource(
      framesFrom([
        { type: "inngest.step", step_id: "s1", status: "running" },
        { type: "inngest.step", step_id: "s1", status: "completed" },
        { type: "inngest.step", step_id: "s2", status: "running" },
        {
          type: "inngest.step",
          step_id: "s2",
          status: "errored",
          data: { will_retry: false, error: "fail", attempt: 1 },
        },
      ]),
    );
    rs.onStepRunning((id) => running.push(id));
    rs.onStepCompleted((id) => completed.push(id));
    rs.onStepErrored((id) => errored.push(id));

    for await (const _ of rs) {
      // drain
    }

    expect(running).toEqual(["s1", "s2"]);
    expect(completed).toEqual(["s1"]);
    expect(errored).toEqual(["s2"]);
  });

  test("uses parse function to transform data", async () => {
    const rs = new RunStream<number>({
      url: "http://test",
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

  test("calls onDone when stream completes", async () => {
    const done = vi.fn();

    const rs = new RunStream({ url: "http://test" });
    rs._fromSource(framesFrom([{ type: "stream", data: "x" }]));
    rs.onDone(done);

    for await (const _ of rs) {
      // drain
    }

    expect(done).toHaveBeenCalledOnce();
  });

  test("synthesizes rollback on mid-step disconnect", async () => {
    const rolledBack: unknown[][] = [];
    const errored: Array<{ id: string; info: unknown }> = [];

    const rs = new RunStream<string>({ url: "http://test" });
    rs._fromSource(
      framesFrom([
        { type: "inngest.step", step_id: "s1", status: "running" },
        { type: "stream", data: "partial" },
        // Stream ends without step:completed or step:errored
      ]),
    );
    rs.onRollback((chunks) => rolledBack.push([...chunks]));
    rs.onStepErrored((id, info) => errored.push({ id, info }));

    for await (const _ of rs) {
      // drain
    }

    expect(rolledBack).toEqual([["partial"]]);
    expect(errored[0]?.id).toBe("s1");
    expect(errored[0]?.info).toMatchObject({
      willRetry: false,
      error: "stream disconnected",
    });
  });

  test("throws if consumed twice", async () => {
    const rs = new RunStream({ url: "http://test" });
    rs._fromSource(framesFrom([]));

    for await (const _ of rs) {
      // drain
    }

    await expect(async () => {
      for await (const _ of rs) {
        // should throw
      }
    }).rejects.toThrow("already been consumed");
  });

  test("calls onMetadata when metadata frame arrives", async () => {
    const metadata: Array<{ runId: string; attempt: number }> = [];

    const rs = new RunStream({ url: "http://test" });
    rs._fromSource(
      framesFrom([
        { type: "inngest.metadata", run_id: "run-123", attempt: 0 },
      ]),
    );
    rs.onMetadata((runId, attempt) => metadata.push({ runId, attempt }));

    for await (const _ of rs) {
      // drain
    }

    expect(metadata).toEqual([{ runId: "run-123", attempt: 0 }]);
  });

  test("stops consuming after inngest.result frame", async () => {
    const collected: string[] = [];
    const done = vi.fn();

    // Simulate a source that sends a result then keeps sending (server
    // didn't close the connection). The RunStream should stop after result.
    async function* neverEnding(): AsyncGenerator<SSEFrame> {
      yield { type: "stream", data: "a" } as SSEFrame;
      yield { type: "inngest.result", data: "done" } as SSEFrame;
      // These should never be reached:
      yield { type: "stream", data: "SHOULD NOT APPEAR" } as SSEFrame;
    }

    const rs = new RunStream<string>({ url: "http://test" });
    rs._fromSource(neverEnding());
    rs.onData((d) => collected.push(d));
    rs.onDone(done);

    for await (const _ of rs) {
      // drain
    }

    expect(collected).toEqual(["a"]);
    expect(done).toHaveBeenCalledOnce();
  });

  test("start() drives hooks without iteration", async () => {
    const collected: string[] = [];
    const done = vi.fn();

    const rs = new RunStream<string>({ url: "http://test" });
    rs._fromSource(
      framesFrom([
        { type: "stream", data: "x" },
        { type: "stream", data: "y" },
      ]),
    );
    rs.onData((d) => collected.push(d));
    rs.onDone(done);

    await rs.start();

    expect(collected).toEqual(["x", "y"]);
    expect(done).toHaveBeenCalledOnce();
  });
});
