import { afterEach, describe, expect, test, vi } from "vitest";
import { Stream } from "./StreamTools.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function trackTransformStreamConstruction() {
  const OriginalTransformStream = globalThis.TransformStream;
  const constructed = vi.fn();

  class TrackedTransformStream extends OriginalTransformStream {
    constructor(
      ...args: ConstructorParameters<typeof OriginalTransformStream>
    ) {
      constructed();
      super(...args);
    }
  }

  vi.stubGlobal("TransformStream", TrackedTransformStream);
  return constructed;
}

async function drain(s: Stream): Promise<string> {
  const reader = s.readable.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

describe("Stream lifecycle", () => {
  test("creates the underlying stream only when readable is accessed", async () => {
    const transformStream = trackTransformStreamConstruction();
    const s = new Stream();

    s.end();

    expect(transformStream).not.toHaveBeenCalled();
    await expect(drain(s)).resolves.toBe("");
    expect(transformStream).toHaveBeenCalledTimes(1);
  });

  test("delivers a terminal event when readable is accessed after close", async () => {
    const transformStream = trackTransformStreamConstruction();
    const s = new Stream();

    s.closeSucceeded({
      body: '"done"',
      statusCode: 200,
      headers: { "content-type": "application/json" },
    });

    expect(transformStream).not.toHaveBeenCalled();
    const raw = await drain(s);

    expect(transformStream).toHaveBeenCalledTimes(1);
    expect(raw).toContain("event: inngest.response");
    expect(raw).toContain('"status":"succeeded"');
    expect(raw).toContain('"body":"\\"done\\""');
  });
});

describe("Stream.push", () => {
  test("writes SSE stream events", async () => {
    const transformStream = trackTransformStreamConstruction();
    const s = new Stream();

    s.push("hello");
    s.push("world");
    s.end();

    expect(transformStream).toHaveBeenCalledTimes(1);
    const raw = await drain(s);

    expect(transformStream).toHaveBeenCalledTimes(1);
    expect(raw).toContain("event: inngest.stream");
    expect(raw).toContain('"hello"');
    expect(raw).toContain('"world"');
  });
});

describe("Stream.pipe", () => {
  test("pipes async generator chunks as SSE events", async () => {
    const s = new Stream();

    const result = await s.pipe(async function* () {
      yield "a";
      yield "b";
      yield "c";
    });
    s.end();

    const raw = await drain(s);

    expect(result).toBe("abc");
    expect(raw).toContain('"a"');
    expect(raw).toContain('"b"');
    expect(raw).toContain('"c"');
  });
});

describe("Stream.commit / rollback", () => {
  test("emits commit and rollback events", async () => {
    const s = new Stream();

    s.commit("step-a");
    s.rollback("step-b");
    s.end();

    const raw = await drain(s);

    expect(raw).toContain("event: inngest.commit");
    expect(raw).toContain('"hashedStepId":"step-a"');
    expect(raw).toContain("event: inngest.rollback");
    expect(raw).toContain('"hashedStepId":"step-b"');
  });
});
