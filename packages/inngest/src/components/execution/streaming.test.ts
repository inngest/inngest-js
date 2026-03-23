import { describe, expect, test } from "vitest";
import {
  buildSseMetadataFrame,
  buildSseResultFrame,
  buildSseStepFrame,
  buildSseStreamFrame,
  iterSse,
  type SseFrame,
} from "./streaming.ts";

function bodyFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function collectFrames(
  body: ReadableStream<Uint8Array>,
): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];

  for await (const frame of iterSse(body)) {
    frames.push(frame);
  }

  return frames;
}

describe("iterSse", () => {
  test("parses known frame types and ignores unknown events", async () => {
    const body = bodyFromChunks([
      `event: unknown\ndata: {"x":1}\n\n`,
      buildSseMetadataFrame("run-1"),
      buildSseStreamFrame("hello", "step-1"),
      buildSseResultFrame({ done: true }),
    ]);

    const frames = await collectFrames(body);

    expect(frames).toEqual([
      { type: "inngest.metadata", run_id: "run-1" },
      { type: "stream", data: "hello", step_id: "step-1" },
      { type: "inngest.result", data: { done: true } },
    ]);
  });

  test("handles frames split across arbitrary chunk boundaries", async () => {
    const serialized = [
      buildSseMetadataFrame("run-2"),
      buildSseStepFrame("step-a", "running", { n: 1 }),
      buildSseStepFrame("step-a", "completed", { n: 2 }),
      buildSseResultFrame("done"),
    ].join("");

    const chunks: string[] = [];
    for (let i = 0; i < serialized.length; i += 3) {
      chunks.push(serialized.slice(i, i + 3));
    }

    const frames = await collectFrames(bodyFromChunks(chunks));

    expect(frames).toEqual([
      { type: "inngest.metadata", run_id: "run-2" },
      {
        type: "inngest.step",
        step_id: "step-a",
        status: "running",
        data: { n: 1 },
      },
      {
        type: "inngest.step",
        step_id: "step-a",
        status: "completed",
        data: { n: 2 },
      },
      { type: "inngest.result", data: "done" },
    ]);
  });

  test("supports multi-line data payloads", async () => {
    const body = bodyFromChunks([
      "event: inngest.result\n",
      "data: hello\n",
      "data: world\n\n",
    ]);

    const frames = await collectFrames(body);

    expect(frames).toEqual([{ type: "inngest.result", data: "hello\nworld" }]);
  });

  test("normalizes errored step frames", async () => {
    const body = bodyFromChunks([
      buildSseStepFrame("step-e", "errored", {
        will_retry: true,
        error: "boom",
      }),
    ]);

    const frames = await collectFrames(body);

    expect(frames).toEqual([
      {
        type: "inngest.step",
        step_id: "step-e",
        status: "errored",
        will_retry: true,
        error: "boom",
      },
    ]);
  });
});
