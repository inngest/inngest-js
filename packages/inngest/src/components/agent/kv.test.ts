/**
 * @module
 * Tests for the scoped KV, using the in-memory adapter.
 */
import { testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { runToEnd } from "../sandbox/test-helpers.ts";
import { createKv, kvHash, memoryKvAdapter } from "./kv.ts";

describe("kv", () => {
  test("each read and write is a memoized step and scopes are separate", async () => {
    const adapter = memoryKvAdapter();
    const kv = createKv({ adapter });
    const client = new Inngest({ id: testClientId });
    const out: unknown[] = [];

    const fn = client.createFunction(
      { id: "kvfn", triggers: [{ event: "kv/run" }] },
      async () => {
        await kv.set("a", 1);
        await kv.set("a", 2, { scope: "function" });
        const total = await kv.update<number>("n", (n) => (n ?? 0) + 5, {
          scope: "app",
        });
        out.push(
          await kv.get("a"),
          await kv.get("a", { scope: "function" }),
          total,
        );
        out.push(await kv.get("missing"));
        await kv.clearRun();
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
      "kv.clearRun",
      "kv.all:run",
    ]);
    expect(out.slice(-1)).toEqual([{}]);
  });

  test("session and thread scopes need those sessions", () => {
    expect(() => kvHash("thread", { env: "e", app: "a" })).toThrow(
      /no thread id/,
    );
    expect(kvHash("thread", { env: "e", app: "a", thread: "t1" })).toBe(
      "inngest:kv:thread:e:t1",
    );
    expect(kvHash("function", { env: "e", app: "a", function: "f" })).toBe(
      "inngest:kv:function:e:a:f",
    );
  });

  test("at() reads a scope instance directly, for thread handles", async () => {
    const adapter = memoryKvAdapter();
    const kv = createKv({ adapter });
    const ids = { env: "e", app: "a", thread: "t1" };

    await kv.at("thread", ids).set("plan", { steps: 2 });

    expect(await kv.at("thread", ids).get("plan")).toEqual({ steps: 2 });
    expect(await kv.at("thread", ids).all()).toEqual({ plan: { steps: 2 } });
  });
});
