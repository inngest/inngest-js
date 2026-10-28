/**
 * @module
 * Tests for the snapshot cache, against an in-memory snapshot API.
 */

import {
  type SnapshotCacheClient,
  snapshotCache,
  snapshotGeneration,
  snapshotKey,
  snapshotName,
  snapshotSlot,
} from "./snapshotCache.ts";

interface Row {
  id: string;
  name?: string;
  status: string;
  createdAt: string;
  expiresAt?: string;
}

const hour = 60 * 60 * 1000;

const makeApi = () => {
  const rows: Row[] = [];
  let counter = 0;

  const withDelete = (row: Row) => {
    return {
      ...row,
      delete: async () => {
        row.status = "DELETED";
      },
    };
  };

  const client = {
    sandboxes: {
      snapshots: {
        list: async (options?: { name?: string }) => {
          const items = rows
            .filter((row) => {
              return options?.name === undefined || row.name === options.name;
            })
            .reverse()
            .map(withDelete);

          return { items, page: { hasMore: false } };
        },
        get: async (id: string) => {
          const row = rows.find((candidate) => {
            return candidate.id === id;
          });

          return row ? withDelete(row) : null;
        },
      },
    },
  } as unknown as SnapshotCacheClient;

  const add = (name: string | undefined, extra: Partial<Row> = {}): Row => {
    counter += 1;

    const row: Row = {
      id: `snap-${counter}`,
      ...(name === undefined ? {} : { name }),
      status: "READY",
      createdAt: new Date(Date.now() + counter).toISOString(),
      expiresAt: new Date(Date.now() + 24 * hour).toISOString(),
      ...extra,
    };

    rows.push(row);

    return row;
  };

  /** A snapshot call that follows the platform: one live holder per name. */
  const snapshotCall = (calls: (string | undefined)[] = []) => {
    return async (name: string | undefined) => {
      calls.push(name);

      const held = rows.some((row) => {
        return (
          name !== undefined &&
          row.name === name &&
          row.status === "READY" &&
          (!row.expiresAt || Date.parse(row.expiresAt) > Date.now())
        );
      });

      if (held) {
        throw Object.assign(new Error("taken"), {
          code: "sandbox_snapshot_name_taken",
        });
      }

      const row = add(name);

      return { id: row.id, createdAt: row.createdAt };
    };
  };

  return { client, rows, add, snapshotCall };
};

const entry = { scope: "skills", key: "acme/skills", generation: "sha1" };

describe("snapshot names", () => {
  test("joins scope, key and generation", () => {
    expect(snapshotName(entry)).toBe("skills/acme/skills/sha1");
    expect(snapshotSlot("skills/acme/skills/sha1")).toBe("skills/acme/skills");
    expect(snapshotGeneration("skills/acme/skills/sha1")).toBe("sha1");
  });

  test("a long name keeps its generation whole and stays unique", () => {
    const long = "k".repeat(400);
    const a = snapshotName({ scope: "s", key: `${long}a`, generation: "g1" });
    const b = snapshotName({ scope: "s", key: `${long}b`, generation: "g1" });

    expect(a.length).toBeLessThanOrEqual(255);
    expect(a.endsWith("/g1")).toBe(true);
    expect(a).not.toBe(b);
  });

  test("rejects a generation too long to fit", () => {
    expect(() =>
      snapshotName({ ...entry, generation: "g".repeat(250) }),
    ).toThrow();
  });

  test("rejects empty parts and a generation with a slash", () => {
    expect(() => snapshotName({ ...entry, key: "" })).toThrow();
    expect(() => snapshotName({ ...entry, generation: "a/b" })).toThrow();
  });
});

describe("snapshot keys", () => {
  test("changes with any part, and resolves functions once", async () => {
    const a = await snapshotKey(["x", async () => "y"]);
    const b = await snapshotKey(["x", "y"]);
    const c = await snapshotKey(["x", "z"]);

    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
  });

  test("named parts come back and are told apart by name", async () => {
    const a = await snapshotKey({ sha: "1", node: "22" });
    const b = await snapshotKey({ sha: "22", node: "1" });

    expect(a.named).toEqual({ sha: "1", node: "22" });
    expect(a.hash).not.toBe(b.hash);
  });

  test("entries hash the same as the array and record forms", async () => {
    const array = await snapshotKey(["x", "y"]);
    const entries = await snapshotKey([
      [undefined, "x"],
      [undefined, "y"],
    ]);
    const record = await snapshotKey({ sha: "1", node: "22" });
    const named = await snapshotKey([
      ["sha", "1"],
      ["node", "22"],
    ]);

    expect(entries.hash).toBe(array.hash);
    expect(named).toEqual(record);
  });
});

