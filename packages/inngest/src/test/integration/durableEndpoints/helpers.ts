import http from "node:http";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface SSEEvent {
  event: string;
  data: string;
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

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let timedOut = false;

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

      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        if (!part.trim()) {
          continue;
        }

        let event = "message";
        let data = "";

        for (const line of part.split("\n")) {
          if (line.startsWith("event: ")) {
            event = line.slice(7);
          } else if (line.startsWith("data: ")) {
            data = line.slice(6);
          }
        }

        if (event === "inngest.redirect_info") {
          try {
            const parsed = JSON.parse(data);
            if (parsed.url) {
              redirectUrl = parsed.url;
            }
          } catch {
            // ignore parse errors
          }
        }

        events.push({ event, data });
      }
    }
  } catch (err) {
    if (!timedOut) {
      throw err;
    }
  } finally {
    clearTimeout(timeout);
  }

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

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let timedOut = false;

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

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          if (!part.trim()) {
            continue;
          }

          let event = "message";
          let data = "";

          for (const line of part.split("\n")) {
            if (line.startsWith("event: ")) {
              event = line.slice(7);
            } else if (line.startsWith("data: ")) {
              data = line.slice(6);
            }
          }

          if (event === "inngest.redirect_info") {
            try {
              const parsed = JSON.parse(data);
              if (parsed.url) {
                redirectUrl = parsed.url;
              }
            } catch {
              // ignore
            }
          }

          events.push({ event, data });
        }
      }
    } catch (err) {
      if (!timedOut) {
        throw err;
      }
    } finally {
      clearTimeout(timeout);
    }
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
