import http from "node:http";
import { randomSuffix } from "@inngest/test-harness";
import { onTestFinished } from "vitest";
import {
  iterSse,
  type RawSseEvent,
} from "../../../components/execution/streaming.ts";
import { stream } from "../../../experimental/durable-endpoints.ts";
import { Inngest, type Logger } from "../../../index.ts";
import type { EndpointHandler } from "../../../node.ts";
import {
  createEndpointServer as createNodeEndpointServer,
  endpointAdapter,
} from "../../../node.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Read an SSE stream from a fetch Response, collecting events until the
 * stream closes or the timeout fires.
 */
export async function readSseStream(
  res: Response,
  timeoutMs = 30_000,
): Promise<{
  events: RawSseEvent[];
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
): Promise<{ port: number; server: http.Server }> {
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    endpointAdapter,
    logger: opts?.logger,
  });

  const endpointHandler = client.endpoint(handler);
  const { port, server } = await createEndpointServer(endpointHandler);
  onTestFinished(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
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
export function getStreamData(events: RawSseEvent[]): string[] {
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
 * Wrap a ReadableStream so it auto-cancels after `ms` milliseconds.
 * This lets us timeout an `iterSse` call without modifying the production code.
 */
function withTimeout(
  body: ReadableStream<Uint8Array>,
  ms: number,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout>;

  return new ReadableStream<Uint8Array>({
    start() {
      timer = setTimeout(() => {
        reader.cancel("SSE read timed out").catch(() => {});
      }, ms);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        clearTimeout(timer);
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
    cancel(reason) {
      clearTimeout(timer);
      return reader.cancel(reason);
    },
  });
}

/**
 * Start reading SSE events from a response in the background.
 * Events accumulate in `.events`; use `waitForStreamData` to
 * block until a specific chunk appears.
 */
export function startSseReader(res: Response, timeoutMs = 30_000) {
  const events: RawSseEvent[] = [];
  let redirectUrl: string | null = null;
  let runId: string | null = null;

  const done = (async () => {
    if (!res.body) {
      return;
    }

    for await (const raw of iterSse(withTimeout(res.body, timeoutMs))) {
      if (raw.event === "inngest.metadata") {
        try {
          const parsed = JSON.parse(raw.data);
          if (parsed.runId) {
            runId = parsed.runId;
          }
        } catch {
          // ignore
        }
      }
      if (raw.event === "inngest.redirect_info") {
        try {
          const parsed = JSON.parse(raw.data);
          if (parsed.url) {
            redirectUrl = parsed.url;
          }
        } catch {
          // ignore
        }
      }

      events.push(raw);

      // Terminal events mean the stream is logically done, even if the
      // server keeps the connection open (e.g. Dev Server SSE).
      if (raw.event === "inngest.result") {
        break;
      }
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
): Promise<RawSseEvent[]> {
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
 * Poll a redirect URL until it yields a live SSE connection, then return
 * an incremental reader (like `startSseReader`) so the caller can assert
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
        return startSseReader(res, readerTimeoutMs);
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