describe("find", () => {
  test("returns the named snapshot, and misses for another generation", async () => {
    const api = makeApi();
    const row = api.add(snapshotName(entry));
    const cache = snapshotCache(api.client);

    expect((await cache.find(entry))?.snapshotId).toBe(row.id);
    expect(await cache.find({ ...entry, generation: "sha2" })).toBeUndefined();
  });

  test("reads scopes in order", async () => {
    const api = makeApi();
    const main = api.add(snapshotName({ ...entry, scope: "main" }));
    const cache = snapshotCache(api.client);

    const pr = { ...entry, scope: "pr:4" };

    expect((await cache.find(pr, { read: ["pr:4", "main"] }))?.snapshotId).toBe(
      main.id,
    );

    const own = api.add(snapshotName(pr));

    expect((await cache.find(pr, { read: ["pr:4", "main"] }))?.snapshotId).toBe(
      own.id,
    );
  });

  test("skips expiring, too old, excluded and unready snapshots", async () => {
    const api = makeApi();
    const name = snapshotName(entry);
    const cache = snapshotCache(api.client);

    const expiring = api.add(name, {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(await cache.find(entry)).toBeUndefined();

    expiring.status = "DELETED";
    const old = api.add(name, {
      createdAt: new Date(Date.now() - 2 * hour).toISOString(),
    });

    expect(await cache.find(entry, { maxAge: "1h" })).toBeUndefined();
    expect((await cache.find(entry))?.snapshotId).toBe(old.id);
    expect(await cache.find(entry, { exclude: old.id })).toBeUndefined();

    old.status = "FAILED";
    expect(await cache.find(entry)).toBeUndefined();
  });

  test("an error is a miss", async () => {
    const cache = snapshotCache({
      sandboxes: {
        snapshots: {
          list: async () => {
            throw new Error("down");
          },
          get: async () => null,
        },
      },
    });

    expect(await cache.find(entry)).toBeUndefined();
  });

  test("runs the lookup through memo", async () => {
    const api = makeApi();
    const ids: string[] = [];
    const cache = snapshotCache(api.client, {
      memo: (id, fn) => {
        ids.push(id);

        return fn();
      },
    });

    await cache.find(entry, { stepId: "look" });

    expect(ids).toEqual(["look:find"]);
  });

  test("replace: false skips looking for older generations", async () => {
    const api = makeApi();
    const actions: string[] = [];
    const cache = snapshotCache(api.client, {
      memo: (_id, fn, action) => {
        actions.push(action);

        return fn();
      },
    });
    const old = api.add(snapshotName({ ...entry, generation: "sha0" }));

    await cache.take(entry, api.snapshotCall(), { replace: false });

    expect(actions).toEqual([]);
    expect(old.status).toBe("READY");
  });

  test("tells memo which action each call is", async () => {
    const api = makeApi();
    const actions: string[] = [];
    const cache = snapshotCache(api.client, {
      memo: (_id, fn, action) => {
        actions.push(action);

        return fn();
      },
    });

    await cache.find(entry);
    await cache.take(entry, async (name) => {
      return api.snapshotCall()(name);
    });

    expect(actions).toEqual(["find", "replaced"]);
  });
});

describe("take", () => {
  test("names the snapshot and deletes older generations of the entry", async () => {
    const api = makeApi();
    const old = api.add(snapshotName(entry));
    const other = api.add(snapshotName({ ...entry, key: "acme/other" }));
    const cache = snapshotCache(api.client);
    const calls: (string | undefined)[] = [];

    old.status = "READY";
    old.expiresAt = new Date(Date.now() + 24 * hour).toISOString();

    const next = { ...entry, generation: "sha2" };
    const taken = await cache.take(next, api.snapshotCall(calls));

    expect(calls).toEqual(["skills/acme/skills/sha2"]);
    expect(taken).toMatchObject({ named: true, reused: false });
    expect(old.status).toBe("DELETED");
    expect(other.status).toBe("READY");
  });

  test("adopts the snapshot another build named first", async () => {
    const api = makeApi();
    const winner = api.add(snapshotName(entry));
    const cache = snapshotCache(api.client);

    const taken = await cache.take(entry, api.snapshotCall());

    expect(taken).toMatchObject({
      snapshotId: winner.id,
      named: true,
      reused: true,
    });
  });

  test("deletes a holder that is too old and takes the name", async () => {
    const api = makeApi();
    const stale = api.add(snapshotName(entry), {
      createdAt: new Date(Date.now() - 2 * hour).toISOString(),
    });
    const cache = snapshotCache(api.client);

    const taken = await cache.take(entry, api.snapshotCall(), {
      maxAge: "1h",
    });

    expect(stale.status).toBe("DELETED");
    expect(taken).toMatchObject({ named: true, reused: false });
    expect(taken.snapshotId).not.toBe(stale.id);
  });

  test("a broken excluded holder is deleted, a merely excluded one is not", async () => {
    const api = makeApi();
    const bad = api.add(snapshotName(entry));
    const cache = snapshotCache(api.client);

    await cache.take(entry, api.snapshotCall(), { exclude: bad.id });
    expect(bad.status).toBe("READY");

    await cache.take(entry, api.snapshotCall(), {
      exclude: bad.id,
      broken: true,
    });
    expect(bad.status).toBe("DELETED");
  });

  test("deletes older generations when the name is taken after a retry", async () => {
    const api = makeApi();
    const old = api.add(snapshotName(entry));
    const stale = api.add(snapshotName({ ...entry, generation: "sha2" }), {
      createdAt: new Date(Date.now() - 2 * hour).toISOString(),
    });
    const cache = snapshotCache(api.client);

    const taken = await cache.take(
      { ...entry, generation: "sha2" },
      api.snapshotCall(),
      { maxAge: "1h" },
    );

    expect(stale.status).toBe("DELETED");
    expect(old.status).toBe("DELETED");
    expect(taken.named).toBe(true);
  });

  test("falls back to an unnamed snapshot when the name is refused", async () => {
    const api = makeApi();
    const cache = snapshotCache(api.client);
    const calls: (string | undefined)[] = [];
    const numbers: number[] = [];

    const taken = await cache.take(entry, async (name, n) => {
      calls.push(name);
      numbers.push(n);

      if (name) {
        throw Object.assign(new Error("bad"), { status: 400 });
      }

      const row = api.add(undefined);

      return { id: row.id, createdAt: row.createdAt };
    });

    expect(calls).toEqual(["skills/acme/skills/sha1", undefined]);
    expect(numbers).toEqual([0, 1]);
    expect(taken).toMatchObject({ named: false, reused: false });
  });

  test("a name refused as the cause of a step error falls back too", async () => {
    const api = makeApi();
    const cache = snapshotCache(api.client);

    const taken = await cache.take(entry, async (name) => {
      if (name) {
        throw new Error("step failed", { cause: { status: 400 } });
      }

      const row = api.add(undefined);

      return { id: row.id, createdAt: row.createdAt };
    });

    expect(taken.named).toBe(false);
  });

  test("other errors are thrown", async () => {
    const cache = snapshotCache(makeApi().client);

    await expect(
      cache.take(entry, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

describe("ensure", () => {
  test("a hit does not build, a miss builds once", async () => {
    const api = makeApi();
    const cache = snapshotCache(api.client);
    let builds = 0;
    const build = (
      take: (s: ReturnType<typeof api.snapshotCall>) => unknown,
    ) => {
      builds += 1;

      return take(api.snapshotCall()) as Promise<never>;
    };

    const first = await cache.ensure(entry, build);
    const second = await cache.ensure(entry, build);

    expect(builds).toBe(1);
    expect(second.snapshotId).toBe(first.snapshotId);
  });

  test("a new generation builds again and replaces the old one", async () => {
    const api = makeApi();
    const cache = snapshotCache(api.client);
    const build = (
      take: (s: ReturnType<typeof api.snapshotCall>) => unknown,
    ) => {
      return take(api.snapshotCall()) as Promise<never>;
    };

    const first = await cache.ensure(entry, build);
    const second = await cache.ensure({ ...entry, generation: "sha2" }, build);

    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(
      api.rows.find((row) => {
        return row.id === first.snapshotId;
      })?.status,
    ).toBe("DELETED");
  });
});

describe("latest and remove", () => {
  test("latest returns the newest generation of a scope and key", async () => {
    const api = makeApi();
    const cache = snapshotCache(api.client);

    api.add("thread/t1/1");
    const newest = api.add("thread/t1/2");
    api.add("thread/t10/9");

    const found = await cache.latest({ scope: "thread", key: "t1" });

    expect(found?.snapshotId).toBe(newest.id);
  });

  test("latest does not match a key that merely starts the same", async () => {
    const api = makeApi();
    const cache = snapshotCache(api.client);

    api.add("skills/acme/skills/sha1");

    expect(
      await cache.latest({ scope: "skills", key: "acme" }),
    ).toBeUndefined();
    expect(
      (await cache.latest({ scope: "skills", key: "acme/skills" }))?.name,
    ).toBe("skills/acme/skills/sha1");
  });

  test("remove tolerates a snapshot that is gone", async () => {
    const api = makeApi();
    const cache = snapshotCache(api.client);

    expect(await cache.remove("missing")).toBe(true);
  });
});
