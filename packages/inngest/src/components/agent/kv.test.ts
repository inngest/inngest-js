/**
 * @module
 * Tests for the scoped KV, using the in-memory adapter.
 */
import { testClientId } from "../../test/helpers.ts";
import { Inngest } from "../Inngest.ts";
import { runToEnd } from "../sandbox/test-helpers.ts";
import { startFakeRedis } from "./fake-redis.ts";
import {
  createKv,
  type KvAdapter,
  kvHash,
  memoryKvAdapter,
  redisKvAdapter,
} from "./kv.ts";
import { connectRedis } from "./redis.ts";
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
    expect(kvHash("thread", { env: "e", app: "a", thread: "t:1|{x}" })).toBe(
      "inngest:kv:thread:e:a:t%3A1%7C%7Bx%7D",
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

describe("kv ttl, setIfAbsent and sorted indexes", () => {
  /**
   * The same behaviour for every adapter. `advance` moves the clock the
   * adapter's expiry uses.
   */
  function contract(
    name: string,
    make: () => Promise<{
      adapter: KvAdapter;
      advance: (ms: number) => void;
      done: () => Promise<void>;
    }>,
  ) {
    describe(name, () => {
      test("ttl expires a key and set without ttl keeps it", async () => {
        const { adapter, advance, done } = await make();
        const kv = createKv({ adapter }).with({ id: "app", env: null });
        const env = kv.env;

        await env.set("stop", "k", { ttl: 10 });
        await env.set("plain", 1);
        expect(await env.get("stop")).toBe("k");
        expect(await env.all()).toEqual({ stop: "k", plain: 1 });

        advance(11_000);

        expect(await env.get("stop")).toBeUndefined();
        expect(await env.all()).toEqual({ plain: 1 });

        await env.set("stop", "k", { ttl: 10 });
        await env.set("stop", "forever");
        advance(60_000);
        expect(await env.get("stop")).toBe("forever");

        await expect(env.set("x", 1, { ttl: 0 })).rejects.toThrow(/ttl/);
        await done();
      });

      test("setIfAbsent claims once until expiry or delete", async () => {
        const { adapter, advance, done } = await make();
        const env = createKv({ adapter }).with({ id: "app", env: null }).env;

        expect(await env.setIfAbsent("card", "a", { ttl: 10 })).toBe(true);
        expect(await env.setIfAbsent("card", "b", { ttl: 10 })).toBe(false);
        expect(await env.get("card")).toBe("a");

        advance(11_000);
        expect(await env.setIfAbsent("card", "b", { ttl: 10 })).toBe(true);
        expect(await env.get("card")).toBe("b");

        await env.delete("card");
        expect(await env.get("card")).toBeUndefined();
        expect(await env.setIfAbsent("card", "c")).toBe(true);
        expect(await env.setIfAbsent("card", "d")).toBe(false);

        await env.set("plain", 1);
        expect(await env.setIfAbsent("plain", 2)).toBe(false);
        await done();
      });

      test("a retried setIfAbsent holds its own claim, others do not", async () => {
        const { adapter, done } = await make();
        const env = createKv({ adapter }).with({ id: "app", env: null }).env;

        expect(await env.setIfAbsent("a", "run-1", { ttl: 10 })).toBe(true);
        expect(await env.setIfAbsent("a", "run-1", { ttl: 10 })).toBe(true);
        expect(await env.setIfAbsent("a", "run-2", { ttl: 10 })).toBe(false);
        expect(await env.setIfAbsent("b", "run-1")).toBe(true);
        expect(await env.setIfAbsent("b", "run-1")).toBe(true);
        expect(await env.setIfAbsent("b", "run-2")).toBe(false);

        // Identical values cannot be told apart: give each caller its own token.
        expect(await env.setIfAbsent("c", "same")).toBe(true);
        expect(await env.setIfAbsent("c", "same")).toBe(true);
        await done();
      });

      test("ids with separators never share keys", async () => {
        const { adapter, done } = await make();
        const kv = createKv({ adapter }).with({ id: "app", env: null });
        const names = ["a", "a|b", "a:b", "a{b}", "a%3Ab"];

        for (const name of names) {
          const scope = kv.scope("thread", name);
          await scope.set("x", name, { ttl: 100 });
          await scope.index("i").add(name, 1);
        }
        for (const name of names) {
          const scope = kv.scope("thread", name);
          expect(await scope.all()).toEqual({ x: name });
          expect(await scope.index("i").range()).toEqual([
            { member: name, score: 1 },
          ]);
        }

        await kv.scope("thread", "a").clear();

        for (const name of names.slice(1)) {
          expect(await kv.scope("thread", name).all()).toEqual({ x: name });
        }
        await done();
      });

      test("an index ranges by score, filters, limits and removes", async () => {
        const { adapter, done } = await make();
        const kv = createKv({ adapter }).with({ id: "app", env: null });
        const index = kv.env.index("improve");

        await expect(index.add("x", Number.NaN)).rejects.toThrow(/finite/);
        await expect(index.range({ limit: -1 })).rejects.toThrow(/limit/);
        await expect(
          index.range({ order: "descending" as "desc" }),
        ).rejects.toThrow(/order/);
        await index.add("a", 10);
        await index.add("b", 30);
        await index.add("c", 20);
        await index.add("a", 40);

        const members = async (options = {}) => {
          return (await index.range(options)).map((e) => {
            return e.member;
          });
        };
        expect(await members()).toEqual(["c", "b", "a"]);
        expect(await members({ order: "desc", limit: 2 })).toEqual(["a", "b"]);
        expect(await members({ min: 25 })).toEqual(["b", "a"]);
        expect(await members({ max: 20 })).toEqual(["c"]);
        expect(await index.range({ max: 20 })).toEqual([
          { member: "c", score: 20 },
        ]);

        await index.remove("b");
        expect(await members()).toEqual(["c", "a"]);
        expect(await kv.scope("env", "other").index("improve").range()).toEqual(
          [],
        );

        await kv.env.clear();
        expect(await members()).toEqual([]);
        await done();
      });

      test("clear removes ttl keys and indexes too", async () => {
        const { adapter, done } = await make();
        const kv = createKv({ adapter }).with({ id: "app", env: null });
        const scope = kv.scope("thread", "t1");
        const other = kv.scope("thread", "t10");

        await scope.set("a", 1, { ttl: 100 });
        await scope.index("i").add("m", 1);
        await other.set("a", 2, { ttl: 100 });
        await other.index("i").add("m", 1);
        await scope.clear();

        expect(await scope.all()).toEqual({});
        expect(await scope.index("i").range()).toEqual([]);
        expect(await other.all()).toEqual({ a: 2 });
        expect(await other.index("i").range()).toHaveLength(1);
        await done();
      });
    });
  }

  contract("memory adapter", async () => {
    const real = Date.now;
    let offset = 0;
    Date.now = () => {
      return real() + offset;
    };

    return {
      adapter: memoryKvAdapter(),
      advance: (ms) => {
        offset += ms;
      },
      done: async () => {
        Date.now = real;
      },
    };
  });

  contract("redis adapter against the fake server", async () => {
    const server = await startFakeRedis();

    return {
      adapter: redisKvAdapter(server.url),
      advance: server.advance,
      done: server.close,
    };
  });

  test("the redis registry stays small and in one slot", async () => {
    const server = await startFakeRedis();
    const env = createKv({ adapter: redisKvAdapter(server.url) }).with({
      id: "app",
      env: null,
    }).env;
    const registry = () => {
      const key = server.keys().find((name) => {
        return name.endsWith("|keys");
      });

      return key === undefined ? [] : server.members(key);
    };

    await env.set("a", 1, { ttl: 10 });
    await env.setIfAbsent("c", "x", { ttl: 10 });
    await env.setIfAbsent("c", "y", { ttl: 10 });
    await env.setIfAbsent("plain", "x");
    await env.index("i").add("m", 1);
    expect(registry()).toEqual(["t:a", "t:c", "z:i"]);

    await env.delete("a");
    await env.index("i").remove("m");
    expect(registry()).toEqual(["t:c"]);

    // Entries expire by the server's clock, and writes prune them.
    server.advance(11_000);
    await env.set("b", 2, { ttl: 10 });
    expect(registry()).toEqual(["t:b"]);
    expect(await env.all()).toEqual({ plain: "x", b: 2 });

    // Every key shares the hash tag, so a cluster keeps them in one slot.
    for (const key of server.keys()) {
      expect(key).toMatch(/^\{inngest:kv:env:default\}/);
    }
    await server.close();
  });

  test("clear removes a large scope in batches", async () => {
    const server = await startFakeRedis();
    const env = createKv({ adapter: redisKvAdapter(server.url) }).with({
      id: "app",
      env: null,
    }).env;

    // Seeded in one burst of pipelined commands, as the adapter would leave it.
    const seed = await connectRedis(server.url);
    const hash = "{inngest:kv:env:default}";
    await Promise.all(
      Array.from({ length: 1200 }, (_, i) => {
        return Promise.all([
          seed.command("SET", `${hash}|t|k${i}`, "1", "EX", "100"),
          seed.command("ZADD", `${hash}|keys`, "+inf", `t:k${i}`),
        ]);
      }),
    );
    seed.close();
    expect(server.keys()).toHaveLength(1201);

    await env.clear();

    expect(server.keys()).toEqual([]);
    const deletes = server.commands.filter((c) => {
      return c[0] === "DEL";
    });
    expect(deletes.length).toBeGreaterThan(2);
    expect(Math.max(...deletes.map((c) => c.length))).toBeLessThanOrEqual(501);
    await server.close();
  });

  test("inside a function each operation is a memoized step", async () => {
    const kv = createKv({ adapter: memoryKvAdapter() });
    const client = new Inngest({ id: testClientId });
    const out: unknown[] = [];

    const fn = client.createFunction(
      { id: "kvops", triggers: [{ event: "kv/ops" }] },
      async () => {
        out.push(await kv.env.setIfAbsent("claim", "me", { ttl: 30 }));
        out.push(await kv.env.setIfAbsent("claim", "you", { ttl: 30 }));
        await kv.env.index("runs").add("r1", 5);
        out.push(await kv.env.index("runs").range());
        await kv.env.index("runs").remove("r1");
      },
    );

    const { type, ran } = await runToEnd(fn);

    expect(type).toBe("function-resolved");
    expect(ran).toEqual([
      "kv.setIfAbsent:env:claim",
      "kv.setIfAbsent:env:claim",
      "kv.index.add:env:runs:r1",
      "kv.index.range:env:runs",
      "kv.index.remove:env:runs:r1",
    ]);
    expect(out.slice(-3)).toEqual([true, false, [{ member: "r1", score: 5 }]]);
  });
});
