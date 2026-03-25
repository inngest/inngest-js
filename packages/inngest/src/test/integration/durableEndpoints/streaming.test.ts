import { createState, testNameFromFileUrl } from "@inngest/test-harness";
import { describe, expect, test } from "vitest";
import { stream } from "../../../experimental/durable-endpoints.ts";
import { NonRetriableError, step } from "../../../index.ts";

import {
  createGate,
  getStreamData,
  pollForAsyncReader,
  pollForAsyncStream,
  readSseStream,
  setupEndpoint,
  startSseReader,
} from "./helpers.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test(
  "durable endpoint streams data before and after async mode",
  { timeout: 60000 },
  async () => {
    const state = createState({});
    const gates = {
      betweenSyncSteps: createGate(),
      insideAsyncStep: createGate(),
    };

    const { port } = await setupEndpoint(
      testFileName,
      async (_req: Request) => {
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
      },
    );

    // --- Phase 1: Initial sync request → SSE stream ---
    const res = await fetch(`http://localhost:${port}/api/demo`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const sse = startSseReader(res, 15_000);

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
    expect(metadata).toHaveProperty("runId");
    state.runId = metadata.runId;

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
          const { port } = await setupEndpoint(testFileName, async () => {
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

          const { events } = await readSseStream(res, 15_000);

          const metadata = events.filter((e) => e.event === "inngest.metadata");
          expect(metadata.length).toBe(1);
          expect(JSON.parse(metadata[0]!.data)).toHaveProperty("runId");

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
        "async: returns SSE stream with redirect event for async handoff",
        { timeout: 60000 },
        async () => {
          const { port } = await setupEndpoint(testFileName, async () => {
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

          const { events, redirectUrl } = await readSseStream(res, 15_000);

          // Sync phase streams data before the async transition
          const streamData = getStreamData(events);
          expect(streamData).toContain("sync-data");

          // Redirect event tells the client where to reconnect
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
          const { port } = await setupEndpoint(testFileName, async () => {
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

          const { events } = await readSseStream(res, 15_000);

          const metadata = events.filter((e) => e.event === "inngest.metadata");
          expect(metadata.length).toBe(1);

          const results = events.filter((e) => e.event === "inngest.result");
          expect(results.length).toBe(1);
          expect(JSON.parse(results[0]!.data)).toEqual({
            status: "succeeded",
            data: "computed",
          });

          const streamEvents = events.filter((e) => e.event === "stream");
          expect(streamEvents.length).toBe(0);
        },
      );

      test("async: returns 302 redirect", { timeout: 60000 }, async () => {
        const { port } = await setupEndpoint(testFileName, async () => {
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
          const { port } = await setupEndpoint(testFileName, async () => {
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
        const { port } = await setupEndpoint(testFileName, async () => {
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
          const { port } = await setupEndpoint(testFileName, async () => {
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
        const { port } = await setupEndpoint(testFileName, async () => {
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
// Group 2: Streaming Functionality
// ---------------------------------------------------------------------------

describe("streaming functionality", () => {
  test(
    "pipe() with async generator streams tokens",
    { timeout: 60000 },
    async () => {
      const { port } = await setupEndpoint(testFileName, async () => {
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

      const { events } = await readSseStream(res, 15_000);
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
    const { port } = await setupEndpoint(testFileName, async () => {
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

    const { events } = await readSseStream(res, 15_000);
    const streamData = getStreamData(events);

    // All events arrive in order
    expect(streamData).toEqual(["Starting...", "a", "b", "Done"]);

    // Result event present
    const results = events.filter((e) => e.event === "inngest.result");
    expect(results.length).toBe(1);
  });

  test(
    "sync-only: streams across steps without async transition",
    { timeout: 60000 },
    async () => {
      const { port } = await setupEndpoint(testFileName, async () => {
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

      const { events } = await readSseStream(res, 15_000);
      const streamData = getStreamData(events);

      // Both steps' chunks present in order
      expect(streamData).toContain("from-step-1");
      expect(streamData).toContain("from-step-2");
      expect(streamData.indexOf("from-step-1")).toBeLessThan(
        streamData.indexOf("from-step-2"),
      );

      // Result event
      const results = events.filter((e) => e.event === "inngest.result");
      expect(results.length).toBe(1);
      expect(JSON.parse(results[0]!.data)).toEqual({
        status: "succeeded",
        data: "finished",
      });

      // redirect_info is always sent once checkpoint creates the run

      // Step lifecycle events present
      const stepEvents = events.filter((e) => e.event === "inngest.step");
      expect(stepEvents.length).toBeGreaterThanOrEqual(2);
    },
  );
});

// ---------------------------------------------------------------------------
// Group 3: Error & Rollback
// ---------------------------------------------------------------------------

describe("error and rollback", () => {
  test(
    "step error emits errored event with streamed data",
    { timeout: 60000 },
    async () => {
      const { port } = await setupEndpoint(testFileName, async () => {
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

      const { events } = await readSseStream(res, 15_000);
      const streamData = getStreamData(events);

      // The partial data was streamed before the error
      expect(streamData).toContain("partial");

      // Step errored event present
      const stepEvents = events.filter((e) => e.event === "inngest.step");
      const erroredEvents = stepEvents.filter((e) => {
        try {
          const parsed = JSON.parse(e.data);
          return parsed.status === "errored";
        } catch {
          return false;
        }
      });
      expect(erroredEvents.length).toBeGreaterThanOrEqual(1);

      const errorData = JSON.parse(erroredEvents[0]!.data);
      // willRetry is nested inside the data field of the step event
      const willRetry = errorData.data?.willRetry ?? errorData.willRetry;
      expect(willRetry).toBe(false);
    },
  );

  test("push outside step.run has no stepId", { timeout: 60000 }, async () => {
    const { port } = await setupEndpoint(testFileName, async () => {
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

    const { events } = await readSseStream(res, 15_000);

    // Find the "between" stream event and verify it has no stepId
    const streamEvents = events.filter((e) => e.event === "stream");
    const betweenEvent = streamEvents.find((e) => {
      try {
        const parsed = JSON.parse(e.data);
        return (parsed?.data ?? parsed) === "between";
      } catch {
        return e.data === "between";
      }
    });

    expect(betweenEvent).toBeDefined();

    // Parse the event data and check for absence of stepId
    const parsedBetween = JSON.parse(betweenEvent!.data);
    if (typeof parsedBetween === "object" && parsedBetween !== null) {
      expect(parsedBetween.stepId).toBeUndefined();
    }

    // The inside-step event should have a stepId
    const insideEvent = streamEvents.find((e) => {
      try {
        const parsed = JSON.parse(e.data);
        return (parsed?.data ?? parsed) === "inside-step";
      } catch {
        return e.data === "inside-step";
      }
    });
    expect(insideEvent).toBeDefined();
    const parsedInside = JSON.parse(insideEvent!.data);
    if (typeof parsedInside === "object" && parsedInside !== null) {
      expect(parsedInside.stepId).toBeDefined();
    }
  });

  // Fails
  test.skip(
    "NonRetriableError after async mode sends inngest.result failed event",
    { timeout: 60000 },
    async () => {
      const state = createState({});

      const { port } = await setupEndpoint(testFileName, async () => {
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

      // Phase 1: Initial sync request → SSE stream
      const res = await fetch(`http://localhost:${port}/api/demo`, {
        headers: { Accept: "text/event-stream" },
      });
      expect(res.status).toBe(200);

      const sse = startSseReader(res, 15_000);
      await sse.waitForStreamData("setting up\n");
      await sse.done;

      const metadataEvents = sse.events.filter(
        (e) => e.event === "inngest.metadata",
      );
      expect(metadataEvents.length).toBe(1);
      const metadata = JSON.parse(metadataEvents[0]!.data);
      state.runId = metadata.runId;

      const redirectUrl = sse.getRedirectUrl();
      expect(redirectUrl).toBeTruthy();

      // Phase 2: Follow redirect → async stream from Dev Server
      const asyncEvents = await pollForAsyncStream(redirectUrl!, {
        maxAttempts: 30,
        intervalMs: 500,
        readTimeoutMs: 15_000,
      });

      // inngest.result failed event must be present — this is the bug fix.
      // Before the fix, the stream closed without a terminal result event,
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
