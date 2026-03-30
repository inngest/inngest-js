// No Node.js imports — this file is shared between server and client code.

import { z } from "zod/v3";
import { isRecord } from "../../helpers/types.ts";
import { UnreachableError } from "../middleware/utils.ts";

// ---------------------------------------------------------------------------
// Schemas — single source of truth for both runtime validation and types
// ---------------------------------------------------------------------------

const sseMetadataSchema = z.object({
  type: z.literal("inngest.metadata"),
  runId: z.string(),
});

const sseStreamSchema = z.object({
  type: z.literal("inngest.stream"),
  data: z.unknown(),
  hashedStepId: z.string().optional(),
});

const sseCommitSchema = z.object({
  type: z.literal("inngest.commit"),
  hashedStepId: z.string().nullable(),
});

const sseRollbackSchema = z.object({
  type: z.literal("inngest.rollback"),
  hashedStepId: z.string().nullable(),
});

const sseResultSchema = z.object({
  type: z.literal("inngest.response"),
  status: z.union([z.literal("succeeded"), z.literal("failed")]),
  response: z.object({
    body: z.string(),
    headers: z.record(z.string()),
    statusCode: z.number(),
  }),
});

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
export type SseResultEvent = z.infer<typeof sseResultSchema>;

export type SseCommitEvent = z.infer<typeof sseCommitSchema>;
export type SseRollbackEvent = z.infer<typeof sseRollbackSchema>;

export type SseRedirectEvent = z.infer<typeof sseRedirectSchema>;

export type SseEvent =
  | SseMetadataEvent
  | SseStreamEvent
  | SseResultEvent
  | SseCommitEvent
  | SseRollbackEvent
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
export function buildSseStreamEvent(data: unknown, hashedStepId?: string): string {
  const payload: Record<string, unknown> = { data };
  if (hashedStepId) payload.hashedStepId = hashedStepId;
  return buildSseEvent("inngest.stream", payload);
}

export interface SseResponse {
  body: string;
  statusCode: number;
  headers: Record<string, string>;
}

/**
 * Builds an `inngest.response` SSE event with status `succeeded`.
 */
export function buildSseSucceededEvent(response: SseResponse): string {
  return buildSseEvent("inngest.response", {
    status: "succeeded",
    response,
  });
}

/**
 * Builds an `inngest.response` SSE event with status `failed`.
 */
export function buildSseFailedEvent(error: string): string {
  return buildSseEvent("inngest.response", {
    status: "failed",
    response: {
      body: JSON.stringify(error),
      statusCode: 500,
      headers: { "content-type": "application/json" },
    },
  });
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

// ---------------------------------------------------------------------------
// Commit / Rollback event builders
// ---------------------------------------------------------------------------

/**
 * Builds an `inngest.commit` SSE event indicating a step's data is committed.
 */
export function buildSseCommitEvent(hashedStepId: string | null): string {
  return buildSseEvent("inngest.commit", { hashedStepId });
}

/**
 * Builds an `inngest.rollback` SSE event indicating a step's data should be
 * rolled back (e.g. step errored and will retry, or disconnect mid-step).
 */
export function buildSseRollbackEvent(hashedStepId: string | null): string {
  return buildSseEvent("inngest.rollback", { hashedStepId });
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
  "inngest.stream": sseStreamSchema,
  "inngest.response": sseResultSchema,
  "inngest.commit": sseCommitSchema,
  "inngest.rollback": sseRollbackSchema,
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
