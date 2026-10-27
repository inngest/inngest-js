/**
 * @module
 * Tests for the scoped KV, using the in-memory adapter.
 */
import { testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { runToEnd } from "../sandbox/test-helpers.ts";
import { createKv, kvHash, memoryKvAdapter } from "./kv.ts";
import { run } from "./test-helpers.ts";

describe("kv", () => {
  test("each call is a memoized step and the scope is chosen up front", async () => {
    const adapter = memoryKvAdapter();
    const kv = createKv({ adapter });
    const client = new Inngest({ id: testClientId });
    const out: unknown[] = [];

    const fn = client.createFunction(
      { id: "kvfn", triggers: [{ event: "kv/run" }] },
      async () => {
        await kv.set("a", 1);
        await kv.function.set("a", 2);
        const total = await kv.app.update<number>("n", function (n) {
          return (n ?? 0) + 5;
        });
        out.push(await kv.get("a"), await kv.function.get("a"), total);
        out.push(await kv.get("missing"));
        out.push(await kv.take("a"), await kv.get("a"));
        await kv.run.clear();
        out.push(await kv.all());
      },
    );

    const { type, ran } = await runToEnd(fn);

    expect(type).toBe("function-resolved");
    expect(ran).toEqual([
      "kv.set:run:a",
      "kv.set:function:a",
      "kv.update:app:n",
      "kv.get:run:a",
      "kv.get:function:a",
      "kv.get:run:missing",
      "kv.take:run:a",
      "kv.get:run:a",
      "kv.clear:run",
      "kv.all:run",
    ]);
    expect(out.slice(-7)).toEqual([1, 2, 5, undefined, 1, undefined, {}]);
  });

  test("the current thread is found from the trigger event", async () => {
    const adapter = memoryKvAdapter();
    const kv = createKv({ adapter });
    const client = new Inngest({ id: testClientId });
    const out: unknown[] = [];

    const fn = client.createFunction(
      { id: "kvfn", triggers: [{ event: "agent/message" }] },
      async () => {
        await kv.thread.set("plan", [1]);
        out.push(await kv.scope("thread", "t1").get("plan"));
      },
    );

    await run(fn, { event: { name: "agent/message", data: { thread: "t1" } } });

    expect(out.slice(-1)).toEqual([[1]]);
    expect(
      await kv
        .with({ id: testClientId, env: null })
        .scope("thread", "t1")
        .get("plan"),
    ).toEqual([1]);
  });

  test("session and thread scopes need those ids", () => {
    expect(function () {
      return kvHash("thread", { env: "e", app: "a" });
    }).toThrow(/no thread id/);
    expect(kvHash("thread", { env: "e", app: "a", thread: "t1" })).toBe(
      "inngest:kv:thread:e:a:t1",
    );
    expect(kvHash("function", { env: "e", app: "a", function: "f" })).toBe(
      "inngest:kv:function:e:a:f",
    );
  });

  test("outside a function it needs a client and goes straight to the store", async () => {
    const adapter = memoryKvAdapter();
    const kv = createKv({ adapter });

    await expect(kv.thread.get("plan")).rejects.toThrow(/kv.with\(client\)/);

    const bound = kv.with({ id: "app", env: null });
    await bound.scope("thread", "t1").set("plan", { steps: 2 });

    expect(await bound.scope("thread", "t1").get("plan")).toEqual({ steps: 2 });
    expect(await bound.scope("thread", "t1").all()).toEqual({
      plan: { steps: 2 },
    });
    expect(await bound.scope("thread", "t2").all()).toEqual({});
  });
});
