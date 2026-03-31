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
}

/**
 * Fetch a durable endpoint URL and consume its SSE stream, dispatching
 * lifecycle callbacks (metadata, data, commit, rollback) as
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

  outer: for await (const sseEvent of source) {
    switch (sseEvent.type) {
      case "inngest.stream": {
        opts?.onData?.({
          data: sseEvent.data,
          hashedStepId: sseEvent.hashedStepId ?? null,
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
        if (sseEvent.status === "failed") {
          throw new Error(sseEvent.response.body);
        }

        resp = new Response(sseEvent.response.body, {
          status: sseEvent.response.statusCode,
          headers: sseEvent.response.headers,
        });

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

  if (!resp) {
    throw new Error("No response");
  }

  return resp;
}

/**
 * Async generator that yields parsed SSE events from an already-fetched
 * response body, following `inngest.redirect_info` redirects.
 *
 * When a redirect event arrives, the redirect URL is fetched eagerly in the
 * background so the connection is already established by the time the direct
 * stream closes. This minimizes the window for late-joiner data loss.
 */
async function* iterSseFollowRedirects(
  body: ReadableStream<Uint8Array>,
  fetchFn: typeof globalThis.fetch,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const fetchOpts = { headers: { Accept: "text/event-stream" }, signal };
  let redirectUrl: string | undefined;
  let eagerResponse: Promise<Response | undefined> | undefined;

  try {
    for await (const raw of iterSse(body)) {
      const sseEvent = parseSseEvent(raw);
      if (!sseEvent) continue;

      if (sseEvent.type === "inngest.redirect_info") {
        redirectUrl = sseEvent.url;

        // Start the redirect connection immediately (once only).
        if (sseEvent.url && !eagerResponse) {
          eagerResponse = fetchFn(sseEvent.url, fetchOpts).catch(
            () => undefined,
          );
        }

        yield sseEvent;
        continue;
      }

      yield sseEvent;
    }

    if (!redirectUrl) return;

    let redirectRes: Response | undefined;

    if (eagerResponse) {
      const eager = await eagerResponse;
      if (eager?.ok && eager.body) {
        redirectRes = eager;
      } else {
        await eager?.body?.cancel();
      }
      eagerResponse = undefined;
    }

    if (!redirectRes) {
      if (signal?.aborted) {
        throw (
          signal.reason ??
          new DOMException("The operation was aborted.", "AbortError")
        );
      }

      const fallback = await fetchFn(redirectUrl, fetchOpts);
      if (!fallback.ok) {
        throw new Error(
          `Stream request failed: ${fallback.status} ${fallback.statusText}`,
        );
      }
      if (!fallback.body) {
        throw new Error("No response body");
      }
      redirectRes = fallback;
    }

    for await (const raw of iterSse(redirectRes.body!)) {
      const sseEvent = parseSseEvent(raw);
      if (!sseEvent) continue;
      yield sseEvent;
    }
  } finally {
    // Cancel any unconsumed eager response body to release the connection.
    if (eagerResponse) {
      void eagerResponse.then((r) => r?.body?.cancel()).catch(() => {});
    }
  }
}
