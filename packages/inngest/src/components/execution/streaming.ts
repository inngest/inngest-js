// No Node.js imports — this file is shared between server and client code.

import { z } from "zod/v3";
import { createTimeoutPromise } from "../../helpers/promises.ts";

// ---------------------------------------------------------------------------
// Typed SSE frame definitions
// ---------------------------------------------------------------------------

export interface SSEMetadataFrame {
  type: "inngest.metadata";
  run_id: string;
}

export interface SSEStreamFrame {
  type: "stream";
  data: unknown;
  step_id?: string;
}

export interface SSEResultSucceededFrame {
  type: "inngest.result";
  status: "succeeded";
  data?: unknown;
}

export interface SSEResultFailedFrame {
  type: "inngest.result";
  status: "failed";
  error: string;
}

export type SSEResultFrame = SSEResultSucceededFrame | SSEResultFailedFrame;

/**
 * Payload included with every `inngest.step` errored frame. Describes the
 * failure so the client can decide whether to show an error or wait for a
 * retry.
 */
export interface StepErrorData {
  will_retry: boolean;
  error: string;
}

export interface SSEStepRunningFrame {
  type: "inngest.step";
  step_id: string;
  status: "running";
  data?: unknown;
}

export interface SSEStepCompletedFrame {
  type: "inngest.step";
  step_id: string;
  status: "completed";
  data?: unknown;
}

export interface SSEStepErroredFrame extends StepErrorData {
  type: "inngest.step";
  step_id: string;
  status: "errored";
}

export type SSEStepFrame =
  | SSEStepRunningFrame
  | SSEStepCompletedFrame
  | SSEStepErroredFrame;

export interface SSERedirectFrame {
  type: "inngest.redirect_info";
  run_id: string;
  token: string;
  url?: string;
}

export type SSEFrame =
  | SSEMetadataFrame
  | SSEStreamFrame
  | SSEResultFrame
  | SSEStepFrame
  | SSERedirectFrame;

export interface RawSSEEvent {
  event: string;
  data: string;
}

// ---------------------------------------------------------------------------
// Zod schemas for runtime validation of parsed SSE frames
// ---------------------------------------------------------------------------

const sseMetadataPayloadSchema = z.object({
  run_id: z.string(),
});

const sseStreamPayloadSchema = z.object({
  data: z.unknown(),
  step_id: z.string().optional(),
});

const stepErrorDataSchema = z.object({
  will_retry: z.boolean(),
  error: z.string(),
});

const sseStepPayloadSchema = z.object({
  step_id: z.string(),
  status: z.enum(["running", "completed", "errored"]),
  data: z.unknown().optional(),
});

const sseResultPayloadSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("succeeded"), data: z.unknown().optional() }),
  z.object({ status: z.literal("failed"), error: z.string() }),
]);

const sseRedirectPayloadSchema = z.object({
  run_id: z.string(),
  token: z.string(),
  url: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Frame builders
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

/**
 * Builds an SSE metadata frame string for a streaming response.
 *
 * The frame follows the Server-Sent Events format and provides run context
 * (run ID) to consumers of the stream.
 */
export function buildSSEMetadataFrame(runId: string): string {
  return buildSSEFrame("inngest.metadata", { run_id: runId });
}

/**
 * Builds an SSE stream frame string for user-pushed data.
 *
 * Used by `stream.push()` and `stream.pipe()` to send arbitrary data to
 * clients as part of a streaming response.
 */
export function buildSSEStreamFrame(data: unknown, stepId?: string): string {
  const payload: Record<string, unknown> = { data };
  if (stepId) payload.step_id = stepId;
  return buildSSEFrame("stream", payload);
}

/**
 * Builds an SSE result frame for a successfully completed function.
 * This is the last frame sent before the stream closes.
 */
export function buildSSESucceededFrame(data: unknown): string {
  return buildSSEFrame("inngest.result", { status: "succeeded", data });
}

/**
 * Builds an SSE result frame for a permanently failed function.
 * This is the last frame sent before the stream closes.
 */
export function buildSSEFailedFrame(error: string): string {
  return buildSSEFrame("inngest.result", { status: "failed", error });
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

// ---------------------------------------------------------------------------
// Step frame builder
// ---------------------------------------------------------------------------

/**
 * Builds an SSE step lifecycle frame.
 */
export function buildSSEStepFrame(
  stepId: string,
  status: SSEStepFrame["status"],
  data?: unknown,
): string {
  const payload: Record<string, unknown> = { step_id: stepId, status };
  if (data !== undefined) {
    payload.data = data;
  }
  return buildSSEFrame("inngest.step", payload);
}

// ---------------------------------------------------------------------------
// SSE line parser (async generator)
// ---------------------------------------------------------------------------

/**
 * Parses a `ReadableStream<Uint8Array>` as an SSE byte stream, yielding
 * `RawSSEEvent` objects for each complete event.
 */
export async function* iterSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<RawSSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE events are delimited by a blank line (double newline) per the
      // Server-Sent Events spec.
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        if (!part.trim()) continue;

        let event = "message";
        const dataLines: string[] = [];

        for (const line of part.split("\n")) {
          if (line.startsWith("event: ")) {
            event = line.slice(7);
          } else if (line.startsWith("data: ")) {
            dataLines.push(line.slice(6));
          }
        }

        const data = dataLines.join("\n");

        yield { event, data };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Raw SSE event -> typed SSE frame
// ---------------------------------------------------------------------------

/**
 * Converts a `RawSSEEvent` into a typed `SSEFrame`, or returns `undefined`
 * if the event type is unrecognised.
 */
export function parseSSEFrame(raw: RawSSEEvent): SSEFrame | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.data);
  } catch {
    parsed = raw.data;
  }

  switch (raw.event) {
    case "inngest.metadata": {
      const result = sseMetadataPayloadSchema.safeParse(parsed);
      if (!result.success) return undefined;
      return { type: "inngest.metadata", run_id: result.data.run_id };
    }
    case "stream": {
      const result = sseStreamPayloadSchema.safeParse(parsed);
      if (!result.success) return undefined;
      return {
        type: "stream",
        data: result.data.data,
        ...(result.data.step_id ? { step_id: result.data.step_id } : {}),
      };
    }
    case "inngest.result": {
      const result = sseResultPayloadSchema.safeParse(parsed);
      if (!result.success) return undefined;
      return { type: "inngest.result", ...result.data };
    }
    case "inngest.step": {
      const result = sseStepPayloadSchema.safeParse(parsed);
      if (!result.success) return undefined;

      const { step_id, status, data } = result.data;

      if (status === "errored") {
        const errResult = stepErrorDataSchema.safeParse(data ?? {});
        return {
          type: "inngest.step",
          step_id,
          status: "errored",
          will_retry: errResult.success ? errResult.data.will_retry : false,
          error: errResult.success ? errResult.data.error : "unknown",
        };
      }

      return {
        type: "inngest.step" as const,
        step_id,
        status,
        data,
      };
    }
    case "inngest.redirect_info": {
      const result = sseRedirectPayloadSchema.safeParse(parsed);
      if (!result.success) return undefined;
      return {
        type: "inngest.redirect_info",
        run_id: result.data.run_id,
        token: result.data.token,
        ...(result.data.url ? { url: result.data.url } : {}),
      };
    }
    default:
      return undefined;
  }
}
