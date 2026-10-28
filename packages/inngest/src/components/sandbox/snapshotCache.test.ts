/**
 * @module
 * Tests for the snapshot cache, against an in-memory snapshot API.
 */

import {
  type EvictOptions,
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

    const taken = await cache.take(entry, async (name) => {
      calls.push(name);

      if (name) {
        throw Object.assign(new Error("bad"), { status: 400 });
      }

      const row = api.add(undefined);

      return { id: row.id, createdAt: row.createdAt };
    });

    expect(calls).toEqual(["skills/acme/skills/sha1", undefined]);
    expect(taken).toMatchObject({ named: false, reused: false });
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

describe("making room at the snapshot limit", () => {
  const limit = 3;

  /** A snapshot call that fails with the limit error while `limit` snapshots live. */
  const limited = (api: ReturnType<typeof makeApi>) => {
    const attempts: number[] = [];
    const call = async (name: string | undefined, attempt: number) => {
      attempts.push(attempt);

      const live = api.rows.filter((row) => {
        return row.status !== "DELETED";
      });

      if (live.length >= limit) {
        throw Object.assign(new Error("limit"), {
          code: "sandbox_snapshot_limit_exceeded",
        });
      }

      const row = api.add(name);

      return { id: row.id, createdAt: row.createdAt };
    };

    return { call, attempts };
  };

  const live = (api: ReturnType<typeof makeApi>): (string | undefined)[] => {
    return api.rows
      .filter((row) => {
        return row.status !== "DELETED";
      })
      .map((row) => {
        return row.name;
      });
  };

  const thrown = async (
    promise: Promise<unknown>,
  ): Promise<Error & { code?: string; cause?: unknown }> => {
    try {
      await promise;
    } catch (error) {
      return error as Error;
    }

    throw new Error("expected a rejection");
  };

  const setup = (evict?: false | EvictOptions) => {
    const api = makeApi();
    const logs: string[] = [];
    const memoed: string[] = [];
    const cache = snapshotCache(api.client, {
      memo: async (id, fn) => {
        memoed.push(id);

        return fn();
      },
      evict:
        evict === false
          ? false
          : {
              ...evict,
              log: (message) => {
                logs.push(message);
              },
            },
    });

    return { api, cache, logs, memoed };
  };

  test("clears expired and failed snapshots, then retries once", async () => {
    const { api, cache, logs, memoed } = setup();

    api.add("a/b/g1", { expiresAt: new Date(Date.now() - hour).toISOString() });
    api.add("c/d/g1", { status: "FAILED" });
    api.add("e/f/g1");

    const { call, attempts } = limited(api);
    const taken = await cache.take(entry, call);

    expect(taken.named).toBe(true);
    expect(attempts).toEqual([0, 1]);
    expect(live(api)).toEqual(["e/f/g1", "skills/acme/skills/sha1"]);
    expect(logs).toHaveLength(2);
    expect(memoed).toContain("snapshot:skills/acme/skills/sha1:evict");
  });

  test("deletes a superseded generation of a cache entry when nothing is expired", async () => {
    const { api, cache, logs } = setup();

    api.add("x/y/old");
    api.add("x/y/new");
    api.add("keep/me/g1");

    const { call } = limited(api);

    await cache.take(entry, call);

    expect(live(api)).toEqual([
      "x/y/new",
      "keep/me/g1",
      "skills/acme/skills/sha1",
    ]);
    expect(logs[0]).toContain("x/y/old");
    expect(logs[0]).toContain("superseded");
  });

  test("evicts the least recently created snapshot in an evictable scope", async () => {
    const { api, cache } = setup({ scopes: ["ci/pr:*", "thread/*"] });

    api.add("main/repo/g1");
    api.add("ci/pr:4/job/g1");
    api.add("thread/t1/g1");

    const { call } = limited(api);

    await cache.take(entry, call);

    expect(live(api)).toEqual([
      "main/repo/g1",
      "thread/t1/g1",
      "skills/acme/skills/sha1",
    ]);
  });

  test("never evicts the excluded snapshot or the entry's own newest", async () => {
    const { api, cache, logs } = setup({ scopes: ["skills", "thread/*"] });

    api.add("skills/acme/skills/sha0");
    const read = api.add("thread/t1/g1");

    api.add("thread/t2/g1");

    const { call } = limited(api);

    await cache.take(entry, call, { exclude: read.id });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("thread/t2/g1");
    expect(live(api)).toContain(read.name);
    expect(live(api)).not.toContain("thread/t2/g1");
  });

  test("throws a clear limit error when nothing can be evicted", async () => {
    const { api, cache } = setup();

    api.add("main/repo/g1");
    api.add("main/other/g1");
    api.add("plain-name");

    const { call, attempts } = limited(api);
    const failure = await thrown(cache.take(entry, call));

    expect(failure.code).toBe("sandbox_snapshot_limit_exceeded");
    expect(failure.message).toContain("deleted 0");
    expect(failure.message).toContain("3 left");
    expect((failure.cause as { code: string }).code).toBe(
      "sandbox_snapshot_limit_exceeded",
    );
    expect(attempts).toEqual([0, 1]);
    expect(live(api)).toHaveLength(3);
  });

  test("a scope pattern without a star matches whole scopes only", async () => {
    const { api, cache } = setup({ scopes: ["main"] });

    api.add("main2/a/g1");
    api.add("main2/b/g1");
    api.add("main2/c/g1");

    const { call } = limited(api);
    const failure = await thrown(cache.take(entry, call));

    expect(failure.message).toContain("snapshot limit");
    expect(live(api)).toHaveLength(3);
  });

  test("deletes at most maxDeletions of the expired ones", async () => {
    const { api, cache } = setup({ maxDeletions: 2 });
    const past = new Date(Date.now() - hour).toISOString();

    api.add("a/a/g1", { expiresAt: past });
    api.add("b/b/g1", { expiresAt: past });
    api.add("c/c/g1", { expiresAt: past });

    const { call } = limited(api);

    await cache.take(entry, call);

    expect(live(api)).toHaveLength(2);
  });

  test("other errors and a disabled cache do not evict", async () => {
    const { api, cache } = setup();

    api.add("a/b/g1", { expiresAt: new Date(Date.now() - hour).toISOString() });

    await expect(
      cache.take(entry, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(live(api)).toHaveLength(1);

    const off = setup(false);

    off.api.add("a/b/g1", {
      expiresAt: new Date(Date.now() - hour).toISOString(),
    });
    off.api.add("c/d/g1");
    off.api.add("e/f/g1");

    const { call } = limited(off.api);

    await expect(off.cache.take(entry, call)).rejects.toMatchObject({
      code: "sandbox_snapshot_limit_exceeded",
    });
    expect(live(off.api)).toHaveLength(3);
  });
});
