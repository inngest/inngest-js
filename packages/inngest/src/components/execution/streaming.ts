// No Node.js imports — this file is shared between server and client code.

import { z } from "zod/v3";
import { createTimeoutPromise } from "../../helpers/promises.ts";
import { isRecord } from "../../helpers/types.ts";

// ---------------------------------------------------------------------------
// Schemas — single source of truth for both runtime validation and types
// ---------------------------------------------------------------------------

const sseMetadataSchema = z.object({
  type: z.literal("inngest.metadata"),
  runId: z.string(),
});

const sseStreamSchema = z.object({
  type: z.literal("stream"),
  data: z.unknown(),
  stepId: z.string().optional(),
});

const stepErrorDataSchema = z.object({
  willRetry: z.boolean(),
  error: z.string(),
});

const sseStepRunningSchema = z.object({
  type: z.literal("inngest.step"),
  stepId: z.string(),
  status: z.literal("running"),
  data: z.unknown().optional(),
});

const sseStepCompletedSchema = z.object({
  type: z.literal("inngest.step"),
  stepId: z.string(),
  status: z.literal("completed"),
  data: z.unknown().optional(),
});

const sseStepErroredSchema = z.object({
  type: z.literal("inngest.step"),
  stepId: z.string(),
  status: z.literal("errored"),
  willRetry: z.boolean(),
  error: z.string(),
});

const sseStepSchema = z.discriminatedUnion("status", [
  sseStepRunningSchema,
  sseStepCompletedSchema,
  sseStepErroredSchema,
]);

const sseResultSucceededSchema = z.object({
  type: z.literal("inngest.result"),
  status: z.literal("succeeded"),
  data: z.unknown().optional(),
});

const sseResultFailedSchema = z.object({
  type: z.literal("inngest.result"),
  status: z.literal("failed"),
  error: z.string(),
});

const sseResultSchema = z.discriminatedUnion("status", [
  sseResultSucceededSchema,
  sseResultFailedSchema,
]);

const sseRedirectSchema = z.object({
  type: z.literal("inngest.redirect_info"),
  runId: z.string(),
  url: z.string(),
});

// ---------------------------------------------------------------------------
// Types derived from schemas
// ---------------------------------------------------------------------------

export type SseMetadataEvent = z.infer<typeof sseMetadataSchema>;
export type SseStreamEvent = z.infer<typeof sseStreamSchema>;
export type SseResultSucceededEvent = z.infer<typeof sseResultSucceededSchema>;
export type SseResultFailedEvent = z.infer<typeof sseResultFailedSchema>;
export type SseResultEvent = z.infer<typeof sseResultSchema>;

/**
 * Payload included with every `inngest.step` errored event. Describes the
 * failure so the client can decide whether to show an error or wait for a
 * retry.
 */
export type StepErrorData = z.infer<typeof stepErrorDataSchema>;

export type SseStepRunningEvent = z.infer<typeof sseStepRunningSchema>;
export type SseStepCompletedEvent = z.infer<typeof sseStepCompletedSchema>;
export type SseStepErroredEvent = z.infer<typeof sseStepErroredSchema>;
export type SseStepEvent = z.infer<typeof sseStepSchema>;

export type SseRedirectEvent = z.infer<typeof sseRedirectSchema>;

export type SseEvent =
  | SseMetadataEvent
  | SseStreamEvent
  | SseResultEvent
  | SseStepEvent
  | SseRedirectEvent;

export interface RawSseEvent {
  event: string;
  data: string;
}

// ---------------------------------------------------------------------------
// SSE event builders
// ---------------------------------------------------------------------------

/**
 * Builds a single SSE event with the given event name and JSON-serialized data.
 *
 * `undefined` is normalized to `null` so that the `data:` field is always valid
 * JSON (since `JSON.stringify(undefined)` returns the JS primitive `undefined`,
 * not the string `"null"`).
 */
function buildSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data ?? null)}\n\n`;
}

/**
 * Builds an SSE metadata event string for a streaming response.
 *
 * The event follows the Server-Sent Events format and provides run context
 * (run ID) to consumers of the stream.
 */
export function buildSseMetadataEvent(runId: string): string {
  return buildSseEvent("inngest.metadata", { runId });
}

/**
 * Builds an SSE stream event string for user-pushed data.
 *
 * Used by `stream.push()` and `stream.pipe()` to send arbitrary data to
 * clients as part of a streaming response.
 */
export function buildSseStreamEvent(data: unknown, stepId?: string): string {
  const payload: Record<string, unknown> = { data };
  if (stepId) payload.stepId = stepId;
  return buildSseEvent("stream", payload);
}

/**
 * Builds an SSE result event for a successfully completed function.
 * This is the last event sent before the stream closes.
 */
export function buildSseSucceededEvent(data: unknown): string {
  return buildSseEvent("inngest.result", { status: "succeeded", data });
}

/**
 * Builds an SSE result event for a permanently failed function.
 * This is the last event sent before the stream closes.
 */
export function buildSseFailedEvent(error: string): string {
  return buildSseEvent("inngest.result", { status: "failed", error });
}

/**
 * Builds an SSE redirect event telling the client that execution has switched
 * to async mode and it should reconnect elsewhere to get remaining output.
 *
 * The `url` already contains the realtime JWT as a query parameter, so no
 * separate token field is needed.
 */
export function buildSseRedirectEvent(data: {
  runId: string;
  url: string;
}): string {
  return buildSseEvent("inngest.redirect_info", data);
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
// Step event builder
// ---------------------------------------------------------------------------

/**
 * Builds an SSE step lifecycle event.
 */
export function buildSseStepEvent(
  stepId: string,
  status: SseStepEvent["status"],
  data?: unknown,
): string {
  const payload: Record<string, unknown> = { stepId, status };
  if (data !== undefined) {
    payload.data = data;
  }
  return buildSseEvent("inngest.step", payload);
}

// ---------------------------------------------------------------------------
// SSE line parser (async generator)
// ---------------------------------------------------------------------------

/**
 * Parses a `ReadableStream<Uint8Array>` as an SSE byte stream, yielding
 * `RawSseEvent` objects for each complete event.
 */
export async function* iterSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<RawSseEvent> {
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
// Raw SSE event -> typed SseEvent
// ---------------------------------------------------------------------------

const sseSchemasByEvent: Record<string, z.ZodType<SseEvent>> = {
  "inngest.metadata": sseMetadataSchema,
  stream: sseStreamSchema,
  "inngest.result": sseResultSchema,
  "inngest.step": sseStepSchema,
  "inngest.redirect_info": sseRedirectSchema,
};

/**
 * Converts a `RawSseEvent` into a typed `SseEvent`, or returns `undefined`
 * if the event type is unrecognised or fails validation.
 */
export function parseSseEvent(raw: RawSseEvent): SseEvent | undefined {
  const schema = sseSchemasByEvent[raw.event];
  if (!schema) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.data);
  } catch {
    throw new UnreachableError("SSE data is not a valid JSON string");
  }
  if (!isRecord(parsed)) {
    return undefined;
  }

  const result = schema.safeParse({ ...parsed, type: raw.event });
  if (!result.success) {
    throw new Error("Unknown SSE event", { cause: result.error });
  }

  return result.data;
}

class UnreachableError extends Error {
  constructor(...args: Parameters<typeof Error>) {
    super(...args);
    this.name = "UnreachableError";
  }
}
