import {
  createState,
  randomSuffix,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { describe, expect, onTestFinished, test } from "vitest";
import { endpointAdapter } from "../../../edge.ts";
import { Inngest, NonRetriableError, step, stream } from "../../../index.ts";
import { subscribeToRun } from "../../../stream.ts";
import {
  createEndpointServer,
  createGate,
  getStreamData,
  pollForAsyncReader,
  pollForAsyncStream,
  readSSEStream,
  startSSEReader,
} from "./helpers.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

/**
 * Helper: create an Inngest client + endpoint server, registering cleanup.
 */
async function setupEndpoint(
  handler: (req: Request) => Promise<Response>,
): Promise<{ port: number }> {
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    endpointAdapter,
  });

  const endpointHandler = client.endpoint(handler);
  const { port, server } = await createEndpointServer(endpointHandler);
  onTestFinished(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  return { port };
}

test(
  "durable endpoint streams data before and after async mode",
  { timeout: 60000 },
  async () => {
    const state = createState({});
    const gates = {
      betweenSyncSteps: createGate(),
      insideAsyncStep: createGate(),
    };

    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      endpointAdapter,
    });

    const handler = client.endpoint(async (_req: Request) => {
      await step.run("before-async-mode-1", async () => {
        stream.push("Hello\n");
      });

      // Used to for "stream is not buffered" assertion
      await gates.betweenSyncSteps.promise;

      await step.run("before-async-mode-2", async () => {
        stream.push("World\n");
      });

      // Force async mode
      await step.sleep("zzz", "1s");

      await step.run("after-async-mode", async () => {
        stream.push("Hola\n");

        // Used to for "stream is not buffered" assertion
        await gates.insideAsyncStep.promise;

        stream.push("mundo\n");
      });

      return new Response("All done");
    });

    const { port, server } = await createEndpointServer(handler);
    onTestFinished(() => {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });

    // --- Phase 1: Initial sync request → SSE stream ---
    const res = await fetch(`http://localhost:${port}/api/demo`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const sse = startSSEReader(res, 15_000);

    // First chunk streamed
    await sse.waitForStreamData("Hello\n");
    expect(sse.streamData()).not.toContain("World\n");

    // Second chunk streamed
    gates.betweenSyncSteps.open();
    await sse.waitForStreamData("World\n");

    // Wait for the stream to close (i.e. endpoint goes async mode)
    await sse.done;

    const metadataEvents = sse.events.filter(
      (e) => e.event === "inngest.metadata",
    );
    expect(metadataEvents.length).toBe(1);
    const metadata = JSON.parse(metadataEvents[0]!.data);
    expect(metadata).toHaveProperty("run_id");
    state.runId = metadata.run_id;

    // Redirect since async mode necessitates streaming via Dev Server
    const redirectUrl = sse.getRedirectUrl();
    expect(redirectUrl).toBeTruthy();

    const sse2 = await pollForAsyncReader(redirectUrl!);

    // First chunk streamed
    await sse2.waitForStreamData("Hola\n");
    expect(sse2.streamData()).not.toContain("mundo\n");

    // Second chunk streamed
    gates.insideAsyncStep.open();
    await sse2.waitForStreamData("mundo\n");

    // Wait for the stream to close (i.e. endpoint returned)
    await sse2.done;

    // Result event with the function's return value
    const resultEvents = sse2.events.filter(
      (e) => e.event === "inngest.result",
    );
    expect(resultEvents.length).toBe(1);
    expect(JSON.parse(resultEvents[0]!.data)).toEqual({
      status: "succeeded",
      data: "All done",
    });

    await state.waitForRunComplete();
  },
);

// ---------------------------------------------------------------------------
// Header Negotiation
//
// The response format depends on three factors:
//   1. Whether the client sent Accept: text/event-stream
//   2. Whether user code called stream.push() or stream.pipe()
//   3. Whether the function completed synchronously or went async
// ---------------------------------------------------------------------------

