/**
 * @module
 * Tests for the scoped KV, using the in-memory adapter.
 */
import { z } from "zod/v4";
import { runFnWithStack, testClientId } from "../../test/helpers.ts";
import { StepOpCode } from "../../types.ts";
import { Inngest } from "../Inngest.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import { NonRetriableError } from "../NonRetriableError.ts";
import { runToEnd } from "../sandbox/test-helpers.ts";
import { fakeD1 } from "./fake-d1.ts";
import { startFakeRedis } from "./fake-redis.ts";
import {
  createKv,
  type KvAdapter,
  kvHash,
  kvKey,
  memoryKvAdapter,
  redisKvAdapter,
} from "./kv.ts";
import { d1KvAdapter } from "./kvD1.ts";
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
        const total = await kv.app.update(kvKey<number>("n"), function (n) {
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
      "kv.get:run:a:1",
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

      test("compareAndSet writes only over the value it expects", async () => {
        const { adapter, advance, done } = await make();

        expect(await adapter.compareAndSet("h", "k", null, "1")).toBe(true);
        expect(await adapter.compareAndSet("h", "k", null, "2")).toBe(false);
        expect(await adapter.compareAndSet("h", "k", "9", "2")).toBe(false);
        expect(await adapter.compareAndSet("h", "k", "1", "2")).toBe(true);
        expect(await adapter.get("h", "k")).toBe("2");

        // A key past its ttl is absent, and the new value never expires.
        await adapter.set("h", "t", "old", 10);
        advance(11_000);
        expect(await adapter.compareAndSet("h", "t", "old", "x")).toBe(false);
        expect(await adapter.compareAndSet("h", "t", null, "new")).toBe(true);
        advance(1_000_000);
        expect(await adapter.get("h", "t")).toBe("new");

        // A value written with a ttl is compared and replaced in either form.
        await adapter.set("h", "u", "ttl", 100);
        expect(await adapter.compareAndSet("h", "u", "ttl", "plain")).toBe(
          true,
        );
        expect(await adapter.get("h", "u")).toBe("plain");
        await done();
      });

      test("concurrent updates of one key lose none", async () => {
        const { adapter, done } = await make();
        const counter = createKv({ adapter }).with({
          id: "app",
          env: null,
        }).env;
        const key = kvKey<number>("count");
        let calls = 0;

        await Promise.all(
          Array.from({ length: 20 }, () => {
            return counter.update(key, (n) => {
              calls++;

              return (n ?? 0) + 1;
            });
          }),
        );

        expect(await counter.get(key)).toBe(20);
        // The function runs again for each update that lost a race.
        expect(calls).toBeGreaterThanOrEqual(20);
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

  contract("d1 adapter on SQLite", async () => {
    let clock = 1_700_000_000_000;

    return {
      adapter: d1KvAdapter(await fakeD1(() => clock), { createTables: true }),
      advance: (ms) => {
        clock += ms;
      },
      done: async () => {},
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
    // 1200 keys in batches of 500, then the registry and the rest.
    const sizes = deletes.map((c) => {
      return c.length - 1;
    });

    expect(sizes.slice(0, 2)).toEqual([500, 500]);
    expect(Math.max(...sizes)).toBe(500);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(1202);
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
      "kv.setIfAbsent:env:claim:1",
      "kv.index.add:env:runs:r1",
      "kv.index.range:env:runs",
      "kv.index.remove:env:runs:r1",
    ]);
    expect(out.slice(-3)).toEqual([true, false, [{ member: "r1", score: 5 }]]);
  });
});

describe("kv typed keys", () => {
  test("a schema key validates on read and a plain name gives unknown", async () => {
    const kv = createKv({ adapter: memoryKvAdapter() }).with({
      id: "app",
      env: null,
    }).env;
    const plan = kvKey("plan", z.object({ steps: z.number() }));

    await kv.set(plan, { steps: 3 });
    const found = await kv.get(plan);
    expectTypeOf(found).toEqualTypeOf<{ steps: number } | undefined>();
    expect(found).toEqual({ steps: 3 });

    // A value written under the plain name that breaks the schema is refused,
    // with an error naming the key.
    await kv.set("plan", { steps: "three" });
    await expect(kv.get(plan)).rejects.toThrow(
      /kv key "plan".*fails its schema/,
    );
    const loose = await kv.get("plan");
    expectTypeOf(loose).toEqualTypeOf<unknown>();
    expect(loose).toEqual({ steps: "three" });

    await expect(kv.take(plan)).rejects.toThrow(/kv key "plan"/);
    // A refused take leaves the value in place.
    expect(await kv.get("plan")).toEqual({ steps: "three" });

    // @ts-expect-error the value must match the key's type
    await kv.set(plan, { steps: "no" });
    expect(await kv.get(kvKey("missing", z.string()))).toBeUndefined();
  });

  test("null is a value, a transform is refused, and keys work in a function", async () => {
    const adapter = memoryKvAdapter();
    const kv = createKv({ adapter });
    const maybe = kvKey("maybe", z.string().nullable());
    const bound = kv.with({ id: testClientId, env: null }).env;

    await bound.set(maybe, null);
    expect(await bound.get(maybe)).toBeNull();
    expect(
      await bound.get(kvKey("gone", z.string().nullable())),
    ).toBeUndefined();

    // @ts-expect-error a transform makes the stored and read types differ
    kvKey("when", z.string().transform(Number));
    // @ts-expect-error coercion makes the input wider than the output
    kvKey("co", z.coerce.number());
    // @ts-expect-error a Date is not JSON
    kvKey("dt", z.date());
    // @ts-expect-error a type holding a Date is refused when the key is used
    await bound.set(kvKey<{ at: Date }>("d"), { at: new Date() });
    // These pass: readonly data, branded primitives, optional and undefined properties.
    await bound.set("ro", ["a"] as readonly string[]);
    const branded = kvKey<{ id: string & { __brand: "id" }; note?: string }>(
      "b",
    );
    await bound.set(branded, { id: "x" as string & { __brand: "id" } });
    await bound.set(kvKey<{ a: string | undefined }>("u2"), { a: undefined });
    await bound.set(kvKey<readonly string[]>("ro2"), ["a"]);
    interface Shape {
      a: string;
    }
    const shape: Shape = { a: "x" };
    await bound.set("iface", shape);
    await bound.set("list", [shape]);
    // @ts-expect-error undefined in an array is not JSON
    await bound.set("holes", [undefined, "a"]);
    // @ts-expect-error a function is not JSON
    await bound.set("fn", () => 1);
    // @ts-expect-error a default makes the input wider than the output
    kvKey("dflt", z.string().default("x"));
    // @ts-expect-error undefined is not JSON
    await expect(bound.set("u", undefined)).rejects.toThrow(/undefined/);

    const client = new Inngest({ id: testClientId });
    const out: unknown[] = [];
    const fn = client.createFunction(
      { id: "kvtyped", triggers: [{ event: "kv/typed" }] },
      async () => {
        const count = kvKey("count", z.number());
        await kv.env.set(count, 2);
        out.push(await kv.env.get(count), await kv.env.take(count));
        out.push(await kv.env.get(count));

        // Refused before the step, so it fails at once instead of retrying.
        out.push(
          // @ts-expect-error undefined is not JSON
          await kv.env.set("u", undefined).catch((error: Error) => {
            return error.message;
          }),
        );

        const nullable = kvKey("n", z.string().nullable());
        await kv.env.set(nullable, null);
        out.push(await kv.env.get(nullable), await kv.env.take(nullable));
        out.push(await kv.env.get(nullable));

        await kv.env.set("bad", "text");
        const bad = kvKey("bad", z.number());
        const refused = await kv.env.take(bad).catch((error: Error) => {
          return error.message;
        });
        out.push(refused, await kv.env.get("bad"));
      },
    );
    const { type, ran } = await runToEnd(fn);

    expect(type).toBe("function-resolved");
    expect(ran).not.toContain("kv.set:env:u");
    expect(out.slice(-9)).toEqual([
      2,
      2,
      undefined,
      expect.stringContaining("undefined"),
      null,
      null,
      undefined,
      expect.stringContaining('kv key "bad"'),
      "text",
    ]);
  });

  test("update gets the validated current value and a key without a schema is trusted", async () => {
    const kv = createKv({ adapter: memoryKvAdapter() }).with({
      id: "app",
      env: null,
    }).env;
    const turns = kvKey<string[]>("turns");
    const count = kvKey("count", z.number());

    await kv.update(turns, (found) => {
      return [...(found ?? []), "a"];
    });
    expect(
      await kv.update(turns, (found) => {
        return [...(found ?? []), "b"];
      }),
    ).toEqual(["a", "b"]);

    await kv.set("count", "oops");
    await expect(kv.update(count, (n) => (n ?? 0) + 1)).rejects.toThrow(
      /kv key "count"/,
    );
  });
});

describe("kv replay of legacy read memos", () => {
  /**
   * Runs `fn` to the end, but memoizes every `get` and `take` step in the
   * shape older versions returned: `null` for no value, the raw value
   * otherwise.
   */
  async function runWithLegacyReads(fn: InngestFunction.Any) {
    let stepState: Parameters<typeof runFnWithStack>[1] = {};

    for (let request = 0; request < 20; request++) {
      const result = await runFnWithStack(fn, stepState);
      if (result.type === "function-resolved") {
        return result.data;
      }

      const steps =
        result.type === "step-ran"
          ? [result.step]
          : result.type === "steps-found"
            ? result.steps
            : [];
      for (const step of steps) {
        if (
          step.op === StepOpCode.DeferAdd ||
          step.op === StepOpCode.DeferAbort
        ) {
          continue;
        }

        const name = step.userland?.id ?? "";
        const data = step.data as { found?: boolean; value?: unknown } | null;
        const legacy =
          (name.startsWith("kv.get:") || name.startsWith("kv.take:")) && data
            ? data.found
              ? data.value
              : null
            : step.data;
        stepState = {
          ...stepState,
          [step.id]: { id: step.id, data: legacy },
        };
      }
    }

    throw new Error("The function did not finish");
  }

  test("a memo that is null, a raw value or an object with a found key still reads", async () => {
    const kv = createKv({ adapter: memoryKvAdapter() });
    const client = new Inngest({ id: testClientId });
    const fn = client.createFunction(
      { id: "kvlegacy", triggers: [{ event: "kv/legacy" }] },
      async () => {
        await kv.env.set("plain", { n: 1 });
        await kv.env.set("lookalike", { found: false });
        await kv.env.set("text", "hello");
        await kv.env.set("list", [1, 2]);

        return {
          plain: await kv.env.get("plain"),
          lookalike: await kv.env.get("lookalike"),
          missing: (await kv.env.get("missing")) ?? "none",
          taken: await kv.env.take("text"),
          after: (await kv.env.get("text")) ?? "none",
          list: await kv.env.get(kvKey("list", z.array(z.number()))),
        };
      },
    );

    expect(await runWithLegacyReads(fn)).toEqual({
      plain: { n: 1 },
      lookalike: { found: false },
      missing: "none",
      taken: "hello",
      after: "none",
      list: [1, 2],
    });
  });
});

describe("kv schema failures inside a function", () => {
  test("get, take and update all throw a NonRetriableError and leave the value", async () => {
    const kv = createKv({ adapter: memoryKvAdapter() });
    const client = new Inngest({ id: testClientId });
    const out: unknown[] = [];
    const fn = client.createFunction(
      { id: "kvinvalid", triggers: [{ event: "kv/invalid" }] },
      async () => {
        const count = kvKey("count", z.number());
        await kv.env.set("count", "text");
        for (const attempt of [
          () => kv.env.get(count),
          () => kv.env.take(count),
          () => kv.env.update(count, (n) => (n ?? 0) + 1),
        ]) {
          out.push(
            await attempt().then(
              () => "ok",
              (error: unknown) => error instanceof NonRetriableError,
            ),
          );
        }
        out.push(await kv.env.get("count"));
      },
    );
    const { type } = await runToEnd(fn);

    expect(type).toBe("function-resolved");
    expect(out.slice(-4)).toEqual([true, true, true, "text"]);
  });

  test("an update memoized by an older version still replays", async () => {
    const kv = createKv({ adapter: memoryKvAdapter() });
    const client = new Inngest({ id: testClientId });
    const fn = client.createFunction(
      { id: "kvupdlegacy", triggers: [{ event: "kv/updlegacy" }] },
      async () => {
        return kv.env.update(kvKey<number>("n"), (n) => (n ?? 0) + 5);
      },
    );
    let stepState: Parameters<typeof runFnWithStack>[1] = {};
    let output: unknown;

    for (let request = 0; request < 20 && output === undefined; request++) {
      const result = await runFnWithStack(fn, stepState);
      if (result.type === "function-resolved") {
        output = result.data;
        break;
      }

      const steps =
        result.type === "step-ran"
          ? [result.step]
          : result.type === "steps-found"
            ? result.steps
            : [];
      for (const step of steps) {
        if (
          step.op === StepOpCode.DeferAdd ||
          step.op === StepOpCode.DeferAbort
        ) {
          continue;
        }

        // Older versions memoized the new value itself.
        const data = step.userland?.id?.startsWith("kv.update:")
          ? (step.data as { value?: unknown }).value
          : step.data;
        stepState = { ...stepState, [step.id]: { id: step.id, data } };
      }
    }

    expect(output).toBe(5);
  });
});
