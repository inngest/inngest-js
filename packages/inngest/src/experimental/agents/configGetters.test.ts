/**
 * @module
 * Tests for the config pieces that take a function for what a Worker only has
 * per request: a KV.
 */
import { Inngest } from "../../components/Inngest.ts";
import { createKv, kv, kvFrom, memoryKvAdapter } from "./kv.ts";
import { getThread } from "./thread.ts";

describe("kvFrom", () => {
  test("a function is called at each use and every member follows it", async () => {
    const first = createKv({ adapter: memoryKvAdapter() });
    const second = createKv({ adapter: memoryKvAdapter() });
    let current = first;
    let calls = 0;
    const client = new Inngest({ id: "getter-app" });
    const lazy = kvFrom(() => {
      calls++;

      return current;
    });

    await lazy.with(client).env.set("k", 1);
    expect(await first.with(client).env.get("k")).toBe(1);

    current = second;
    await lazy.with(client).env.set("k", 2);

    expect(await first.with(client).env.get("k")).toBe(1);
    expect(await second.with(client).env.get("k")).toBe(2);
    expect(calls).toBe(2);
  });

  test("a value is returned as it is, and nothing is the default kv", () => {
    const own = createKv({ adapter: memoryKvAdapter() });

    expect(kvFrom(own)).toBe(own);
    expect(kvFrom(undefined)).toBe(kv);
  });

  test("a thread handle reads the thread state through a kv function", async () => {
    const mine = createKv({ adapter: memoryKvAdapter() });
    const client = new Inngest({ id: "getter-thread" });
    let asked = 0;

    await mine.with(client).scope("thread", "t1").set("note", "hello");
    const thread = getThread(client, "getter-thread/agent", "t1", {
      kv: () => {
        asked++;

        return mine;
      },
    });

    const state = await thread.state();

    expect(state.keys.note).toBe("hello");
    expect(asked).toBeGreaterThan(0);
  });
});
