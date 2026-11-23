import { Realtime } from "./types.ts";

describe("realtime message payloads", () => {
  test.each([
    { name: "null", data: null },
    { name: "false", data: false },
    { name: "zero", data: 0 },
    { name: "empty string", data: "" },
    { name: "nested null", data: { value: null } },
    { name: "array containing null", data: [null] },
  ])("preserves $name", async ({ data }) => {
    const message = await Realtime.messageSchema.parseAsync({
      kind: "data",
      channel: "test",
      topic: "status",
      data,
    });
    expect(message).toHaveProperty("data", data);
  });

  test("keeps an undefined data property when the payload is omitted", async () => {
    const message = await Realtime.messageSchema.parseAsync({ kind: "ping" });
    expect(message).toHaveProperty("data", undefined);
  });
});
