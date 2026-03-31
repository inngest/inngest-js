/*
 * This test file is for Durable Endpoints that:
 * - Do not go into async mode
 * - Stream data
 */

import { createState, testNameFromFileUrl } from "@inngest/test-harness";
import { describe, expect, test } from "vitest";
import { InngestStream } from "../../../components/InngestStreamTools.ts";
import { stream } from "../../../experimental/durable-endpoints.ts";
import { NonRetriableError, step } from "../../../index.ts";

import {
  getStreamData,
  readSseStream,
  setupEndpoint,
  streamingMethods,
  streamWith,
  urlWithTestName,
} from "./helpers.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test.concurrent.each(streamingMethods)(
  "push streams data across steps (%s)",
  async (method) => {
    const state = createState({});
    const { port, waitForRunId } = await setupEndpoint(
      testFileName,
      async () => {
        await step.run("a", async () => {
          await streamWith(method, "from a");
        });
        await step.run("b", async () => {
          await streamWith(method, "from b");
        });
        return Response.json("done");
      },
    );

    const res = await fetch(urlWithTestName(`http://localhost:${port}`), {
      headers: { Accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    state.runId = await waitForRunId();

    const { events } = await readSseStream(res);
    expect(events).toEqual([
      {
        event: "inngest.metadata",
        data: expect.any(String),
      },
      {
        event: "inngest.stream",
        data: '{"data":"from a","hashedStepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"}',
      },
      {
        event: "inngest.commit",
        data: '{"hashedStepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"}',
      },
      {
        event: "inngest.redirect_info",
        data: expect.any(String),
      },
      {
        event: "inngest.stream",
        data: '{"data":"from b","hashedStepId":"e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98"}',
      },
      {
        event: "inngest.commit",
        data: '{"hashedStepId":"e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98"}',
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
  },
);

test("no explicit streaming", async () => {
  // If a client sets a streaming "Accept" header, still stream the response
  // even if the user code didn't explicitly stream (e.g. `stream.push()`). This
  // is necessary because the endpoint may stream *after* going into async mode,
  // and the client needs the redirect info (which comes via an SSE event)

  const state = createState({});
  const { port, waitForRunId } = await setupEndpoint(testFileName, async () => {
    await step.run("a", async () => {});
    await step.run("b", async () => {});
    return Response.json("done");
  });

  const res = await fetch(urlWithTestName(`http://localhost:${port}`), {
    headers: { Accept: "text/event-stream" },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  state.runId = await waitForRunId();

  const { events } = await readSseStream(res);
  expect(events).toEqual([
    {
      event: "inngest.metadata",
      data: expect.any(String),
    },
    {
      event: "inngest.commit",
      data: '{"hashedStepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"}',
    },
    {
      event: "inngest.redirect_info",
      data: expect.any(String),
    },
    {
      event: "inngest.commit",
      data: '{"hashedStepId":"e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98"}',
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

test("NonRetriableError", async () => {
  // Test `NonRetriableError` instead of a regular error because retries puts us
  // into async mode.

  const state = createState({});
  const { port, waitForRunId } = await setupEndpoint(testFileName, async () => {
    await step.run("a", async () => {
      stream.push("partial");
      throw new NonRetriableError("boom");
    });
    return Response.json("unreachable");
  });

  const res = await fetch(urlWithTestName(`http://localhost:${port}`), {
    headers: { Accept: "text/event-stream" },
  });
  expect(res.status).toBe(200);
  state.runId = await waitForRunId();

  const { events } = await readSseStream(res);
  expect(events).toEqual([
    {
      event: "inngest.metadata",
      data: expect.any(String),
    },
    {
      event: "inngest.stream",
      data: '{"data":"partial","hashedStepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"}',
    },
    {
      event: "inngest.rollback",
      data: '{"hashedStepId":"86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"}',
    },
    {
      event: "inngest.redirect_info",
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

test("stream.pipe decodes multi-byte UTF-8 characters split across chunks", async () => {
  const state = createState({});

  const original = "Hello \u{1F389} World";
  // UTF-8 encoding of "Hello 🎉 World":
  //   H  e  l  l  o     F0 9F 8E 89     W  o  r  l  d
  //   0  1  2  3  4  5  6  7  8  9  10  11 12 13 14 15
  //
  // Splitting at offset 8 cuts the 4-byte emoji (bytes 6-9) across two chunks:
  //   chunk1: bytes 0..7  -> "Hello " + 0xF0 0x9F (incomplete emoji)
  //   chunk2: bytes 8..15 -> 0x8E 0x89 (rest of emoji) + " World"
  const encoded = new TextEncoder().encode(original);
  const splitOffset = 8;
  const chunk1 = encoded.slice(0, splitOffset);
  const chunk2 = encoded.slice(splitOffset);

  const { port, waitForRunId } = await setupEndpoint(testFileName, async () => {
    const pipeResult = await step.run("pipe-utf8", async () => {
      const readable = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk1);
          controller.enqueue(chunk2);
          controller.close();
        },
      });

      return await stream.pipe(readable);
    });

    return Response.json(pipeResult);
  });

  const res = await fetch(urlWithTestName(`http://localhost:${port}`), {
    headers: { Accept: "text/event-stream" },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  state.runId = await waitForRunId();

  const { events } = await readSseStream(res);

  const streamData = getStreamData(events);
  const joined = streamData.join("");

  expect(joined).toBe(original);
  expect(joined).not.toContain("\uFFFD");

  await state.waitForRunComplete();
});

describe("pipeIterable stops consuming the source when the reader cancels", () => {
  const TOTAL_CHUNKS = 50;
  const CHUNK_DELAY_MS = 20;
  const CHUNKS_TO_READ = 5;
  const SETTLE_MS = 1500;
  const MAX_EXPECTED_CHUNKS = 20;

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  test("generator yields fewer chunks than total when reader cancels early", async () => {
    let chunksYielded = 0;

    async function* slowSource(): AsyncGenerator<string> {
      for (let i = 0; i < TOTAL_CHUNKS; i++) {
        chunksYielded++;
        yield `chunk-${i}`;
        await delay(CHUNK_DELAY_MS);
      }
    }

    const inngestStream = new InngestStream();

    const pipePromise = inngestStream.pipe(slowSource);

    const reader = inngestStream.readable.getReader();
    for (let i = 0; i < CHUNKS_TO_READ; i++) {
      const { done } = await reader.read();
      if (done) break;
    }

    await reader.cancel();

    // Wait long enough for the generator to finish if the bug is present.
    // 50 chunks * 20ms = 1000ms, so 1500ms is plenty.
    await delay(SETTLE_MS);

    expect(chunksYielded).toBeLessThan(MAX_EXPECTED_CHUNKS);

    pipePromise.catch(() => {});
  });
});
