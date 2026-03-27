import { describe, expect, test } from "vitest";
import { InngestStream } from "./InngestStreamTools.ts";

async function drain(s: InngestStream): Promise<string> {
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

describe("InngestStream.push", () => {
  test("writes SSE stream events", async () => {
    const s = new InngestStream();

    s.push("hello");
    s.push("world");
    s.end();

    const raw = await drain(s);

    expect(raw).toContain("event: inngest.stream");
    expect(raw).toContain('"hello"');
    expect(raw).toContain('"world"');
  });
});

describe("InngestStream.pipe", () => {
  test("pipes async generator chunks as SSE events", async () => {
    const s = new InngestStream();

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

describe("InngestStream.commit / rollback", () => {
  test("emits commit and rollback events", async () => {
    const s = new InngestStream();

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
