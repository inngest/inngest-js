/**
 * @module
 * Type tests for the KV: typed keys, the four scopes, `kv.with(client)`,
 * `kv.scope`, indexes and the store contract.
 */
import { z } from "zod";
// @ts-expect-error the old name for the store contract is gone
import type { KvAdapter } from "../index.ts";
import * as api from "../index.ts";
import {
  d1KvAdapter,
  type KvStore,
  kv,
  memoryKvAdapter,
  redisKvAdapter,
} from "../index.ts";
import { inngest, typesOnly } from "./typeFixtures.ts";

const plan = kv.key<{ steps: string[] }>("plan");

const schemed = kv.key("plan", z.object({ steps: z.array(z.string()) }));

describe("kv types", () => {
  test("kv.key<T> types get, set and update", () => {
    typesOnly(async () => {
      expectTypeOf(await kv.thread.get(plan)).toEqualTypeOf<
        { steps: string[] } | undefined
      >();

      await kv.thread.set(plan, { steps: [] }, { ttl: 60 });

      // @ts-expect-error steps is an array
      await kv.thread.set(plan, { steps: "x" });

      const updated = await kv.thread.update(plan, (found) => {
        expectTypeOf(found).toEqualTypeOf<{ steps: string[] } | undefined>();

        return { steps: [...(found?.steps ?? []), "x"] };
      });

      expectTypeOf(updated).toEqualTypeOf<{ steps: string[] }>();
    });
  });

  test("kv.key(name, schema) infers the value from the schema", () => {
    typesOnly(async () => {
      expectTypeOf(await kv.run.get(schemed)).toEqualTypeOf<
        { steps: string[] } | undefined
      >();
      expectTypeOf(await kv.run.take(schemed)).toEqualTypeOf<
        { steps: string[] } | undefined
      >();
    });
  });

  test("a type JSON cannot carry is refused at first use", () => {
    typesOnly(async () => {
      const when = kv.key<Date>("when");

      // @ts-expect-error a Date is not JSON
      await kv.thread.get(when);

      // @ts-expect-error a schema that transforms its input is refused
      kv.key("n", z.string().transform(Number));
    });
  });

  test("a plain name reads unknown and all() gives unknown values", () => {
    typesOnly(async () => {
      // Deliberate unknown: the store holds whatever was written under a plain
      // name, and kv.key<T> or a schema is how a reader proves the type.
      expectTypeOf(await kv.thread.get("anything")).toBeUnknown();
      expectTypeOf(await kv.thread.all()).toEqualTypeOf<
        Record<string, unknown>
      >();
    });
  });

  test("the four scopes have the same methods", () => {
    typesOnly(async () => {
      expectTypeOf(kv.thread).toEqualTypeOf<typeof kv.run>();
      expectTypeOf(kv.thread).toEqualTypeOf<typeof kv.app>();
      expectTypeOf(kv.thread).toEqualTypeOf<typeof kv.env>();

      expectTypeOf(
        await kv.app.setIfAbsent("flag", true, { ttl: 5 }),
      ).toBeBoolean();
      expectTypeOf(await kv.app.delete("flag")).toBeVoid();
      expectTypeOf(await kv.app.clear()).toBeVoid();
    });
  });

  test("bare kv.get and the session and function scopes are errors", () => {
    typesOnly(() => {
      // @ts-expect-error scopes are always written out
      kv.get;

      // @ts-expect-error scopes are always written out
      kv.set;

      // @ts-expect-error the session scope is deleted
      kv.session;

      // @ts-expect-error the function scope is deleted
      kv.function;

      // @ts-expect-error the session scope is deleted
      kv.scope("session", "x");
    });
  });

  test("kv.with(client) returns the same shape", () => {
    typesOnly(async () => {
      expectTypeOf(kv.with(inngest)).toEqualTypeOf<typeof kv>();
      expectTypeOf(await kv.with(inngest).app.get("flags")).toBeUnknown();
    });
  });

  test("kv.scope reaches another thread's state", () => {
    typesOnly(() => {
      expectTypeOf(kv.scope("thread", "slack:C1/123")).toEqualTypeOf<
        typeof kv.thread
      >();
    });
  });

  test("an index adds, ranges and removes members with scores", () => {
    typesOnly(async () => {
      const index = kv.thread.index("recent");

      await index.add("a", 1);

      expectTypeOf(
        await index.range({ min: 0, max: 10, limit: 5, order: "desc" }),
      ).toEqualTypeOf<{ member: string; score: number }[]>();
      expectTypeOf(await index.remove("a")).toBeVoid();
    });
  });

  test("the adapters return a KvStore and createAgents takes it", () => {
    typesOnly(() => {
      expectTypeOf(memoryKvAdapter).returns.toEqualTypeOf<KvStore>();
      expectTypeOf(redisKvAdapter).returns.toEqualTypeOf<KvStore>();
      expectTypeOf(d1KvAdapter).returns.toEqualTypeOf<KvStore>();
      expectTypeOf(redisKvAdapter).parameter(0).toBeString();
    });
  });

  test("createKv, kvKey and KvAdapter are gone", () => {
    // The `KvAdapter` import at the top of this file is the type check.
    expectTypeOf(api).not.toHaveProperty("createKv");
    expectTypeOf(api).not.toHaveProperty("kvKey");
  });
});
