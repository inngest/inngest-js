import { describe, expect, test } from "vitest";
import { InngestStream } from "./InngestStreamTools.ts";

/**
 * Drain the readable side of an InngestStream into a string.
 */
async function drain(stream: InngestStream): Promise<string> {
  const reader = stream.readable.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(decoder.decode(value));
  }
  return parts.join("");
}

describe("InngestStream.pipe", () => {
  test("pipes a ReadableStream", async () => {
    const s = new InngestStream();
    const encoder = new TextEncoder();

    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("hello"));
        controller.enqueue(encoder.encode(" world"));
        controller.close();
      },
    });

    const resultPromise = s.pipe(readable);

    // Close after pipe completes
    resultPromise.then(() => s.close());

    const [result, raw] = await Promise.all([resultPromise, drain(s)]);

    expect(result).toBe("hello world");
    expect(raw).toContain("event: stream");
    expect(raw).toContain('"hello"');
    expect(raw).toContain('" world"');
  });

  test("pipes an AsyncIterable<string>", async () => {
    const s = new InngestStream();

    async function* gen() {
      yield "foo";
      yield "bar";
    }

    const resultPromise = s.pipe(gen());
    resultPromise.then(() => s.close());

    const [result, raw] = await Promise.all([resultPromise, drain(s)]);

    expect(result).toBe("foobar");
    expect(raw).toContain('"foo"');
    expect(raw).toContain('"bar"');
  });

  test("pipes a generator factory function", async () => {
    const s = new InngestStream();

    const resultPromise = s.pipe(async function* () {
      yield "a";
      yield "b";
      yield "c";
    });
    resultPromise.then(() => s.close());

    const [result, raw] = await Promise.all([resultPromise, drain(s)]);

    expect(result).toBe("abc");
    expect(raw).toContain('"a"');
    expect(raw).toContain('"b"');
    expect(raw).toContain('"c"');
  });
});

describe("InngestStream.stepLifecycle", () => {
  test("emits step lifecycle frames", async () => {
    const s = new InngestStream();

    s.stepLifecycle("my-step", "running");
    s.stepLifecycle("my-step", "completed");
    s.stepLifecycle("my-step", "errored", {
      will_retry: true,
      error: "boom",
      attempt: 0,
    });
    s.end();

    const raw = await drain(s);

    expect(raw).toContain("event: inngest.step");
    expect(raw).toContain('"status":"running"');
    expect(raw).toContain('"status":"completed"');
    expect(raw).toContain('"status":"errored"');
    expect(raw).toContain('"will_retry":true');
  });
});
