/**
 * Client-side streaming utilities for consuming Durable Endpoint SSE streams.
 */

import {
  iterSse,
  parseSseEvent,
  type SseEvent,
} from "./components/execution/streaming.ts";

interface FetchDurableEndpointOptions {
  /** Fetch function. */
  fetch?: typeof globalThis.fetch;

  /** Options passed to the fetch function. */
  fetchOpts?: RequestInit;

  /** Called when run metadata is received (e.g. run ID). */
  onMetadata?: (args: { runId: string }) => void;

  /**
   * Called for each streamed chunk. Should be considered uncommitted until a
   * commit or rollback event is received.
   */
  onData?: (args: { data: unknown; hashedStepId: string | null }) => void;

  /**
   * Called when uncommitted stream data should be rolled back, since a retry
   * will happen.
   */
  onRollback?: (args: { hashedStepId: string | null }) => void;

  /**
   * Called when uncommitted stream data should be committed, since it can no longer be
   * rolled back.
   */
  onCommit?: (args: { hashedStepId: string | null }) => void;

  /**
   * Called when a terminal stream error occurs (permanent function failure,
   * network error, etc.).
   */
  onStreamError?: (error: string) => void;

  /**
   * Called when the stream is fully consumed (including on abort or error).
   */
  onDone?: () => void;
}

/**
 * Fetch a durable endpoint URL and consume its SSE stream, dispatching
 * lifecycle callbacks (metadata, data, commit, rollback, error, done) as
 * events arrive. Returns the final `Response` reconstructed from the
 * terminal `inngest.response` SSE event.
 *
 * If the server does not respond with `text/event-stream`, the raw
 * `Response` is returned as-is (non-streaming path).
 */
export async function fetchWithStream(
  url: string,
  opts?: FetchDurableEndpointOptions,
): Promise<Response> {
  const fetchFn = opts?.fetch ?? globalThis.fetch;

  const initialRes = await fetchFn(url, {
    ...opts?.fetchOpts,
    headers: {
      ...opts?.fetchOpts?.headers,
      Accept: "text/event-stream",
    },
  });

  const contentType = initialRes.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    return initialRes;
  }

  if (!initialRes.body) {
    throw new Error("No response body");
  }

  let resp: Response | undefined;

  const source = iterSseFollowRedirects(
    initialRes.body,
    fetchFn,
    opts?.fetchOpts?.signal ?? undefined,
  );

  try {
    outer: for await (const sseEvent of source) {
      switch (sseEvent.type) {
        case "inngest.stream": {
          opts?.onData?.({
            data: sseEvent.data,
            hashedStepId: sseEvent.stepId ?? null,
          });
          break;
        }
        case "inngest.commit": {
          opts?.onCommit?.({ hashedStepId: sseEvent.hashedStepId });
          break;
        }
        case "inngest.rollback": {
          opts?.onRollback?.({ hashedStepId: sseEvent.hashedStepId });
          break;
        }
        case "inngest.response": {
          resp = new Response(sseEvent.response.body, {
            status: sseEvent.response.statusCode,
            headers: sseEvent.response.headers,
          });

          if (sseEvent.status === "failed") {
            opts?.onStreamError?.(sseEvent.response.body);
          }

          break outer;
        }
        case "inngest.metadata": {
          opts?.onMetadata?.({ runId: sseEvent.runId });
          break;
        }
        default:
          break;
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      opts?.onStreamError?.(error.message);
    }
    throw error;
  } finally {
    opts?.onDone?.();
  }

  if (!resp) {
    throw new Error("No response");
  }

  return resp;
}

/**
 * Async generator that yields parsed SSE events from an already-fetched
 * response body, following `inngest.redirect_info` redirects.
 */
async function* iterSseFollowRedirects(
  body: ReadableStream<Uint8Array>,
  fetchFn: typeof globalThis.fetch,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  let currentBody: ReadableStream<Uint8Array> | undefined = body;

  while (currentBody) {
    let nextUrl: string | undefined;

    for await (const raw of iterSse(currentBody)) {
      const sseEvent = parseSseEvent(raw);
      if (!sseEvent) {
        continue;
      }

      if (sseEvent.type === "inngest.redirect_info") {
        nextUrl = sseEvent.url;
      }

      yield sseEvent;
    }

    if (!nextUrl) {
      break;
    }

    const res = await fetchFn(nextUrl, {
      headers: { Accept: "text/event-stream" },
      signal,
    });

    if (!res.ok) {
      throw new Error(`Stream request failed: ${res.status} ${res.statusText}`);
    }

    if (!res.body) {
      throw new Error("No response body");
    }

    currentBody = res.body;
  }
}
