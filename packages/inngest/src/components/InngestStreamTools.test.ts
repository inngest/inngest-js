import { describe, expect, test, vi } from "vitest";
import { InngestStream, stream } from "./InngestStreamTools.ts";

describe("InngestStream", () => {
  describe("activated", () => {
    test("is false initially", () => {
      const s = new InngestStream();
      expect(s.activated).toBe(false);
    });

    test("becomes true after push", () => {
      const s = new InngestStream();
      s.push({ hello: "world" });
      expect(s.activated).toBe(true);
    });

    test("becomes true after pipe", async () => {
      const s = new InngestStream();
      const readable = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("chunk"));
          controller.close();
        },
      });
      await s.pipe(readable);
      expect(s.activated).toBe(true);
    });
  });

  describe("onActivated", () => {
    test("fires on first push", () => {
      const s = new InngestStream();
      const callback = vi.fn();
      s.onActivated = callback;

      s.push("first");
      expect(callback).toHaveBeenCalledTimes(1);

      s.push("second");
      expect(callback).toHaveBeenCalledTimes(1);
    });

    test("fires on first pipe", async () => {
      const s = new InngestStream();
      const callback = vi.fn();
      s.onActivated = callback;

      const readable = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("chunk"));
          controller.close();
        },
      });
      await s.pipe(readable);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    test("does not fire if not set", () => {
      const s = new InngestStream();
      // No onActivated set — should not throw
      expect(() => s.push("data")).not.toThrow();
    });
  });

  describe("push", () => {
    test("silently skips non-serializable data", async () => {
      const s = new InngestStream();
      // biome-ignore lint/suspicious/noExplicitAny: intentional circular ref
      const circular: any = {};
      circular.self = circular;

      s.push(circular);
      s.push("valid-data");
      s.close();

      const reader = s.readable.getReader();
      const decoder = new TextDecoder();
      const chunks: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value));
      }

      const output = chunks.join("");
      // Only one stream frame (the valid one) — the circular ref was skipped
      const streamFrames = output.match(/event: stream/g) ?? [];
      expect(streamFrames).toHaveLength(1);
      expect(output).toContain('event: stream\ndata: "valid-data"\n\n');
    });

    test("writes SSE stream frames to readable", async () => {
      const s = new InngestStream();
      s.push({ type: "status", message: "hello" });
      s.push("plain string");
      s.close();

      const reader = s.readable.getReader();
      const decoder = new TextDecoder();
      const chunks: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value));
      }

      const output = chunks.join("");
      expect(output).toContain(
        'event: stream\ndata: {"type":"status","message":"hello"}\n\n',
      );
      expect(output).toContain('event: stream\ndata: "plain string"\n\n');
    });
  });

  describe("pipe", () => {
    test("writes each chunk as an SSE stream frame and returns concatenated content", async () => {
      const s = new InngestStream();
      const readable = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("chunk1"));
          controller.enqueue(new TextEncoder().encode("chunk2"));
          controller.close();
        },
      });

      const result = await s.pipe(readable);
      expect(result).toBe("chunk1chunk2");
      s.close();

      const reader = s.readable.getReader();
      const decoder = new TextDecoder();
      const chunks: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value));
      }

      const output = chunks.join("");
      expect(output).toContain('event: stream\ndata: "chunk1"\n\n');
      expect(output).toContain('event: stream\ndata: "chunk2"\n\n');
    });
  });

  describe("close", () => {
    test("writes a result frame and closes the stream", async () => {
      const s = new InngestStream();
      s.close({ result: "done" });

      const reader = s.readable.getReader();
      const decoder = new TextDecoder();
      const chunks: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value));
      }

      const output = chunks.join("");
      expect(output).toBe('event: result\ndata: {"result":"done"}\n\n');
    });

    test("calling close twice does not throw", async () => {
      const s = new InngestStream();
      s.close("first");
      s.close("second");

      const reader = s.readable.getReader();
      const decoder = new TextDecoder();
      const chunks: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value));
      }

      const output = chunks.join("");
      // Only the first close's frame should be written (second is swallowed)
      expect(output).toContain('event: result\ndata: "first"\n\n');
    });

    test("close with undefined normalizes to null", async () => {
      const s = new InngestStream();
      s.close();

      const reader = s.readable.getReader();
      const decoder = new TextDecoder();
      const chunks: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value));
      }

      const output = chunks.join("");
      expect(output).toBe("event: result\ndata: null\n\n");
    });

    test("writes result frame after pushed data", async () => {
      const s = new InngestStream();
      s.push("progress");
      s.close("final");

      const reader = s.readable.getReader();
      const decoder = new TextDecoder();
      const chunks: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value));
      }

      const output = chunks.join("");
      expect(output).toContain('event: stream\ndata: "progress"\n\n');
      expect(output).toContain('event: result\ndata: "final"\n\n');
      // Result frame should come after stream frame
      const streamIdx = output.indexOf("event: stream");
      const resultIdx = output.indexOf("event: result");
      expect(resultIdx).toBeGreaterThan(streamIdx);
    });
  });
});

describe("global stream export", () => {
  test("push is a no-op outside execution context", () => {
    // Should not throw
    expect(() => stream.push({ test: true })).not.toThrow();
  });

  test("pipe resolves outside execution context", async () => {
    const readable = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });

    // Should resolve with empty string outside execution context
    await expect(stream.pipe(readable)).resolves.toBe("");
  });
});
