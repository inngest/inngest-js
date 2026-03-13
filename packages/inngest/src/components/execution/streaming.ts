import { createTimeoutPromise } from "../../helpers/promises.ts";

// ---------------------------------------------------------------------------
// Shared frame type definitions
// ---------------------------------------------------------------------------
// These types are the single source of truth for the SSE wire format.
// Both the build helpers (below) and the parse helper (iterSSE / parseSSEFrame)
// are derived from them, so the two sides can never drift apart.

/** Metadata frame — first frame sent on any streaming response. */
export type SSEMetadataFrame = {
  type: "metadata";
  run_id: string;
  attempt: number;
};

/** Stream frame — carries user-pushed data from stream.push() / stream.pipe(). */
export type SSEStreamFrame = {
  type: "stream";
  data: unknown;
};

/** Result frame — terminal frame carrying the function's return value. */
export type SSEResultFrame = {
  type: "result";
  data: unknown;
};

/** Step lifecycle frame — emitted at the start, end, and on error of each step. */
export type SSEStepFrame = {
  type: "step";
  id: string;
  status: "running" | "completed" | "errored";
  error?: string;
  will_retry?: boolean;
  /** The execution attempt number (0-based). Present on errored frames. */
  attempt?: number;
};

/** Redirect frame — tells the client to reconnect to the async checkpoint stream. */
export type SSERedirectFrame = {
  type: "redirect";
  run_id: string;
  token: string;
  url?: string;
};

/** Union of all SSE frames produced by this SDK. */
export type SSEFrame =
  | SSEMetadataFrame
  | SSEStreamFrame
  | SSEResultFrame
  | SSEStepFrame
  | SSERedirectFrame;

// ---------------------------------------------------------------------------
// Raw SSE line-level type (internal to the parser)
// ---------------------------------------------------------------------------

/** A single parsed SSE event before JSON-decoding the data field. */
export type RawSSEEvent = {
  event: string;
  data: string;
};

// ---------------------------------------------------------------------------
// Internal frame builder
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// SSE parser
// ---------------------------------------------------------------------------

/**
 * Async generator that reads a `ReadableStream<Uint8Array>` and yields each
 * complete SSE event as a `RawSSEEvent` (event name + raw data string).
 *
 * The caller is responsible for JSON-parsing `data` if needed.  Use
 * `parseSSEFrame` to go from a `RawSSEEvent` to a typed `SSEFrame`.
 *
 * @example
 * ```ts
 * for await (const raw of iterSSE(response.body)) {
 *   const frame = parseSSEFrame(raw);
 *   if (frame?.type === "stream") { ... }
 * }
 * ```
 */
export async function* iterSSE(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<RawSSEEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split("\n\n");
      // The last element is always an incomplete frame (or empty string at end).
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        if (!part.trim()) continue;

        let event = "message";
        let data = "";

        for (const line of part.split("\n")) {
          if (line.startsWith("event: ")) {
            event = line.slice(7);
          } else if (line.startsWith("data: ")) {
            data = line.slice(6);
          }
        }

        yield { event, data };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Parse a raw SSE event into a typed `SSEFrame`, or return `null` for
 * unrecognised event names.
 *
 * JSON parsing errors on the data field are treated as `null` (unknown frame)
 * rather than thrown, so callers can safely skip unrecognised frames.
 */
export function parseSSEFrame(raw: RawSSEEvent): SSEFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.data);
  } catch {
    parsed = raw.data;
  }

  const obj =
    parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};

  switch (raw.event) {
    case "inngest": {
      if (typeof obj.run_id !== "string") return null;
      return {
        type: "metadata",
        run_id: obj.run_id,
        attempt: typeof obj.attempt === "number" ? obj.attempt : 0,
      };
    }

    case "stream": {
      return { type: "stream", data: parsed };
    }

    case "result": {
      return { type: "result", data: parsed };
    }

    case "step": {
      const status = obj.status;
      if (
        status !== "running" &&
        status !== "completed" &&
        status !== "errored"
      ) {
        return null;
      }
      return {
        type: "step",
        id: typeof obj.id === "string" ? obj.id : "",
        status,
        error: typeof obj.error === "string" ? obj.error : undefined,
        will_retry: obj.will_retry === true ? true : undefined,
        attempt: typeof obj.attempt === "number" ? obj.attempt : undefined,
      };
    }

    case "redirect": {
      if (typeof obj.run_id !== "string" || typeof obj.token !== "string") {
        return null;
      }
      return {
        type: "redirect",
        run_id: obj.run_id,
        token: obj.token,
        url: typeof obj.url === "string" ? obj.url : undefined,
      };
    }

    default:
      return null;
  }
}

/**
 * Builds an SSE metadata frame string for a streaming response.
 *
 * The frame follows the Server-Sent Events format and provides run context
 * (run ID and attempt number) to consumers of the stream.
 */
export function buildSSEMetadataFrame(runId: string, attempt: number): string {
  return buildSSEFrame("inngest", { run_id: runId, attempt });
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
  return buildSSEFrame("result", data);
}

/**
 * Builds an SSE step lifecycle frame string.
 *
 * Used to notify clients when a step starts, completes, or errors so they
 * can implement rollback on retry.
 */
export function buildSSEStepFrame(data: {
  id: string;
  status: "running" | "completed" | "errored";
  error?: string;
  will_retry?: boolean;
  attempt?: number;
}): string {
  return buildSSEFrame("step", data);
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
  return buildSSEFrame("redirect", data);
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
