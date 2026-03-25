/*
 * This test file is for Durable Endpoints that:
 * - Do not go into async mode
 * - Stream data
 */

import { testNameFromFileUrl } from "@inngest/test-harness";
import { expect, test } from "vitest";
import { stream } from "../../../experimental/durable-endpoints.ts";
import { step } from "../../../index.ts";

import { getStreamData, readSseStream, setupEndpoint } from "./helpers.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("push streams data across steps", async () => {
  const { port } = await setupEndpoint(testFileName, async () => {
    await step.run("step-1", async () => {
      stream.push("from-step-1");
    });
    await step.run("step-2", async () => {
      stream.push("from-step-2");
    });
    return Response.json("done");
  });

  const res = await fetch(`http://localhost:${port}/api/demo`, {
    headers: { Accept: "text/event-stream" },
  });

  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");

  const { events } = await readSseStream(res);
  const streamData = getStreamData(events);

  expect(streamData).toEqual(["from-step-1", "from-step-2"]);

  const results = events.filter((e) => e.event === "inngest.result");
  expect(results.length).toBe(1);
  expect(JSON.parse(results[0]!.data)).toEqual({
    status: "succeeded",
    data: '"done"',
  });
});

test("pipe() streams tokens from an async generator", async () => {
  const { port } = await setupEndpoint(testFileName, async () => {
    const result = await step.run("llm", async () => {
      return await stream.pipe(async function* () {
        yield "token1";
        yield "token2";
      });
    });
    return Response.json(result);
  });

  const res = await fetch(`http://localhost:${port}/api/demo`, {
    headers: { Accept: "text/event-stream" },
  });

  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");

  const { events } = await readSseStream(res);
  const streamData = getStreamData(events);

  expect(streamData).toContain("token1");
  expect(streamData).toContain("token2");

  const results = events.filter((e) => e.event === "inngest.result");
  expect(results.length).toBe(1);
  expect(JSON.parse(results[0]!.data)).toEqual({
    status: "succeeded",
    data: '"token1token2"',
  });
});

test("no Accept header returns raw Response, not SSE", async () => {
  // Does not stream if there isn't an "Accept" header telling it to.

  const { port } = await setupEndpoint(testFileName, async () => {
    await step.run("work", async () => {
      stream.push("ignored-by-client");
    });
    return Response.json("plain result");
  });

  const res = await fetch(`http://localhost:${port}/api/demo`);

  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).not.toBe("text/event-stream");
  expect(await res.json()).toBe("plain result");
});
