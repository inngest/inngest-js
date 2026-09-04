import { describe, expect, test } from "vitest";
import { iterSse, type RawSseEvent } from "./streaming.ts";

/**
 * Build a `ReadableStream<Uint8Array>` from one or more string chunks, so a
 * single logical SSE payload can be split across `reader.read()` boundaries.
 */
const streamOf = (...chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
};

const collect = async (
  body: ReadableStream<Uint8Array>,
): Promise<RawSseEvent[]> => {
  const out: RawSseEvent[] = [];
  for await (const event of iterSse(body)) {
    out.push(event);
  }
  return out;
};

describe("iterSse", () => {
  test("parses a canonical `\\n` + space payload", async () => {
    const events = await collect(
      streamOf('event: inngest.response\ndata: {"ok":1}\n\n'),
    );
    expect(events).toEqual([{ event: "inngest.response", data: '{"ok":1}' }]);
  });

  test("parses CRLF (`\\r\\n`) line endings", async () => {
    const events = await collect(
      streamOf('event: inngest.response\r\ndata: {"ok":1}\r\n\r\n'),
    );
    expect(events).toEqual([{ event: "inngest.response", data: '{"ok":1}' }]);
  });

  test("parses fields with no space after the colon", async () => {
    const events = await collect(
      streamOf('event:inngest.response\ndata:{"ok":1}\n\n'),
    );
    expect(events).toEqual([{ event: "inngest.response", data: '{"ok":1}' }]);
  });

  test("joins multiple data lines with a newline", async () => {
    const events = await collect(
      streamOf("event: inngest.stream\ndata: line one\ndata: line two\n\n"),
    );
    expect(events).toEqual([
      { event: "inngest.stream", data: "line one\nline two" },
    ]);
  });

  test("ignores comment lines and defaults the event to `message`", async () => {
    const events = await collect(streamOf(": keep-alive\ndata: hello\n\n"));
    expect(events).toEqual([{ event: "message", data: "hello" }]);
  });

  test("reassembles an event split across read boundaries", async () => {
    const events = await collect(
      streamOf("event: inngest.response\nda", 'ta: {"ok":1}\n\n'),
    );
    expect(events).toEqual([{ event: "inngest.response", data: '{"ok":1}' }]);
  });
});
