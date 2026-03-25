/*
 * This test file is for Durable Endpoints that:
 * - Do not go into async mode
 * - Stream data
 */

import { testNameFromFileUrl } from "@inngest/test-harness";
import { expect, test } from "vitest";
import { stream } from "../../../experimental/durable-endpoints.ts";
import { NonRetriableError, step } from "../../../index.ts";

import {
  readSseStream,
  setupEndpoint,
  streamingMethods,
  streamWith,
} from "./helpers.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test.each(streamingMethods)(
  "push streams data across steps (%s)",
  async (method) => {
    const { port } = await setupEndpoint(testFileName, async () => {
      await step.run("a", async () => {
        await streamWith(method, "from a");
      });
      await step.run("b", async () => {
        await streamWith(method, "from b");
      });
      return Response.json("done");
    });

    const res = await fetch(`http://localhost:${port}/api/demo`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const { events } = await readSseStream(res);
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
        data: '{"data":"from a","stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"}',
      },
      {
        event: "inngest.step",
        data: '{"stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8","status":"completed"}',
      },
      {
        event: "inngest.redirect_info",
        data: expect.any(String),
      },
      {
        event: "inngest.step",
        data: '{"stepId":"e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98","status":"running"}',
      },
      {
        event: "stream",
        data: '{"data":"from b","stepId":"e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98"}',
      },
      {
        event: "inngest.step",
        data: '{"stepId":"e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98","status":"completed"}',
      },
      {
        event: "inngest.result",
        data: JSON.stringify({ status: "succeeded", data: '"done"' }),
      },
    ]);
  },
);

test("no explicit streaming", async () => {
  // If a client sets a streaming "Accept" header, still stream the response
  // even if the user code didn't explicitly stream (e.g. `stream.push()`). This
  // is necessary because the endpoint may stream *after* going into async mode,
  // and the client needs the redirect info (which comes via an SSE event)

  const { port } = await setupEndpoint(testFileName, async () => {
    await step.run("a", async () => {});
    await step.run("b", async () => {});
    return Response.json("done");
  });

  const res = await fetch(`http://localhost:${port}/api/demo`, {
    headers: { Accept: "text/event-stream" },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");

  const { events } = await readSseStream(res);
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
      event: "inngest.step",
      data: '{"stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8","status":"completed"}',
    },
    {
      event: "inngest.redirect_info",
      data: expect.any(String),
    },
    {
      event: "inngest.step",
      data: '{"stepId":"e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98","status":"running"}',
    },
    {
      event: "inngest.step",
      data: '{"stepId":"e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98","status":"completed"}',
    },
    {
      event: "inngest.result",
      data: JSON.stringify({ status: "succeeded", data: '"done"' }),
    },
  ]);
});

test("NonRetriableError", async () => {
  // Test `NonRetriableError` instead of a regular error because retries puts us
  // into async mode.

  const { port } = await setupEndpoint(testFileName, async () => {
    await step.run("a", async () => {
      stream.push("partial");
      throw new NonRetriableError("boom");
    });
    return Response.json("unreachable");
  });

  const res = await fetch(`http://localhost:${port}/api/demo`, {
    headers: { Accept: "text/event-stream" },
  });
  expect(res.status).toBe(200);

  const { events } = await readSseStream(res);
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
      data: '{"stepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8","status":"errored","data":{"willRetry":false,"error":"boom"}}',
    },
    {
      event: "inngest.redirect_info",
      data: expect.any(String),
    },
    {
      event: "inngest.result",

      // FIXME: This shouldn't be "[object Object]"
      data: JSON.stringify({ status: "failed", error: "[object Object]" }),
    },
  ]);
});