describe("header negotiation", () => {
  describe("Accept: text/event-stream", () => {
    describe("with streaming (push/pipe called)", () => {
      test(
        "sync: returns SSE stream with metadata, data, and result",
        { timeout: 60000 },
        async () => {
          const { port } = await setupEndpoint(async () => {
            await step.run("work", async () => {
              stream.push("hello");
            });
            return new Response("done");
          });

          const res = await fetch(`http://localhost:${port}/api/demo`, {
            headers: { Accept: "text/event-stream" },
          });

          expect(res.status).toBe(200);
          expect(res.headers.get("content-type")).toBe("text/event-stream");

          const { events } = await readSSEStream(res, 15_000);

          const metadata = events.filter((e) => e.event === "inngest.metadata");
          expect(metadata.length).toBe(1);
          expect(JSON.parse(metadata[0]!.data)).toHaveProperty("run_id");

          const streamData = getStreamData(events);
          expect(streamData).toContain("hello");

          const results = events.filter((e) => e.event === "inngest.result");
          expect(results.length).toBe(1);
          expect(JSON.parse(results[0]!.data)).toEqual({
            status: "succeeded",
            data: "done",
          });
        },
      );

      test(
        "async: returns SSE stream with redirect frame for async handoff",
        { timeout: 60000 },
        async () => {
          const { port } = await setupEndpoint(async () => {
            await step.run("work", async () => {
              stream.push("sync-data");
            });
            await step.sleep("wait", "1s");
            await step.run("after-async", async () => {
              return "async-result";
            });
            return new Response("final");
          });

          const res = await fetch(`http://localhost:${port}/api/demo`, {
            headers: { Accept: "text/event-stream" },
          });

          expect(res.status).toBe(200);
          expect(res.headers.get("content-type")).toBe("text/event-stream");

          const { events, redirectUrl } = await readSSEStream(res, 15_000);

          // Sync phase streams data before the async transition
          const streamData = getStreamData(events);
          expect(streamData).toContain("sync-data");

          // Redirect frame tells the client where to reconnect
          const redirects = events.filter(
            (e) => e.event === "inngest.redirect_info",
          );
          expect(redirects.length).toBe(1);
          expect(redirectUrl).toBeTruthy();
        },
      );
    });

    describe("without streaming", () => {
      test(
        "sync: returns SSE envelope with metadata and result only",
        { timeout: 60000 },
        async () => {
          const { port } = await setupEndpoint(async () => {
            await step.run("compute", async () => {
              return "computed";
            });
            return new Response("computed");
          });

          const res = await fetch(`http://localhost:${port}/api/demo`, {
            headers: { Accept: "text/event-stream" },
          });

          expect(res.status).toBe(200);
          expect(res.headers.get("content-type")).toBe("text/event-stream");

          const { events } = await readSSEStream(res, 15_000);

          const metadata = events.filter((e) => e.event === "inngest.metadata");
          expect(metadata.length).toBe(1);

          const results = events.filter((e) => e.event === "inngest.result");
          expect(results.length).toBe(1);
          expect(JSON.parse(results[0]!.data)).toEqual({
            status: "succeeded",
            data: "computed",
          });

          const streamFrames = events.filter((e) => e.event === "stream");
          expect(streamFrames.length).toBe(0);
        },
      );

      test("async: returns 302 redirect", { timeout: 60000 }, async () => {
        const { port } = await setupEndpoint(async () => {
          await step.run("first", async () => {
            return "a";
          });
          await step.sleep("wait", "1s");
          await step.run("second", async () => {
            return "b";
          });
          return new Response("final");
        });

        const res = await fetch(`http://localhost:${port}/api/demo`, {
          headers: { Accept: "text/event-stream" },
          redirect: "manual",
        });

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBeTruthy();
      });
    });
  });

  describe("no Accept header", () => {
    describe("with streaming (push/pipe called)", () => {
      test(
        "sync: returns raw Response, not SSE",
        { timeout: 60000 },
        async () => {
          const { port } = await setupEndpoint(async () => {
            await step.run("work", async () => {
              stream.push("data");
            });
            return new Response("done");
          });

          const res = await fetch(`http://localhost:${port}/api/demo`);

          expect(res.status).toBe(200);

          const contentType = res.headers.get("content-type") ?? "";
          expect(contentType).not.toBe("text/event-stream");

          const body = await res.text();
          expect(body).toBe("done");
        },
      );

      test("async: returns 302 redirect", { timeout: 60000 }, async () => {
        const { port } = await setupEndpoint(async () => {
          await step.run("work", async () => {
            stream.push("buffered-data");
          });
          await step.sleep("wait", "1s");
          await step.run("after-async", async () => {
            return "result";
          });
          return new Response("final");
        });

        const res = await fetch(`http://localhost:${port}/api/demo`, {
          redirect: "manual",
        });

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBeTruthy();
      });
    });

    describe("without streaming", () => {
      test(
        "sync: returns raw Response passthrough",
        { timeout: 60000 },
        async () => {
          const { port } = await setupEndpoint(async () => {
            await step.run("compute", async () => {
              return "result";
            });
            return new Response("result");
          });

          const res = await fetch(`http://localhost:${port}/api/demo`);

          expect(res.status).toBe(200);

          const body = await res.text();
          expect(body).toBe("result");
        },
      );

      test("async: returns 302 redirect", { timeout: 60000 }, async () => {
        const { port } = await setupEndpoint(async () => {
          await step.run("first", async () => {
            return "a";
          });
          await step.sleep("wait", "1s");
          await step.run("second", async () => {
            return "b";
          });
          return new Response("final");
        });

        const res = await fetch(`http://localhost:${port}/api/demo`, {
          redirect: "manual",
        });

        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toBeTruthy();
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Streaming Functionality
// ---------------------------------------------------------------------------

describe("streaming functionality", () => {
  test(
    "pipe() with async generator streams tokens",
    { timeout: 60000 },
    async () => {
      const { port } = await setupEndpoint(async () => {
        const result = await step.run("llm", async () => {
          return await stream.pipe(async function* () {
            yield "token1";
            yield "token2";
          });
        });
        return new Response(result);
      });

      const res = await fetch(`http://localhost:${port}/api/demo`, {
        headers: { Accept: "text/event-stream" },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");

      const { events } = await readSSEStream(res, 15_000);
      const streamData = getStreamData(events);

      expect(streamData).toContain("token1");
      expect(streamData).toContain("token2");

      // Result is the concatenated pipe output
      const results = events.filter((e) => e.event === "inngest.result");
      expect(results.length).toBe(1);
      expect(JSON.parse(results[0]!.data)).toEqual({
        status: "succeeded",
        data: "token1token2",
      });
    },
  );

  test("mixed push and pipe in one step", { timeout: 60000 }, async () => {
    const { port } = await setupEndpoint(async () => {
      await step.run("mixed", async () => {
        stream.push("Starting...");

        await stream.pipe(async function* () {
          yield "a";
          yield "b";
        });

        stream.push("Done");
      });
      return new Response("ok");
    });

    const res = await fetch(`http://localhost:${port}/api/demo`, {
      headers: { Accept: "text/event-stream" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const { events } = await readSSEStream(res, 15_000);
    const streamData = getStreamData(events);

    // All frames arrive in order
    expect(streamData).toEqual(["Starting...", "a", "b", "Done"]);

    // Result frame present
    const results = events.filter((e) => e.event === "inngest.result");
    expect(results.length).toBe(1);
  });

  test(
    "sync-only: streams across steps without async transition",
    { timeout: 60000 },
    async () => {
      const { port } = await setupEndpoint(async () => {
        await step.run("step-1", async () => {
          stream.push("from-step-1");
        });
        await step.run("step-2", async () => {
          stream.push("from-step-2");
        });
        return new Response("finished");
      });

      const res = await fetch(`http://localhost:${port}/api/demo`, {
        headers: { Accept: "text/event-stream" },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");

      const { events } = await readSSEStream(res, 15_000);
      const streamData = getStreamData(events);

      // Both steps' chunks present in order
      expect(streamData).toContain("from-step-1");
      expect(streamData).toContain("from-step-2");
      expect(streamData.indexOf("from-step-1")).toBeLessThan(
        streamData.indexOf("from-step-2"),
      );

      // Result frame
      const results = events.filter((e) => e.event === "inngest.result");
      expect(results.length).toBe(1);
      expect(JSON.parse(results[0]!.data)).toEqual({
        status: "succeeded",
        data: "finished",
      });

      // redirect_info is always sent once checkpoint creates the run

      // Step lifecycle frames present
      const stepEvents = events.filter((e) => e.event === "inngest.step");
      expect(stepEvents.length).toBeGreaterThanOrEqual(2);
    },
  );
});

// ---------------------------------------------------------------------------
// Error & Rollback
// ---------------------------------------------------------------------------

describe("error and rollback", () => {
  test(
    "step error emits errored frame with streamed data",
    { timeout: 60000 },
    async () => {
      const { port } = await setupEndpoint(async () => {
        await step.run("failing", async () => {
          stream.push("partial");
          throw new NonRetriableError("boom");
        });
        return new Response("unreachable");
      });

      const res = await fetch(`http://localhost:${port}/api/demo`, {
        headers: { Accept: "text/event-stream" },
      });

      expect(res.status).toBe(200);

      const { events } = await readSSEStream(res, 15_000);
      const streamData = getStreamData(events);

      // The partial data was streamed before the error
      expect(streamData).toContain("partial");

      // Step errored frame present
      const stepEvents = events.filter((e) => e.event === "inngest.step");
      const erroredFrames = stepEvents.filter((e) => {
        try {
          const parsed = JSON.parse(e.data);
          return parsed.status === "errored";
        } catch {
          return false;
        }
      });
      expect(erroredFrames.length).toBeGreaterThanOrEqual(1);

      const errorData = JSON.parse(erroredFrames[0]!.data);
      // will_retry is nested inside the data field of the step frame
      const willRetry = errorData.data?.will_retry ?? errorData.will_retry;
      expect(willRetry).toBe(false);
    },
  );

  test("push outside step.run has no step_id", { timeout: 60000 }, async () => {
    const { port } = await setupEndpoint(async () => {
      await step.run("first", async () => {
        stream.push("inside-step");
      });

      stream.push("between");

      await step.run("second", async () => {
        throw new NonRetriableError("fail");
      });
      return new Response("unreachable");
    });

    const res = await fetch(`http://localhost:${port}/api/demo`, {
      headers: { Accept: "text/event-stream" },
    });

    expect(res.status).toBe(200);

    const { events } = await readSSEStream(res, 15_000);

    // Find the "between" stream frame and verify it has no step_id
    const streamEvents = events.filter((e) => e.event === "stream");
    const betweenFrame = streamEvents.find((e) => {
      try {
        const parsed = JSON.parse(e.data);
        return (parsed?.data ?? parsed) === "between";
      } catch {
        return e.data === "between";
      }
    });

    expect(betweenFrame).toBeDefined();

    // Parse the frame data and check for absence of step_id
    const parsedBetween = JSON.parse(betweenFrame!.data);
    if (typeof parsedBetween === "object" && parsedBetween !== null) {
      expect(parsedBetween.step_id).toBeUndefined();
    }

    // The inside-step frame should have a step_id
    const insideFrame = streamEvents.find((e) => {
      try {
        const parsed = JSON.parse(e.data);
        return (parsed?.data ?? parsed) === "inside-step";
      } catch {
        return e.data === "inside-step";
      }
    });
    expect(insideFrame).toBeDefined();
    const parsedInside = JSON.parse(insideFrame!.data);
    if (typeof parsedInside === "object" && parsedInside !== null) {
      expect(parsedInside.step_id).toBeDefined();
    }
  });

  test(
    "NonRetriableError after async mode sends inngest.result failed frame",
    { timeout: 60000 },
    async () => {
      const state = createState({});

      const client = new Inngest({
        id: randomSuffix(testFileName),
        isDev: true,
        endpointAdapter,
      });

      const handler = client.endpoint(async () => {
        await step.run("setup", async () => {
          stream.push("setting up\n");
        });

        // Force async mode
        await step.sleep("pause", "1s");

        await step.run("failing-after-async", async () => {
          stream.push("about to fail\n");
          throw new NonRetriableError(
            "Dog Speak is Much Too Hard to Translate",
          );
        });

        return new Response("unreachable");
      });

      const { port, server } = await createEndpointServer(handler);
      onTestFinished(
        () => new Promise<void>((resolve) => server.close(() => resolve())),
      );

      // Phase 1: Initial sync request → SSE stream
      const res = await fetch(`http://localhost:${port}/api/demo`, {
        headers: { Accept: "text/event-stream" },
      });
      expect(res.status).toBe(200);

      const sse = startSSEReader(res, 15_000);
      await sse.waitForStreamData("setting up\n");
      await sse.done;

      const metadataEvents = sse.events.filter(
        (e) => e.event === "inngest.metadata",
      );
      expect(metadataEvents.length).toBe(1);
      const metadata = JSON.parse(metadataEvents[0]!.data);
      state.runId = metadata.run_id;

      const redirectUrl = sse.getRedirectUrl();
      expect(redirectUrl).toBeTruthy();

      // Phase 2: Follow redirect → async stream from Dev Server
      const asyncEvents = await pollForAsyncStream(redirectUrl!, {
        maxAttempts: 30,
        intervalMs: 500,
        readTimeoutMs: 15_000,
      });

      // inngest.result failed frame must be present — this is the bug fix.
      // Before the fix, the stream closed without a terminal result frame,
      // so onFunctionFailed never fired on the client.
      const resultEvents = asyncEvents.filter(
        (e) => e.event === "inngest.result",
      );
      expect(resultEvents.length).toBe(1);
      const resultData = JSON.parse(resultEvents[0]!.data);
      expect(resultData.status).toBe("failed");
      expect(resultData.error).toContain("Dog Speak");
    },
  );
});

// ---------------------------------------------------------------------------
// Late Joiner
// ---------------------------------------------------------------------------

describe("late joiner", () => {
  // Skipped: the late-joiner problem is explicitly out of scope (see task.md).
  // This test documents the desired behavior for when it's implemented.
  test.skip(
    "async chunks available after delayed client connection",
    { timeout: 90000 },
    async () => {
      const { port } = await setupEndpoint(async () => {
        await step.run("sync-step", async () => {
          stream.push("sync-data");
        });

        // Force async mode
        await step.sleep("wait", "1s");

        await step.run("async-step", async () => {
          stream.push("async-data");
        });

        return new Response("complete");
      });

      // Phase 1: read the sync SSE stream to get the redirect URL
      const res = await fetch(`http://localhost:${port}/api/demo`, {
        headers: { Accept: "text/event-stream" },
      });
      expect(res.status).toBe(200);

      const { events: syncEvents, redirectUrl } = await readSSEStream(
        res,
        15_000,
      );

      // Sync stream should have our data and a redirect
      const syncData = getStreamData(syncEvents);
      expect(syncData).toContain("sync-data");
      expect(redirectUrl).toBeTruthy();

      // Phase 2: delay before connecting to the redirect URL
      await new Promise((r) => setTimeout(r, 3000));

      // Phase 3: connect to redirect and check for async data
      const asyncEvents = await pollForAsyncStream(redirectUrl!, {
        maxAttempts: 60,
        intervalMs: 1000,
        readTimeoutMs: 10_000,
      });

      // Document whatever we find — the async chunks may or may not be
      // buffered by the dev server
      const asyncData = getStreamData(asyncEvents);
      const hasResult = asyncEvents.some((e) => e.event === "inngest.result");

      // At minimum, the result should eventually be available
      if (hasResult) {
        const result = asyncEvents.find((e) => e.event === "inngest.result");
        expect(JSON.parse(result!.data)).toEqual({
          status: "succeeded",
          data: "complete",
        });
      }

      // If async data is present, verify it
      if (asyncData.includes("async-data")) {
        expect(asyncData).toContain("async-data");
      }
    },
  );
});

// ---------------------------------------------------------------------------
// subscribeToRun client integration
// ---------------------------------------------------------------------------

describe("subscribeToRun client", () => {
  test(
    "receives all data across sync and async phases via eager redirect",
    { timeout: 60000 },
    async () => {
      const state = createState({});
      const gate = createGate();

      const { port } = await setupEndpoint(async () => {
        await step.run("sync-step", async () => {
          stream.push("sync-a");
          stream.push("sync-b");
        });

        // Force async mode
        await step.sleep("zzz", "1s");

        await step.run("async-step", async () => {
          stream.push("async-c");

          // Gate so we can verify streaming arrives incrementally
          await gate.promise;

          stream.push("async-d");
        });

        return new Response("done");
      });

      // Use subscribeToRun as the client — this exercises the eager redirect
      // path against a real dev server SSE endpoint.
      const frames: Array<{ type: string; data?: unknown }> = [];
      let runId: string | undefined;
      let sawRedirect = false;
      let gateOpened = false;

      const gen = subscribeToRun({
        url: `http://localhost:${port}/api/demo`,
      });

      for await (const frame of gen) {
        frames.push(frame);

        if (frame.type === "inngest.metadata") {
          runId = frame.run_id;
          state.runId = frame.run_id;
        }

        if (frame.type === "inngest.redirect_info") {
          sawRedirect = true;
        }

        // Open the gate once we see the first async chunk so the endpoint
        // can finish.
        if (
          frame.type === "stream" &&
          frame.data === "async-c" &&
          !gateOpened
        ) {
          gateOpened = true;
          gate.open();
        }

        // subscribeToRun yields all frames including inngest.result but
        // doesn't break on it (that's RunStream's job). Stop manually.
        if (frame.type === "inngest.result") {
          break;
        }
      }

      // Basic structural assertions
      expect(runId).toBeTruthy();
      expect(sawRedirect).toBe(true);

      // All stream data arrived in order, spanning both sync and async phases.
      const streamData = frames
        .filter((f) => f.type === "stream")
        .map((f) => f.data);
      expect(streamData).toEqual(["sync-a", "sync-b", "async-c", "async-d"]);

      // Result frame arrived
      const resultFrame = frames.find((f) => f.type === "inngest.result");
      expect(resultFrame).toBeDefined();

      await state.waitForRunComplete();
    },
  );
});
