import { createTimeoutPromise } from "../../helpers/promises.ts";

/**
 * Builds a single SSE frame with the given event name and JSON-serialized data.
 *
 * `undefined` is normalized to `null` so that the `data:` field is always valid
 * JSON (since `JSON.stringify(undefined)` returns the JS primitive `undefined`,
 * not the string `"null"`).
 */
function buildSSEFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data ?? null)}\n\n`;
}

/**
 * Builds an SSE metadata frame string for a streaming response.
 *
 * The frame follows the Server-Sent Events format and provides run context
 * (run ID and attempt number) to consumers of the stream.
 */
export function buildSSEMetadataFrame(runId: string, attempt: number): string {
  return buildSSEFrame("inngest.metadata", { run_id: runId, attempt });
}

/**
 * Builds an SSE stream frame string for user-pushed data.
 *
 * Used by `stream.push()` and `stream.pipe()` to send arbitrary data to
 * clients as part of a streaming response.
 */
export function buildSSEStreamFrame(data: unknown): string {
  return buildSSEFrame("stream", data);
}

/**
 * Builds an SSE result frame string for the terminal value of a streaming
 * response. This is the last frame sent before the stream closes.
 */
export function buildSSEResultFrame(data: unknown): string {
  return buildSSEFrame("inngest.result", data);
}

/**
 * Builds an SSE redirect frame telling the client that execution has switched
 * to async mode and it should reconnect elsewhere to get remaining output.
 *
 * When `url` is provided the client can connect directly to that URL to
 * continue receiving the stream.
 */
export function buildSSERedirectFrame(data: {
  run_id: string;
  token: string;
  url?: string;
}): string {
  return buildSSEFrame("inngest.redirect_info", data);
}

/**
 * Returns a new `ReadableStream` that emits `prefix` first, then pipes
 * through all chunks from the original `stream`.
 */
export function prependToStream(
  prefix: Uint8Array,
  stream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      controller.enqueue(prefix);

      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          controller.enqueue(value);
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

/**
 * Reads a `ReadableStream` to completion, collecting all chunks into an array.
 */
export async function drainStream(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array[]> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return chunks;
}

/**
 * Concatenates an array of `Uint8Array` chunks into a single `Uint8Array`.
 */
export function mergeChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) {
    return new Uint8Array(0);
  }

  if (chunks.length === 1) {
    return chunks[0]!;
  }

  const totalLength = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return merged;
}

/**
 * Drains a stream with a timeout guard. Returns the collected chunks on
 * success, or throws if the timeout fires first.
 *
 * On timeout the reader is cancelled and its lock released so the underlying
 * stream does not stay locked.
 */
export async function drainStreamWithTimeout(
  stream: ReadableStream<Uint8Array>,
  timeoutMs: number,
): Promise<Uint8Array[]> {
  const timeout = createTimeoutPromise(timeoutMs);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  // Read loop wrapped in a promise so we can race it against the timeout.
  const drainPromise = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
    }
    return chunks;
  })();

  // Wrap the drain promise so that if the reader is cancelled (on timeout),
  // the resulting rejection is suppressed rather than becoming unhandled.
  const wrappedDrain = drainPromise.then(
    (c) => ({ kind: "drained" as const, chunks: c }),
    () => ({ kind: "cancelled" as const }),
  );

  try {
    const result = await Promise.race([
      wrappedDrain,
      timeout.start().then(() => ({ kind: "timeout" as const })),
    ]);

    if (result.kind === "drained") {
      reader.releaseLock();
      return result.chunks;
    }

    // Timeout or cancelled — cancel the reader which aborts the pending
    // read() and releases the lock on the stream. We fire-and-forget the
    // cancel so the timeout error is thrown synchronously. The wrappedDrain
    // error handler above ensures the drain promise rejection is suppressed.
    reader
      .cancel()
      .then(() => reader.releaseLock())
      .catch(() => {});
    throw new Error("Stream drain timed out");
  } finally {
    timeout.clear();
  }
}
