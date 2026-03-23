import http from "node:http";
import { createParser, type EventSourceMessage } from "eventsource-parser";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface SSEEvent {
  event: string;
  data: string;
}

function eventSourceMessageToSSEEvent(event: EventSourceMessage): SSEEvent {
  return {
    event: event.event || "message",
    data: event.data,
  };
}

function extractRedirectUrl(event: SSEEvent): string | null {
  if (event.event !== "inngest.redirect_info") {
    return null;
  }

  try {
    const parsed = JSON.parse(event.data) as { url?: unknown };
    return typeof parsed.url === "string" ? parsed.url : null;
  } catch {
    return null;
  }
}

async function consumeSSEBody(
  body: ReadableStream<Uint8Array>,
  timeoutMs: number,
  onEvent: (event: SSEEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let timedOut = false;

  const parser = createParser({
    onEvent(event) {
      onEvent(eventSourceMessageToSSEEvent(event));
    },
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    reader.cancel("SSE read timed out").catch(() => {});
  }, timeoutMs);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      parser.feed(decoder.decode(value, { stream: true }));
    }

    const finalChunk = decoder.decode();
    if (finalChunk) {
      parser.feed(finalChunk);
    }
  } catch (err) {
    if (!timedOut) {
      throw err;
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Read an SSE stream from a fetch Response, collecting events until the
 * stream closes or the timeout fires.
 */
export async function readSSEStream(
  res: Response,
  timeoutMs = 30_000,
): Promise<{ events: SSEEvent[]; redirectUrl: string | null }> {
  const events: SSEEvent[] = [];
  let redirectUrl: string | null = null;

  if (!res.body) {
    return { events, redirectUrl };
  }

  await consumeSSEBody(res.body, timeoutMs, (event) => {
    const url = extractRedirectUrl(event);
    if (url) {
      redirectUrl = url;
    }
    events.push(event);
  });

  return { events, redirectUrl };
}

/**
 * Create an HTTP server that bridges Node.js req/res to Web API
 * Request/Response for the given edge endpoint handler.
 *
 * Important: uses `value != null` (not `value`) when forwarding headers so
 * that empty-string headers (like `X-Inngest-Signature: ""` in dev mode)
 * are preserved. Dropping them breaks `isInngestReq()` detection.
 */
export async function createEndpointServer(
  handler: (req: Request) => Promise<Response>,
): Promise<{ port: number; server: http.Server }> {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const bodyBuf = Buffer.concat(chunks);

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value != null) {
        if (Array.isArray(value)) {
          for (const v of value) {
            headers.append(key, v);
          }
        } else {
          headers.set(key, value);
        }
      }
    }

    const addr = server.address() as { port: number };
    const webRequest = new Request(`http://localhost:${addr.port}${req.url}`, {
      method: req.method,
      headers,
      body: bodyBuf.length > 0 ? bodyBuf : undefined,
    });

    try {
      const webResponse = await handler(webRequest);

      const resHeaders: Record<string, string> = {};
      webResponse.headers.forEach((v, k) => {
        resHeaders[k] = v;
      });
      res.writeHead(webResponse.status, resHeaders);

      if (webResponse.body) {
        const reader = webResponse.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          res.write(value);
        }
      }
      res.end();
    } catch (err) {
      console.error("[server] Endpoint error:", err);
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end(String(err));
    }
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, () => {
      server.removeListener("error", reject);
      const addr = server.address() as { port: number };
      resolve(addr.port);
    });
  });

  return { port, server };
}

/**
 * Simulates an upstream source that emits chunks over time (like an LLM).
 */
export function fakeTokenStream(tokens: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      for (const token of tokens) {
        controller.enqueue(encoder.encode(token));
      }
      controller.close();
    },
  });
}

/** Extract the parsed data payloads from stream-type SSE events. */
export function getStreamData(events: SSEEvent[]): string[] {
  return events
    .filter((e) => e.event === "stream")
    .map((e) => {
      try {
        const parsed = JSON.parse(e.data);
        return (parsed?.data ?? parsed) as string;
      } catch {
        return e.data;
      }
    });
}

/**
 * A deferred promise the handler can `await` and the test can `open()`.
 */
export function createGate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * Start reading SSE events from a response in the background.
 * Events accumulate in `.events`; use `waitForStreamData` to
 * block until a specific chunk appears.
 */
export function startSSEReader(res: Response, timeoutMs = 30_000) {
  const events: SSEEvent[] = [];
  let redirectUrl: string | null = null;

  const done = (async () => {
    if (!res.body) {
      return;
    }

    await consumeSSEBody(res.body, timeoutMs, (event) => {
      const url = extractRedirectUrl(event);
      if (url) {
        redirectUrl = url;
      }
      events.push(event);
    });
  })();

  async function waitForStreamData(value: string, waitMs = 10_000) {
    const start = Date.now();
    while (Date.now() - start < waitMs) {
      if (getStreamData(events).includes(value)) {
        return;
      }
      await sleep(10);
    }
    throw new Error(
      `Timed out waiting for stream data: ${JSON.stringify(value)}`,
    );
  }

  return {
    events,
    getRedirectUrl() {
      return redirectUrl;
    },
    streamData() {
      return getStreamData(events);
    },
    waitForStreamData,
    done,
  };
}

/**
 * Poll a redirect URL until it returns stream or result events.
 * Returns the collected SSE events.
 */
export async function pollForAsyncStream(
  redirectUrl: string,
  { maxAttempts = 30, intervalMs = 500, readTimeoutMs = 5_000 } = {},
): Promise<SSEEvent[]> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(redirectUrl);
      if (res.ok && res.body) {
        const { events } = await readSSEStream(res, readTimeoutMs);

        const hasContent =
          events.some((e) => e.event === "stream") ||
          events.some((e) => e.event === "inngest.result");
        if (hasContent) {
          return events;
        }
      }
    } catch {
      // Dev server may not have the data ready yet
    }
    await sleep(intervalMs);
  }

  return [];
}

/**
 * Poll a redirect URL until it yields a live SSE connection, then return
 * an incremental reader (like `startSSEReader`) so the caller can assert
 * on data as it arrives.
 */
export async function pollForAsyncReader(
  redirectUrl: string,
  { maxAttempts = 30, intervalMs = 500, readerTimeoutMs = 15_000 } = {},
) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(redirectUrl);
      if (res.ok && res.body) {
        return startSSEReader(res, readerTimeoutMs);
      }
    } catch {
      // Dev server may not be ready yet
    }
    await sleep(intervalMs);
  }

  throw new Error(
    `pollForAsyncReader: no live connection after ${maxAttempts} attempts`,
  );
}
