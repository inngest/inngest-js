/**
 * @module
 * Tests for the D1 store beyond the shared contract, and for choosing a store
 * with `createAgents`.
 */
import { Inngest } from "../Inngest.ts";
import { createAgents } from "./agents.ts";
import { fakeD1, hasNodeSqlite } from "./fake-d1.ts";
import { createKv, kv, memoryKvAdapter } from "./kv.ts";
import { d1KvAdapter, d1KvSchema } from "./kvD1.ts";

describe.skipIf(!hasNodeSqlite)("the d1 store", () => {
  test("setIfAbsent calls issued together give exactly one winner", async () => {
    const adapter = d1KvAdapter(await fakeD1(() => 1_700_000_000_000), {
      createTables: true,
    });
    const results = await Promise.all(
      ["a", "b", "c", "d"].map((value) => {
        return adapter.setIfAbsent("h", "claim", value, 60);
      }),
    );

    expect(
      results.filter((won) => {
        return won;
      }),
    ).toHaveLength(1);
  });

  test("takes the database from a function, for bindings that arrive per request", async () => {
    const database = await fakeD1(() => 1_700_000_000_000);
    let calls = 0;
    const adapter = d1KvAdapter(
      () => {
        calls++;

        return database;
      },
      { createTables: true },
    );

    await adapter.set("h", "k", '"v"');

    expect(await adapter.get("h", "k")).toBe('"v"');
    expect(calls).toBeGreaterThan(1);
  });

  test("expired rows of a scope are deleted when it is written with a ttl", async () => {
    let clock = 1_700_000_000_000;
    const database = await fakeD1(() => clock);
    const adapter = d1KvAdapter(database, { createTables: true });

    await adapter.set("h", "old", '"x"', 5);
    clock += 10_000;
    await adapter.set("h", "new", '"y"', 5);

    const left = await database.prepare("SELECT field FROM inngest_kv").all();

    expect(left.results).toEqual([{ field: "new" }]);
  });

  test("a ttl lasts its full length, to the millisecond", async () => {
    let clock = 1_700_000_000_900;
    const adapter = d1KvAdapter(await fakeD1(() => clock), {
      createTables: true,
    });

    await adapter.set("h", "k", "1", 1);
    clock += 999;

    expect(await adapter.get("h", "k")).toBe("1");

    clock += 2;

    expect(await adapter.get("h", "k")).toBeNull();
  });

  test("a claim whose holder vanishes between the two statements is retried", async () => {
    const database = await fakeD1(() => 1_700_000_000_000);
    const adapter = d1KvAdapter(
      {
        ...database,
        prepare: (sql) => {
          const statement = database.prepare(sql);

          // The first upsert finds a holder, which is gone before the read.
          if (sql.includes("ON CONFLICT (scope, field)") && !vanished) {
            vanished = true;

            return {
              ...statement,
              bind: (...values) => {
                const bound = statement.bind(...values);

                return {
                  ...bound,
                  run: async () => ({ meta: { changes: 0 } }),
                };
              },
            };
          }

          return statement;
        },
      },
      { createTables: true },
    );
    let vanished = false;

    expect(await adapter.setIfAbsent("h", "claim", "mine", 60)).toBe(true);
    expect(await adapter.get("h", "claim")).toBe("mine");
  });

  test("a range with infinite bounds is unbounded", async () => {
    const adapter = d1KvAdapter(await fakeD1(() => 1_700_000_000_000), {
      createTables: true,
    });

    await adapter.indexAdd("h", "i", "a", 1);

    expect(
      await adapter.indexRange("h", "i", { min: -Infinity, max: Infinity }),
    ).toEqual([{ member: "a", score: 1 }]);
    expect(await adapter.indexRange("h", "i", { min: Infinity })).toEqual([]);
    expect(await adapter.indexRange("h", "i", { max: -Infinity })).toEqual([]);
  });

  test("the schema can be created by a migration instead", async () => {
    const database = await fakeD1(() => 1_700_000_000_000);

    await database.batch(
      d1KvSchema.map((statement) => {
        return database.prepare(statement);
      }),
    );
    const adapter = d1KvAdapter(database);

    await adapter.set("h", "k", "1");

    expect(await adapter.get("h", "k")).toBe("1");
  });
});

describe("the store an app gives createAgents", () => {
  test("the default kv uses it for that app", async () => {
    const mine = memoryKvAdapter();
    const client = new Inngest({ id: "stores-app-a" });
    createAgents(client, { store: mine });

    await kv.with(client).env.set("k", 1);

    expect(await mine.all("inngest:kv:env:default")).toEqual({ k: "1" });
  });

  test("scope('app', id) reads the caller's store, not the named app's", async () => {
    const mine = memoryKvAdapter();
    const client = new Inngest({ id: "stores-app-c" });
    createAgents(client, { store: mine });

    await kv.with(client).scope("app", "elsewhere").set("k", 1);

    expect(
      Object.keys(await mine.all("inngest:kv:app:default:elsewhere")),
    ).toEqual(["k"]);
  });

  test("a store given to createKv wins over the app's", async () => {
    const mine = memoryKvAdapter();
    const own = memoryKvAdapter();
    const client = new Inngest({ id: "stores-app-b" });
    createAgents(client, { store: mine });

    await createKv({ adapter: own }).with(client).env.set("k", 1);

    expect(await own.all("inngest:kv:env:default")).toEqual({ k: "1" });
    expect(await mine.all("inngest:kv:env:default")).toEqual({});
  });
});
