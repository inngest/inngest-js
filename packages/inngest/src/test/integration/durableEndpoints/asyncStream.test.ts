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
} from "./helpers.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test.each(streamingMethods)("success (%s)", async (method) => {
  const state = createState({});
  const { port } = await setupEndpoint(testFileName, async () => {
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
  const res = await fetch(`http://localhost:${port}/api/demo`, {
    headers: { Accept: "text/event-stream" },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");

  // Sync SSE stream
  const { events, redirectUrl, runId } = await readSseStream(res);
  state.runId = runId;
  expect(events).toEqual([
    {
      event: "inngest.metadata",
      data: expect.any(String),
    },
    {
      event: "inngest.step",
      data: '{"stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8","status":"running"}',
    },
    {
      event: "stream",
      data: '{"data":"sync-data","stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"}',
    },
    {
      event: "inngest.step",
      data: '{"stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8","status":"completed"}',
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
      event: "inngest.step",
      data: '{"stepId":"e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98","status":"running"}',
    },
    {
      event: "stream",
      data: '{"data":"async-data","stepId":"e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98"}',
    },
    {
      event: "inngest.step",
      data: '{"stepId":"e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98","status":"completed"}',
    },

    // FIXME: Why is this sent?
    {
      event: "inngest.metadata",
      data: expect.any(String),
    },

    {
      event: "inngest.result",
      data: JSON.stringify({ status: "succeeded", data: '"done"' }),
    },
  ]);

  await state.waitForRunComplete();
});

test("mixed push and pipe in one step", async () => {
  const state = createState({});
  const { port } = await setupEndpoint(testFileName, async () => {
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
  const res = await fetch(`http://localhost:${port}/api/demo`, {
    headers: { Accept: "text/event-stream" },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");

  const { events, redirectUrl, runId } = await readSseStream(res);
  state.runId = runId;
  expect(events).toEqual([
    {
      event: "inngest.metadata",
      data: expect.any(String),
    },
    {
      event: "inngest.step",
      data: '{"stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8","status":"running"}',
    },
    {
      event: "stream",
      data: '{"data":"sync-push-1","stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"}',
    },
    {
      event: "stream",
      data: '{"data":"sync-pipe","stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"}',
    },
    {
      event: "stream",
      data: '{"data":"sync-push-2","stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"}',
    },
    {
      event: "inngest.step",
      data: '{"stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8","status":"completed"}',
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
      event: "inngest.step",
      data: '{"stepId":"e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98","status":"running"}',
    },
    {
      event: "stream",
      data: '{"data":"async-push-1","stepId":"e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98"}',
    },
    {
      event: "stream",
      data: '{"data":"async-pipe","stepId":"e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98"}',
    },
    {
      event: "stream",
      data: '{"data":"async-push-2","stepId":"e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98"}',
    },
    {
      event: "inngest.step",
      data: '{"stepId":"e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98","status":"completed"}',
    },

    // FIXME: Why is this sent?
    {
      event: "inngest.metadata",
      data: expect.any(String),
    },

    {
      event: "inngest.result",
      data: JSON.stringify({ status: "succeeded", data: '"done"' }),
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

  const { port } = await setupEndpoint(testFileName, async () => {
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
  const res = await fetch(`http://localhost:${port}/api/demo`, {
    headers: { Accept: "text/event-stream" },
  });
  expect(res.status).toBe(200);

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
  const { port } = await setupEndpoint(testFileName, async () => {
    await step.run("sync", async () => {
      stream.push("buffered-data");
    });
    await step.sleep("go-async", "1s");
    await step.run("async", async () => {
      return "result";
    });
    return Response.json("final");
  });

  const res = await fetch(`http://localhost:${port}/api/demo`, {
    redirect: "manual",
  });

  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBeTruthy();
});

test("retries", async () => {
  const state = createState({});
  const { port } = await setupEndpoint(testFileName, async () => {
    await step.run("a", async () => {
      stream.push("partial");
      throw new Error("boom");
    });
    return Response.json("unreachable");
  });

  const res = await fetch(`http://localhost:${port}/api/demo`, {
    headers: { Accept: "text/event-stream" },
  });
  expect(res.status).toBe(200);

  // Sync SSE stream
  const { events, redirectUrl, runId } = await readSseStream(res);
  state.runId = runId;
  expect(events).toEqual([
    {
      event: "inngest.metadata",
      data: expect.any(String),
    },
    {
      event: "inngest.step",
      data: '{"stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8","status":"running"}',
    },
    {
      event: "stream",
      data: '{"data":"partial","stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"}',
    },
    {
      event: "inngest.step",
      data: '{"stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8","status":"errored","data":{"willRetry":true,"error":"boom"}}',
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
      event: "inngest.step",
      data: '{"stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8","status":"running"}',
    },
    {
      event: "stream",
      data: '{"data":"partial","stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"}',
    },
    {
      event: "inngest.step",
      data: '{"stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8","status":"errored","data":{"willRetry":true,"error":"boom"}}',
    },
    {
      event: "inngest.metadata",
      data: expect.any(String),
    },
    {
      event: "inngest.step",
      data: '{"stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8","status":"running"}',
    },
    {
      event: "stream",
      data: '{"data":"partial","stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"}',
    },
    {
      event: "inngest.step",
      data: '{"stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8","status":"errored","data":{"willRetry":true,"error":"boom"}}',
    },
    {
      event: "inngest.metadata",
      data: expect.any(String),
    },
    {
      event: "inngest.step",
      data: '{"stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8","status":"running"}',
    },
    {
      event: "stream",
      data: '{"data":"partial","stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"}',
    },
    {
      event: "inngest.step",
      data: '{"stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8","status":"errored","data":{"willRetry":true,"error":"boom"}}',
    },
    {
      event: "inngest.metadata",
      data: expect.any(String),
    },
    {
      event: "inngest.result",
      data: '{"status":"failed","error":"boom"}',
    },
  ]);

  await state.waitForRunFailed();
});
