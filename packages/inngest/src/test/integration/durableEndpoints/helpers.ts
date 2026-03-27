import http from "node:http";
import { randomSuffix, waitFor } from "@inngest/test-harness";
import { expect, onTestFinished } from "vitest";
import { getAsyncCtxSync } from "../../../components/execution/als.ts";
import { stream } from "../../../experimental/durable-endpoints.ts";
import { Inngest, type Logger } from "../../../index.ts";
import type { EndpointHandler } from "../../../node.ts";
import {
  createEndpointServer as createNodeEndpointServer,
  endpointAdapter,
} from "../../../node.ts";
import { silencedLogger } from "../../helpers.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Read an SSE stream from a fetch Response, collecting events until the
 * stream closes or the timeout fires.
 */
export async function readSseStream(
  res: Response,
  timeoutMs = 30_000,
): Promise<{
  events: SseEvent[];
  redirectUrl: string | null;
  runId: string | null;
}> {
  const sse = startSseReader(res, timeoutMs);
  await sse.done;
  return {
    events: sse.events,
    redirectUrl: sse.getRedirectUrl(),
    runId: sse.getRunId(),
  };
}

/**
 * Create an HTTP server for a durable endpoint handler, bound to a random port.
 *
 * Uses the production Node.js bridge from `inngest/node` so test infra stays
 * in sync with the real implementation.
 */
export async function createEndpointServer(
  handler: EndpointHandler,
): Promise<{ port: number; server: http.Server }> {
  const server = createNodeEndpointServer(handler);

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
 * Create an Inngest client + endpoint server, registering cleanup via
 * `onTestFinished`. Call from inside a Vitest `test()` block.
 */
export async function setupEndpoint(
  testFileName: string,
  handler: (req: Request) => Promise<Response>,
  opts?: {
    logger?: Logger;
  },
): Promise<{
  port: number;
  server: http.Server;
  waitForRunId: () => Promise<string>;
}> {
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    endpointAdapter,
    logger: opts?.logger ?? silencedLogger,
  });

  let runId: string | undefined;

  // Hacky way to handle a race in the Inngest server. The Durable Endpoint does
  // a JIT sync on the first request, but it's non-blocking. To ensure that the
  // Durable Endpoint is synced for the test, we'll do a "warmup" request
  let synced = false;

  const wrappedHandler: typeof handler = async (req) => {
    if (!synced) {
      synced = true;
      return Response.json({});
    }

    const currentRunId = getAsyncCtxSync()?.execution?.ctx.runId;

    // Guard against stale reentry requests from a previous test's run
    // that hit this port after the OS recycled it.
    if (currentRunId && runId && currentRunId !== runId) {
      return new Response("stale run", { status: 410 });
    }

    if (currentRunId) {
      runId = currentRunId;
    }

    return handler(req);
  };

  const endpointHandler = client.endpoint(wrappedHandler);
  const { port, server } = await createEndpointServer(endpointHandler);
  onTestFinished(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );

  async function waitForRunId() {
    return waitFor(async () => {
      if (!runId) {
        throw new Error("runId not set yet");
      }
      return runId;
    });
  }

  await fetch(`http://localhost:${port}`, {
    headers: { Accept: "text/event-stream" },
  });

  await waitFor(() => {
    if (!synced) {
      throw new Error("synced not set yet");
    }
  });

  return { port, server, waitForRunId };
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
export function getStreamData(events: SseEvent[]): string[] {
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
export function startSseReader(res: Response, timeoutMs = 30_000) {
  const events: SseEvent[] = [];
  let redirectUrl: string | null = null;
  let runId: string | null = null;

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
          const isHeartbeat = part.trim() === ":";
          if (isHeartbeat) {
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

          if (event === "inngest.metadata") {
            try {
              const parsed = JSON.parse(data);
              if (parsed.runId) {
                runId = parsed.runId;
              }
            } catch {
              // ignore
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

          // Terminal events mean the stream is logically done, even if the
          // server keeps the connection open (e.g. Dev Server SSE).
          if (event === "inngest.result") {
            reader.cancel("terminal event received").catch(() => {});
            break;
          }
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
    getRunId() {
      return runId;
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
): Promise<SseEvent[]> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(redirectUrl);
      if (res.ok && res.body) {
        const { events } = await readSseStream(res, readTimeoutMs);

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
 * Poll a redirect URL until it yields a live SSE connection with actual
 * content (not just the IS keepalive), then return an incremental reader
 * so the caller can assert on data as it arrives.
 *
 * Retries when the IS returns 200 but closes immediately with only a
 * keepalive `message` event and no stream/result content — this happens
 * when the async execution hasn't started publishing yet.
 */
export async function pollForAsyncReader(redirectUrl: string) {
  const maxAttempts = 30;
  const intervalMs = 500;
  const readerTimeoutMs = 15_000;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(redirectUrl);
      if (res.ok && res.body) {
        const reader = startSseReader(res, readerTimeoutMs);

        // Wait for the stream to finish or for content to arrive.
        // If we only got the keepalive, retry.
        const hasContent = await Promise.race([
          reader.done.then(() => {
            return reader.events.some(
              (e) =>
                e.event === "stream" ||
                e.event === "inngest.result" ||
                e.event === "inngest.commit" ||
                e.event === "inngest.rollback",
            );
          }),
          // If the stream is still open after 2s with content, it's live.
          sleep(2000).then(() => {
            return reader.events.some(
              (e) =>
                e.event === "stream" ||
                e.event === "inngest.result" ||
                e.event === "inngest.commit" ||
                e.event === "inngest.rollback",
            );
          }),
        ]);

        if (hasContent) {
          return reader;
        }
        // No content — IS closed early or keepalive only. Retry.
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

export const streamingMethods = [
  "push",
  "pipe-generator",
  "pipe-stream",
] as const;

export async function streamWith(
  method: (typeof streamingMethods)[number],
  data: string,
) {
  if (method === "push") {
    stream.push(data);
  } else if (method === "pipe-generator") {
    await stream.pipe(async function* () {
      yield data;
    });
  } else {
    await stream.pipe(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(data));
          controller.close();
        },
      }),
    );
  }
}

export function urlWithTestName(url: string) {
  const params = new URLSearchParams({
    test: expect.getState().currentTestName ?? "",
  });
  return `${url}?${params.toString()}`;
}
