import { describe, expect, test, vi } from "vitest";
import {
  buildSSEMetadataFrame,
  drainStream,
  drainStreamWithTimeout,
  mergeChunks,
  prependToStream,
} from "./streaming.ts";

describe("buildSSEMetadataFrame", () => {
  test("produces correct SSE format", () => {
    const frame = buildSSEMetadataFrame("run-123", 0);
    expect(frame).toBe(
      'event: inngest\ndata: {"run_id":"run-123","attempt":0}\n\n',
    );
  });

  test("JSON-encodes special characters in run ID", () => {
    const frame = buildSSEMetadataFrame('run-"special"', 2);
    const parsed = frame.split("data: ")[1]!.trimEnd();
    expect(() => JSON.parse(parsed)).not.toThrow();
    expect(JSON.parse(parsed)).toEqual({
      run_id: 'run-"special"',
      attempt: 2,
    });
  });

  test("includes attempt number", () => {
    const frame = buildSSEMetadataFrame("run-1", 5);
    const data = JSON.parse(frame.split("data: ")[1]!.trimEnd());
    expect(data.attempt).toBe(5);
  });
});

describe("prependToStream", () => {
  test("prefix appears before original stream chunks", async () => {
    const prefix = new TextEncoder().encode("PREFIX:");
    const original = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk1"));
        controller.enqueue(new TextEncoder().encode("chunk2"));
        controller.close();
      },
    });

    const result = prependToStream(prefix, original);
    const reader = result.getReader();
    const chunks: string[] = [];
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }

    expect(chunks).toEqual(["PREFIX:", "chunk1", "chunk2"]);
  });

  test("handles empty original stream", async () => {
    const prefix = new TextEncoder().encode("ONLY");
    const original = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });

    const result = prependToStream(prefix, original);
    const reader = result.getReader();
    const chunks: string[] = [];
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }

    expect(chunks).toEqual(["ONLY"]);
  });

  test("propagates errors from original stream", async () => {
    const prefix = new TextEncoder().encode("PREFIX:");
    const original = new ReadableStream<Uint8Array>({
      async pull(controller) {
        controller.error(new Error("stream broke"));
      },
    });

    const result = prependToStream(prefix, original);
    const reader = result.getReader();

    // First chunk is the prefix
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("PREFIX:");

    // Next read should error because the original stream errors on pull
    await expect(reader.read()).rejects.toThrow("stream broke");
  });
});

describe("drainStream", () => {
  test("collects all chunks", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.enqueue(new Uint8Array([5]));
        controller.close();
      },
    });

    const chunks = await drainStream(stream);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual(new Uint8Array([1, 2]));
    expect(chunks[1]).toEqual(new Uint8Array([3, 4]));
    expect(chunks[2]).toEqual(new Uint8Array([5]));
  });

  test("handles empty stream", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });

    const chunks = await drainStream(stream);
    expect(chunks).toEqual([]);
  });

  test("releases reader lock on error", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.error(new Error("fail"));
      },
    });

    await expect(drainStream(stream)).rejects.toThrow("fail");

    // Reader lock should be released — we can get a new reader
    expect(() => stream.getReader()).not.toThrow();
  });
});

describe("mergeChunks", () => {
  test("concatenates multiple chunks", () => {
    const chunks = [
      new Uint8Array([1, 2]),
      new Uint8Array([3]),
      new Uint8Array([4, 5, 6]),
    ];

    const result = mergeChunks(chunks);
    expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
  });

  test("returns empty Uint8Array for empty array", () => {
    const result = mergeChunks([]);
    expect(result).toEqual(new Uint8Array(0));
  });

  test("returns single chunk directly", () => {
    const chunk = new Uint8Array([10, 20, 30]);
    const result = mergeChunks([chunk]);
    expect(result).toBe(chunk); // same reference
  });
});

describe("drainStreamWithTimeout", () => {
  test("returns chunks when stream finishes before timeout", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello"));
        controller.close();
      },
    });

    const chunks = await drainStreamWithTimeout(stream, 5000);
    expect(chunks).toHaveLength(1);
    expect(new TextDecoder().decode(chunks[0])).toBe("hello");
  });

  describe("timeout behavior", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    test("throws when stream exceeds timeout", async () => {
      // Stream that never closes
      const stream = new ReadableStream<Uint8Array>({
        start() {
          // intentionally never close or enqueue
        },
      });

      const promise = drainStreamWithTimeout(stream, 1000);

      // Capture the rejection early so it does not become unhandled
      // when advanceTimersByTimeAsync triggers the timeout path.
      const rejection = expect(promise).rejects.toThrow(
        "Stream drain timed out",
      );

      // Advance time past the timeout
      await vi.advanceTimersByTimeAsync(1500);

      await rejection;
    });

    test("stream is not locked after timeout", async () => {
      // Stream that never closes
      const stream = new ReadableStream<Uint8Array>({
        start() {
          // intentionally never close or enqueue
        },
      });

      const promise = drainStreamWithTimeout(stream, 1000);

      // Capture the rejection early so it does not become unhandled
      // when advanceTimersByTimeAsync triggers the timeout path.
      const rejection = expect(promise).rejects.toThrow(
        "Stream drain timed out",
      );

      // Advance time past the timeout
      await vi.advanceTimersByTimeAsync(1500);

      await rejection;

      // Flush microtask queue so reader.cancel() and releaseLock settle.
      // Multiple awaits are needed because cancel() triggers an internal
      // chain of microtasks in the streams spec.
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(0);
      }

      // The stream should no longer be locked after timeout + cancel
      expect(stream.locked).toBe(false);
    });
  });
});
