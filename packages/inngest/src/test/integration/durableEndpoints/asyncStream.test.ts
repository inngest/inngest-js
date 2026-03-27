/*
 * This test file is for Durable Endpoints that:
 * - Go into async mode (e.g. step.sleep)
 * - Stream data
 */

import { createState, testNameFromFileUrl } from "@inngest/test-harness";
import { expect, test } from "vitest";
import { stream } from "../../../experimental/durable-endpoints.ts";
import { step } from "../../../index.ts";

import {
  createGate,
  getStreamData,
  pollForAsyncReader,
  readSseStream,
  setupEndpoint,
  startSseReader,
  streamingMethods,
  streamWith,
  urlWithTestName,
} from "./helpers.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test.concurrent.each(streamingMethods)("success (%s)", async (method) => {
  const state = createState({});
  const { port, waitForRunId } = await setupEndpoint(testFileName, async () => {
    await step.run("a", async () => {
      await streamWith(method, "sync-data");
    });
    await step.sleep("go-async", "1s");
    await step.run("b", async () => {
      await streamWith(method, "async-data");
    });
    return Response.json("done");
  });

  // Sync SSE stream
  const res = await fetch(urlWithTestName(`http://localhost:${port}`), {
    headers: { Accept: "text/event-stream" },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  state.runId = await waitForRunId();

  const { events, redirectUrl, runId } = await readSseStream(res);
  state.runId = runId;
  expect(events).toEqual([
    {
      event: "inngest.metadata",
      data: expect.any(String),
    },
    {
      event: "inngest.stream",
      data: '{"data":"sync-data","stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"}',
    },
    {
      event: "inngest.commit",
      data: '{"hashedStepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"}',
    },
    {
      event: "inngest.redirect_info",
      data: expect.any(String),
    },
  ]);

  // Async SSE stream
  const asyncReader = await pollForAsyncReader(redirectUrl!);
  await asyncReader.done;
  expect(asyncReader.events).toEqual([
    {
      event: "inngest.metadata",
      data: expect.any(String),
    },
    {
      event: "inngest.stream",
      data: '{"data":"async-data","stepId":"e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98"}',
    },
    {
      event: "inngest.commit",
      data: '{"hashedStepId":"e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98"}',
    },

    // FIXME: Why is this sent?
    {
      event: "inngest.metadata",
      data: expect.any(String),
    },

    {
      event: "inngest.response",
      data: JSON.stringify({
        status: "succeeded",
        response: {
          body: '"done"',
          statusCode: 200,
          headers: { "content-type": "application/json" },
        },
      }),
    },
  ]);

  await state.waitForRunComplete();
});

