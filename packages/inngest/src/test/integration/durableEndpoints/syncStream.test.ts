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
  getStreamData,
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
        data: JSON.stringify({ status: "succeeded", data: "done" }),
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
      data: JSON.stringify({ status: "succeeded", data: "done" }),
    },
  ]);
});

test("NonRetriableError in first step", async () => {
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
      data: JSON.stringify({ status: "failed", error: "boom" }),
    },
  ]);
});

test("stepless endpoint with streaming", async () => {
  const { port } = await setupEndpoint(testFileName, async () => {
    stream.push("no-steps-data");
    return Response.json("stepless done");
  });

  const res = await fetch(`http://localhost:${port}/api/demo`, {
    headers: { Accept: "text/event-stream" },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");

  const { events } = await readSseStream(res);
  expect(getStreamData(events)).toContain("no-steps-data");

  const resultEvent = events.find((e) => e.event === "inngest.result");
  expect(resultEvent).toBeTruthy();
  expect(JSON.parse(resultEvent!.data)).toEqual({
    status: "succeeded",
    data: "stepless done",
  });
});

test("non-streaming step among streaming steps", async () => {
  const { port } = await setupEndpoint(testFileName, async () => {
    await step.run("a", async () => {
      stream.push("from a");
    });
    // Step b does not stream anything
    await step.run("b", async () => {
      return "silent";
    });
    await step.run("c", async () => {
      stream.push("from c");
    });
    return Response.json("done");
  });

  const res = await fetch(`http://localhost:${port}/api/demo`, {
    headers: { Accept: "text/event-stream" },
  });
  expect(res.status).toBe(200);

  const { events } = await readSseStream(res);

  // Only steps a and c should have stream events
  const streamData = getStreamData(events);
  expect(streamData).toEqual(["from a", "from c"]);

  const resultEvent = events.find((e) => e.event === "inngest.result");
  expect(resultEvent).toBeTruthy();
  expect(JSON.parse(resultEvent!.data)).toEqual({
    status: "succeeded",
    data: "done",
  });
});

test("NonRetriableError in later step preserves earlier stream data", async () => {
  const { port } = await setupEndpoint(testFileName, async () => {
    await step.run("a", async () => {
      stream.push("survived-data");
    });
    await step.run("b", async () => {
      stream.push("doomed-data");
      throw new NonRetriableError("later boom");
    });
    return Response.json("unreachable");
  });

  const res = await fetch(`http://localhost:${port}/api/demo`, {
    headers: { Accept: "text/event-stream" },
  });
  expect(res.status).toBe(200);

  const { events } = await readSseStream(res);

  // Both stream events should be present — the earlier step's data survives
  const streamData = getStreamData(events);
  expect(streamData).toContain("survived-data");
  expect(streamData).toContain("doomed-data");

  // Step a should have completed successfully
  const stepEvents = events.filter((e) => e.event === "inngest.step");
  const completedSteps = stepEvents.filter((e) =>
    e.data.includes('"status":"completed"'),
  );
  expect(completedSteps.length).toBeGreaterThanOrEqual(1);

  // Step b should have errored
  const erroredSteps = stepEvents.filter((e) =>
    e.data.includes('"status":"errored"'),
  );
  expect(erroredSteps.length).toBe(1);
  expect(erroredSteps[0]!.data).toContain("later boom");

  // Result should indicate failure
  const resultEvent = events.find((e) => e.event === "inngest.result");
  expect(resultEvent).toBeTruthy();
  expect(JSON.parse(resultEvent!.data)).toEqual({
    status: "failed",
    error: "later boom",
  });
});
