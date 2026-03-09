import { describe, expect, it } from "vitest";
import { InngestStream } from "./InngestStreamTools.ts";

/** Drain the readable side and return the raw SSE text. */
async function drain(stream: InngestStream): Promise<string> {
  const reader = stream.readable.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(decoder.decode(value, { stream: true }));
  }

  return parts.join("");
}

describe("InngestStream.pipe()", () => {
  describe("ReadableStream source", () => {
    it("pipes chunks and returns concatenated text", async () => {
      const s = new InngestStream();
      const encoder = new TextEncoder();

      const readable = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("hello"));
          controller.enqueue(encoder.encode(" world"));
          controller.close();
        },
      });

      const drainPromise = drain(s);

      const result = await s.pipe(readable);
      s.close();

      expect(result).toBe("hello world");

      const sseText = await drainPromise;
      expect(sseText).toContain('data: "hello"');
      expect(sseText).toContain('data: " world"');
      expect(sseText).toContain("event: stream");
    });

    it("does not corrupt Uint8Array chunks by routing to AsyncIterable path", async () => {
      const s = new InngestStream();
      const encoder = new TextEncoder();

      // This is the critical regression test: on Node 18+ ReadableStream
      // has Symbol.asyncIterator, so without the instanceof check it would
      // be misrouted to pipeAsyncIterable and produce garbage.
      const readable = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("abc"));
          controller.close();
        },
      });

      const drainPromise = drain(s);
      const result = await s.pipe(readable);
      s.close();

      // If misrouted, result would be something like "97,98,99"
      expect(result).toBe("abc");
      await drainPromise;
    });
  });

  describe("AsyncIterable<string> source", () => {
    it("pipes chunks and returns concatenated text", async () => {
      const s = new InngestStream();

      async function* gen() {
        yield "foo";
        yield "bar";
      }

      const drainPromise = drain(s);
      const result = await s.pipe(gen());
      s.close();

      expect(result).toBe("foobar");

      const sseText = await drainPromise;
      expect(sseText).toContain('data: "foo"');
      expect(sseText).toContain('data: "bar"');
      expect(sseText).toContain("event: stream");
    });

    it("returns empty string for empty iterable", async () => {
      const s = new InngestStream();

      async function* empty() {
        // yields nothing
      }

      const drainPromise = drain(s);
      const result = await s.pipe(empty());
      s.close();

      expect(result).toBe("");
      await drainPromise;
    });
  });

  describe("() => AsyncIterable<string> source (generator function)", () => {
    it("invokes the function and pipes the result", async () => {
      const s = new InngestStream();

      const drainPromise = drain(s);
      const result = await s.pipe(async function* () {
        yield "a";
        yield "b";
        yield "c";
      });
      s.close();

      expect(result).toBe("abc");

      const sseText = await drainPromise;
      expect(sseText).toContain('data: "a"');
      expect(sseText).toContain('data: "b"');
      expect(sseText).toContain('data: "c"');
      expect(sseText).toContain("event: stream");
    });
  });

  describe("error propagation", () => {
    it("propagates errors from async iterable", async () => {
      const s = new InngestStream();

      async function* failing() {
        yield "ok";
        throw new Error("boom");
      }

      void drain(s).catch(() => {});

      await expect(s.pipe(failing())).rejects.toThrow("boom");
    });
  });

  describe("dispatch correctness", () => {
    it("activates the stream for all source types", async () => {
      // ReadableStream
      const s1 = new InngestStream();
      void drain(s1).catch(() => {});
      const rs = new ReadableStream({
        start(c) {
          c.close();
        },
      });
      await s1.pipe(rs);
      s1.close();
      expect(s1.activated).toBe(true);

      // AsyncIterable
      const s2 = new InngestStream();
      void drain(s2).catch(() => {});
      async function* gen() {}
      await s2.pipe(gen());
      s2.close();
      expect(s2.activated).toBe(true);

      // Generator function
      const s3 = new InngestStream();
      void drain(s3).catch(() => {});
      await s3.pipe(async function* () {});
      s3.close();
      expect(s3.activated).toBe(true);
    });
  });
});