test("mixed push and pipe in one step", async () => {
  const state = createState({});
  const { port, waitForRunId } = await setupEndpoint(testFileName, async () => {
    await step.run("a", async () => {
      stream.push("sync-push-1");

      await stream.pipe(async function* () {
        yield "sync-pipe";
      });

      stream.push("sync-push-2");
    });
    await step.sleep("go-async", "1s");
    await step.run("b", async () => {
      stream.push("async-push-1");

      await stream.pipe(async function* () {
        yield "async-pipe";
      });

      stream.push("async-push-2");
    });
    return Response.json("done");
  });

  // Sync SSE stream
  const res = await fetch(urlWithTestName(`http://localhost:${port}`), {
    headers: { Accept: "text/event-stream" },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  state.runId = await waitForRunId();

  const { events, redirectUrl, runId } = await readSseStream(res);
  state.runId = runId;
  expect(events).toEqual([
    {
      event: "inngest.metadata",
      data: expect.any(String),
    },
    {
      event: "inngest.stream",
      data: '{"data":"sync-push-1","stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"}',
    },
    {
      event: "inngest.stream",
      data: '{"data":"sync-pipe","stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"}',
    },
    {
      event: "inngest.stream",
      data: '{"data":"sync-push-2","stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"}',
    },
    {
      event: "inngest.commit",
      data: '{"hashedStepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"}',
    },
    {
      event: "inngest.redirect_info",
      data: expect.any(String),
    },
  ]);

  // Follow redirect for async streaming
  expect(redirectUrl).toBeTruthy();
  const asyncReader = await pollForAsyncReader(redirectUrl!);
  await asyncReader.done;
  expect(asyncReader.events).toEqual([
    {
      event: "inngest.metadata",
      data: expect.any(String),
    },
    {
      event: "inngest.stream",
      data: '{"data":"async-push-1","stepId":"e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98"}',
    },
    {
      event: "inngest.stream",
      data: '{"data":"async-pipe","stepId":"e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98"}',
    },
    {
      event: "inngest.stream",
      data: '{"data":"async-push-2","stepId":"e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98"}',
    },
    {
      event: "inngest.commit",
      data: '{"hashedStepId":"e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98"}',
    },

    // FIXME: Why is this sent?
    {
      event: "inngest.metadata",
      data: expect.any(String),
    },

    {
      event: "inngest.response",
      data: JSON.stringify({
        status: "succeeded",
        response: {
          body: '"done"',
          statusCode: 200,
          headers: { "content-type": "application/json" },
        },
      }),
    },
  ]);

  await state.waitForRunComplete();
});

test("stream data is not buffered in sync or async mode", async () => {
  const state = createState({});

  // Use gates to pause between chunks, allowing us to assert that SSE events
  // arrive incrementally
  const gates = {
    syncStep: createGate(),
    asyncStep: createGate(),
  };

  const { port, waitForRunId } = await setupEndpoint(testFileName, async () => {
    await step.run("a", async () => {
      stream.push("first");
      await gates.syncStep.promise;
      stream.push("second");
    });
    await step.sleep("go-async", "1s");
    await step.run("b", async () => {
      stream.push("third");
      await gates.asyncStep.promise;
      stream.push("fourth");
    });
    return Response.json("done");
  });

  // Sync SSE stream
  const res = await fetch(urlWithTestName(`http://localhost:${port}`), {
    headers: { Accept: "text/event-stream" },
  });
  expect(res.status).toBe(200);
  state.runId = await waitForRunId();

  const sse = startSseReader(res);

  // First SSE event
  await sse.waitForStreamData("first");
  expect(getStreamData(sse.events)).not.toContain("second");

  // Open gate, allowing second SSE event
  gates.syncStep.open();
  await sse.waitForStreamData("second");

  await sse.done;
  state.runId = sse.getRunId();

  // Async SSE stream
  const sse2 = await pollForAsyncReader(sse.getRedirectUrl()!);

  // Third SSE event
  await sse2.waitForStreamData("third");
  expect(getStreamData(sse2.events)).not.toContain("fourth");

  // Open gate, allowing fourth SSE event
  gates.asyncStep.open();
  await sse2.waitForStreamData("fourth");

  await sse2.done;
  await state.waitForRunComplete();
});

test("no Accept header returns 302 redirect", async () => {
  const state = createState({});
  const { port, waitForRunId } = await setupEndpoint(testFileName, async () => {
    await step.run("sync", async () => {
      stream.push("buffered-data");
    });
    await step.sleep("go-async", "1s");
    await step.run("async", async () => {
      return "result";
    });
    return Response.json("final");
  });

  const res = await fetch(urlWithTestName(`http://localhost:${port}`), {
    redirect: "manual",
  });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBeTruthy();
  state.runId = await waitForRunId();
  await state.waitForRunComplete();
});

test("retries", async () => {
  const state = createState({});
  const { port, waitForRunId } = await setupEndpoint(testFileName, async () => {
    await step.run("a", async () => {
      stream.push("partial");
      throw new Error("boom");
    });
    return Response.json("unreachable");
  });

  const res = await fetch(urlWithTestName(`http://localhost:${port}`), {
    headers: { Accept: "text/event-stream" },
  });
  expect(res.status).toBe(200);
  state.runId = await waitForRunId();

  // Sync SSE stream
  const { events, redirectUrl } = await readSseStream(res);
  expect(events).toEqual([
    {
      event: "inngest.metadata",
      data: expect.any(String),
    },
    {
      event: "inngest.stream",
      data: '{"data":"partial","stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"}',
    },
    {
      event: "inngest.rollback",
      data: '{"hashedStepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"}',
    },
    {
      event: "inngest.redirect_info",
      data: expect.any(String),
    },
  ]);

  // Async SSE stream
  const asyncReader = await pollForAsyncReader(redirectUrl!);
  await asyncReader.done;
  expect(asyncReader.events).toEqual([
    {
      event: "inngest.metadata",
      data: expect.any(String),
    },
    {
      event: "inngest.stream",
      data: '{"data":"partial","stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"}',
    },
    {
      event: "inngest.rollback",
      data: '{"hashedStepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"}',
    },
    {
      event: "inngest.metadata",
      data: expect.any(String),
    },
    {
      event: "inngest.stream",
      data: '{"data":"partial","stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"}',
    },
    {
      event: "inngest.rollback",
      data: '{"hashedStepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"}',
    },
    {
      event: "inngest.metadata",
      data: expect.any(String),
    },
    {
      event: "inngest.stream",
      data: '{"data":"partial","stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"}',
    },
    {
      event: "inngest.rollback",
      data: '{"hashedStepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"}',
    },
    {
      event: "inngest.metadata",
      data: expect.any(String),
    },
    {
      event: "inngest.response",
      data: JSON.stringify({
        status: "failed",
        response: {
          body: '"boom"',
          statusCode: 500,
          headers: { "content-type": "application/json" },
        },
      }),
    },
  ]);

  await state.waitForRunFailed();
});
