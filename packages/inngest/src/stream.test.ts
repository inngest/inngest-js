import { describe, expect, it, vi } from "vitest";
import type { SSEFrame } from "./components/execution/streaming.ts";
import { RunStream } from "./stream.ts";

/** Helper to create a mock source from an array of SSEFrame values. */
function mockSource(frames: SSEFrame[]): () => AsyncGenerator<SSEFrame> {
  return async function* () {
    for (const frame of frames) {
      yield frame;
    }
  };
}

describe("RunStream", () => {
  describe("accumulator", () => {
    it("grows on data and splices on rollback", async () => {
      const source = mockSource([
        { type: "metadata", run_id: "run-1", attempt: 0 },
        { type: "step", id: "s1", status: "running" },
        { type: "stream", data: "a" },
        { type: "stream", data: "b" },
        { type: "stream", data: "c" },
        {
          type: "step",
          id: "s1",
          status: "errored",
          error: "boom",
          will_retry: true,
        },
        // After rollback, step restarts
        { type: "step", id: "s1", status: "running" },
        { type: "stream", data: "d" },
        { type: "step", id: "s1", status: "completed" },
      ] as SSEFrame[]);

      const run = RunStream._fromSource<string>(source);
      await run.start();

      expect([...run.chunks]).toEqual(["d"]);
    });

    it("does not roll back data emitted outside step boundaries", async () => {
      const source = mockSource([
        { type: "metadata", run_id: "run-1", attempt: 0 },
        { type: "stream", data: "outside" },
        { type: "step", id: "s1", status: "running" },
        { type: "stream", data: "inside" },
        {
          type: "step",
          id: "s1",
          status: "errored",
          error: "boom",
          will_retry: true,
        },
      ] as SSEFrame[]);

      const run = RunStream._fromSource<string>(source);
      await run.start();

      expect([...run.chunks]).toEqual(["outside"]);
    });
  });

  describe("hooks", () => {
    it("fires onData with correct args, accumulator already updated", async () => {
      const source = mockSource([
        { type: "metadata", run_id: "run-1", attempt: 0 },
        { type: "stream", data: "hello" },
      ] as SSEFrame[]);

      const onData = vi.fn();
      const run = RunStream._fromSource<string>(source);
      run.onData(onData);
      await run.start();

      expect(onData).toHaveBeenCalledOnce();
      expect(onData).toHaveBeenCalledWith("hello", ["hello"]);
    });

    it("fires onRollback with removed items and remaining chunks", async () => {
      const source = mockSource([
        { type: "metadata", run_id: "run-1", attempt: 0 },
        { type: "step", id: "s1", status: "running" },
        { type: "stream", data: "a" },
        { type: "stream", data: "b" },
        {
          type: "step",
          id: "s1",
          status: "errored",
          error: "boom",
          will_retry: true,
        },
      ] as SSEFrame[]);

      const onRollback = vi.fn();
      const run = RunStream._fromSource<string>(source);
      run.onRollback(onRollback);
      await run.start();

      expect(onRollback).toHaveBeenCalledOnce();
      // First arg: removed items, second arg: remaining chunks (already spliced)
      expect(onRollback).toHaveBeenCalledWith(["a", "b"], [], "s1", 0);
    });

    it("fires onResult", async () => {
      const source = mockSource([
        { type: "metadata", run_id: "run-1", attempt: 0 },
        { type: "result", data: "final" },
      ] as SSEFrame[]);

      const onResult = vi.fn();
      const run = RunStream._fromSource<string>(source);
      run.onResult(onResult);
      await run.start();

      expect(onResult).toHaveBeenCalledWith("final");
    });

    it("fires onConnected", async () => {
      const source = mockSource([
        { type: "metadata", run_id: "run-42", attempt: 3 },
      ] as SSEFrame[]);

      const onConnected = vi.fn();
      const run = RunStream._fromSource<string>(source);
      run.onConnected(onConnected);
      await run.start();

      expect(onConnected).toHaveBeenCalledWith("run-42", 3);
    });

    it("fires onStepStarted and onStepCompleted", async () => {
      const source = mockSource([
        { type: "metadata", run_id: "run-1", attempt: 0 },
        { type: "step", id: "my-step", status: "running" },
        { type: "step", id: "my-step", status: "completed" },
      ] as SSEFrame[]);

      const onStepStarted = vi.fn();
      const onStepCompleted = vi.fn();
      const run = RunStream._fromSource<string>(source);
      run.onStepStarted(onStepStarted);
      run.onStepCompleted(onStepCompleted);
      await run.start();

      expect(onStepStarted).toHaveBeenCalledWith("my-step");
      expect(onStepCompleted).toHaveBeenCalledWith("my-step");
    });

    it("fires onStepErrored", async () => {
      const source = mockSource([
        { type: "metadata", run_id: "run-1", attempt: 0 },
        { type: "step", id: "s1", status: "running" },
        {
          type: "step",
          id: "s1",
          status: "errored",
          error: "bad",
          will_retry: false,
        },
      ] as SSEFrame[]);

      const onStepErrored = vi.fn();
      const run = RunStream._fromSource<string>(source);
      run.onStepErrored(onStepErrored);
      await run.start();

      expect(onStepErrored).toHaveBeenCalledWith("s1", "bad", false, 0);
    });
  });

  describe("double consumption", () => {
    it("throws on second iteration", async () => {
      const source = mockSource([
        { type: "metadata", run_id: "run-1", attempt: 0 },
      ] as SSEFrame[]);

      const run = RunStream._fromSource<string>(source);
      await run.start();

      await expect(async () => {
        for await (const _ of run) {
          void _;
        }
      }).rejects.toThrow("RunStream has already been consumed");
    });
  });

  describe(".start()", () => {
    it("returns wrapped result data", async () => {
      const source = mockSource([
        { type: "metadata", run_id: "run-1", attempt: 0 },
        { type: "stream", data: "chunk" },
        { type: "result", data: "done" },
      ] as SSEFrame[]);

      const run = RunStream._fromSource<string>(source);
      const result = await run.start();

      expect(result).toEqual({ result: "done" });
    });

    it("returns undefined when stream ends without result", async () => {
      const source = mockSource([
        { type: "metadata", run_id: "run-1", attempt: 0 },
        { type: "stream", data: "chunk" },
      ] as SSEFrame[]);

      const run = RunStream._fromSource<string>(source);
      const result = await run.start();

      expect(result).toBeUndefined();
    });
  });

  describe("hooks + iteration coexistence", () => {
    it("hooks fire during for-await iteration", async () => {
      const source = mockSource([
        { type: "metadata", run_id: "run-1", attempt: 0 },
        { type: "stream", data: "a" },
        { type: "stream", data: "b" },
        { type: "result", data: "fin" },
      ] as SSEFrame[]);

      const onData = vi.fn();
      const onResult = vi.fn();
      const events: string[] = [];

      const run = RunStream._fromSource<string>(source);
      run.onData(onData).onResult(onResult);

      for await (const event of run) {
        events.push(event.type);
      }

      expect(events).toEqual(["connected", "data", "data", "result"]);
      expect(onData).toHaveBeenCalledTimes(2);
      expect(onResult).toHaveBeenCalledOnce();
    });
  });

  describe("synthetic disconnect rollback", () => {
    it("emits rollback when stream ends mid-step", async () => {
      const source = mockSource([
        { type: "metadata", run_id: "run-1", attempt: 0 },
        { type: "step", id: "s1", status: "running" },
        { type: "stream", data: "x" },
        { type: "stream", data: "y" },
        // Stream ends without step completing
      ] as SSEFrame[]);

      const onRollback = vi.fn();
      const onStepErrored = vi.fn();
      const events: string[] = [];

      const run = RunStream._fromSource<string>(source);
      run.onRollback(onRollback).onStepErrored(onStepErrored);

      for await (const event of run) {
        events.push(event.type);
      }

      expect(events).toContain("rollback");
      expect(onRollback).toHaveBeenCalledWith(["x", "y"], [], "s1", 0);
      expect(onStepErrored).toHaveBeenCalledWith(
        "s1",
        "Stream disconnected during step execution",
        false,
        0,
      );
      expect([...run.chunks]).toEqual([]);
    });
  });

  describe("chaining", () => {
    it("all hook methods return this for chaining", async () => {
      const source = mockSource([
        { type: "metadata", run_id: "run-1", attempt: 0 },
        { type: "result", data: "ok" },
      ] as SSEFrame[]);

      const noop = () => {};
      const run = RunStream._fromSource<string>(source);

      const result = run
        .onData(noop)
        .onRollback(noop)
        .onResult(noop)
        .onConnected(noop)
        .onStepStarted(noop)
        .onStepCompleted(noop)
        .onStepErrored(noop);

      expect(result).toBe(run);

      const finalResult = await run.start();
      expect(finalResult).toEqual({ result: "ok" });
    });
  });

  describe("parse option", () => {
    it("uses parse function to transform data", async () => {
      const source = mockSource([
        { type: "metadata", run_id: "run-1", attempt: 0 },
        { type: "stream", data: "42" },
        { type: "result", data: "99" },
      ] as SSEFrame[]);

      const run = RunStream._fromSource<number>(source, {
        parse: (raw: unknown) => Number(raw),
      });
      const result = await run.start();

      expect(run.chunks).toEqual([42]);
      expect(result).toEqual({ result: 99 });
    });
  });
});
