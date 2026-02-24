import { StreamFanout } from "./StreamFanout.ts";

describe("StreamFanout", () => {
  test("starts with zero subscribers", () => {
    const fanout = new StreamFanout<string>();
    expect(fanout.size()).toBe(0);
  });

  test("createStream increments subscriber count", () => {
    const fanout = new StreamFanout<string>();
    fanout.createStream();
    expect(fanout.size()).toBe(1);

    fanout.createStream();
    expect(fanout.size()).toBe(2);
  });

  test("broadcasts a chunk to all subscribers", async () => {
    const fanout = new StreamFanout<string>();
    const stream1 = fanout.createStream();
    const stream2 = fanout.createStream();

    const reader1 = stream1.getReader();
    const reader2 = stream2.getReader();

    fanout.write("hello");

    const [result1, result2] = await Promise.all([
      reader1.read(),
      reader2.read(),
    ]);

    expect(result1.value).toBe("hello");
    expect(result2.value).toBe("hello");
  });

  test("supports transform functions per stream", async () => {
    const fanout = new StreamFanout<{ text: string }>();
    const stream = fanout.createStream((chunk) => chunk.text.toUpperCase());
    const reader = stream.getReader();

    fanout.write({ text: "hello" });

    const result = await reader.read();
    expect(result.value).toBe("HELLO");
  });

  test("close terminates all streams", async () => {
    const fanout = new StreamFanout<string>();
    const stream = fanout.createStream();
    const reader = stream.getReader();

    fanout.close();

    const result = await reader.read();
    expect(result.done).toBe(true);
    expect(fanout.size()).toBe(0);
  });

  test("delivers multiple chunks in order", async () => {
    const fanout = new StreamFanout<number>();
    const stream = fanout.createStream();
    const reader = stream.getReader();

    fanout.write(1);
    fanout.write(2);
    fanout.write(3);

    const results = await Promise.all([
      reader.read(),
      reader.read(),
      reader.read(),
    ]);

    expect(results.map((r) => r.value)).toEqual([1, 2, 3]);
  });

  test("new subscribers only receive future chunks", async () => {
    const fanout = new StreamFanout<string>();

    fanout.write("before");

    const stream = fanout.createStream();
    const reader = stream.getReader();

    fanout.write("after");

    const result = await reader.read();
    expect(result.value).toBe("after");
  });

  test("handles mixed typed streams with identity transform", async () => {
    const fanout = new StreamFanout<{ id: number; name: string }>();

    const jsonStream = fanout.createStream();
    const nameStream = fanout.createStream((chunk) => chunk.name);

    const jsonReader = jsonStream.getReader();
    const nameReader = nameStream.getReader();

    fanout.write({ id: 1, name: "test" });

    const [jsonResult, nameResult] = await Promise.all([
      jsonReader.read(),
      nameReader.read(),
    ]);

    expect(jsonResult.value).toEqual({ id: 1, name: "test" });
    expect(nameResult.value).toBe("test");
  });
});
