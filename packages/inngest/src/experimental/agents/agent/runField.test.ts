/**
 * @module
 * Tests for the run-time fields: a value, or a pure, possibly async function
 * of `{ event, thread }`, evaluated once per run at its start.
 */
import { createRunFields } from "./runField.ts";

const context = {
  event: { name: "shop/order", data: { id: "o1" } },
  thread: { key: "t1" },
};

describe("run fields", () => {
  test("a value is returned as it is", async () => {
    const fields = createRunFields(context);

    expect(await fields.get("system", "be brief")).toBe("be brief");
    expect(await fields.get("limits", { depth: 2 })).toEqual({ depth: 2 });
  });

  test("a function gets the event and the thread, and an async one is awaited", async () => {
    const fields = createRunFields(context);

    expect(
      await fields.get("system", async ({ event, thread }) => {
        await Promise.resolve();

        return `${event.name} on ${thread.key}`;
      }),
    ).toBe("shop/order on t1");
  });

  test("a function runs once however often the field is read, and the result is reused", async () => {
    const fields = createRunFields(context);
    let calls = 0;
    const field = async () => {
      calls += 1;

      return { call: calls };
    };

    const first = await fields.get("budget", field);
    const second = await fields.get("budget", field);

    expect(calls).toBe(1);
    expect(second).toBe(first);
  });

  test("two fields do not share a result", async () => {
    const fields = createRunFields(context);

    expect(await fields.get("a", () => 1)).toBe(1);
    expect(await fields.get("b", () => 2)).toBe(2);
  });

  test("a function that throws fails every read of its field with the same error", async () => {
    const fields = createRunFields(context);
    const field = () => {
      throw new Error("lookup failed");
    };

    await expect(fields.get("system", field)).rejects.toThrow("lookup failed");
    await expect(fields.get("system", field)).rejects.toThrow("lookup failed");
  });
});
