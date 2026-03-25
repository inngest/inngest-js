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
  getStreamData,
  pollForAsyncReader,
  readSseStream,
  setupEndpoint,
} from "./helpers.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

const streamingMethods = ["push", "pipe-generator", "pipe-stream"] as const;

async function streamWith(
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

test.each(streamingMethods)(
  "streams sync data then redirects for async data (%s)",
  async (method) => {
    const state = createState({});
    const { port } = await setupEndpoint(testFileName, async () => {
      await step.run("sync", async () => {
        await streamWith(method, "sync-data");
      });
      await step.sleep("go-async", "1s");
      await step.run("async", async () => {
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

    const { events, redirectUrl } = await readSseStream(res);
    const streamData = getStreamData(events);
    expect(streamData).toContain("sync-data");

    // Metadata present
    const meta = events.filter((e) => e.event === "inngest.metadata");
    expect(meta.length).toBe(1);
    state.runId = JSON.parse(meta[0]!.data).runId;

    // Redirect info tells client where to reconnect
    expect(redirectUrl).toBeTruthy();

    // Follow redirect for async streaming
    const asyncReader = await pollForAsyncReader(redirectUrl!);
    await asyncReader.done;
    const asyncStreamData = getStreamData(asyncReader.events);
    expect(asyncStreamData).toContain("async-data");

    // Return value
    const results = asyncReader.events.filter(
      (e) => e.event === "inngest.result",
    );
    expect(results.length).toBe(1);
    expect(JSON.parse(results[0]!.data)).toEqual({
      status: "succeeded",
      data: '"done"',
    });

    await state.waitForRunComplete();
  },
);

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
