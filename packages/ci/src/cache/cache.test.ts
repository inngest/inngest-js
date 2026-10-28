/**
 * Tests for the cache's bookkeeping across replays: what a run remembers
 * about a snapshot must not depend on whether the step that deleted it ran or
 * was memoized.
 *
 * @module
 */

import { describe, expect, test } from "vitest";

import { deleteRunSnapshots } from "../machine/machine.ts";
import type { CiRunScope } from "../pipeline/scope.ts";
import { deleteSnapshot, resolveCacheKey, snapshotCacheOf } from "./cache.ts";

/** Step results by ID, kept across the "replays" of one test. */
type Memo = Map<string, unknown>;

/**
 * A run whose `step.run` memoizes by ID, like the real one: a step already in
 * `memo` returns its recorded result without running its body. Each call to
 * this is a fresh replay of the handler, with the in-memory state a replay
 * starts with.
 */
const replayOf = (
  memo: Memo,
  gets: string[],
  startsWith: string[],
): CiRunScope => {
  const snapshots = {
    get: async (id: string) => {
      gets.push(id);

      return { delete: async () => {} };
    },
  };

  return {
    runId: "01TESTRUN",
    createdSnapshots: new Set(startsWith),
    ci: { client: { sandboxes: { snapshots } } },
    step: {
      run: async (
        options: { id: string },
        body: () => Promise<unknown>,
      ): Promise<unknown> => {
        if (memo.has(options.id)) {
          return memo.get(options.id);
        }

        const result = await body();

        memo.set(options.id, result);

        return result;
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: a partial scope is enough here
  } as any;
};

describe("deleteSnapshot", () => {
  test("a memoized delete still takes the snapshot out of the run's cleanup", async () => {
    const memo: Memo = new Map();
    const gets: string[] = [];

    // First request: the delete step runs.
    const first = replayOf(memo, gets, ["snap-1"]);

    await deleteSnapshot(first, "job › cache:delete", "snap-1");

    expect(first.createdSnapshots.has("snap-1")).toBe(false);
    expect(gets).toEqual(["snap-1"]);

    // A replay: the build is adopted again, so the id is back in the set, and
    // the delete step is memoized so its body doesn't run.
    const replay = replayOf(memo, gets, ["snap-1"]);

    await deleteSnapshot(replay, "job › cache:delete", "snap-1");

    expect(replay.createdSnapshots.has("snap-1")).toBe(false);
    expect(gets).toEqual(["snap-1"]);

    // So the run's cleanup has nothing to look up for it.
    await deleteRunSnapshots(replay);

    expect(gets).toEqual(["snap-1"]);
  });
});

describe("resolveCacheKey", () => {
  const run = {} as CiRunScope;

  test("the names of a key's parts are part of its hash", async () => {
    const a = await resolveCacheKey(run, { node: "20", pnpm: "9" });
    const b = await resolveCacheKey(run, { pnpm: "20", node: "9" });

    expect(a.hash).not.toBe(b.hash);
  });

  test("a named part called kind is a part, not a files() selector", async () => {
    const { named } = await resolveCacheKey(run, { kind: "release" });

    expect(named).toEqual({ kind: "release" });
  });
});

describe("snapshotCacheOf", () => {
  test("at the snapshot limit it deletes a pull request's snapshot and never a branch's", async () => {
    const deleted: string[] = [];
    const old = "2020-01-01T00:00:00.000Z";
    const rows = [
      { id: "main", name: "ci/main/job/a/1", status: "READY", createdAt: old },
      { id: "pr", name: "ci/pr:4/job/a/1", status: "READY", createdAt: old },
    ];

    const snapshots = {
      list: async () => {
        return { items: rows, page: { hasMore: false } };
      },
      get: async (id: string) => {
        return {
          delete: async () => {
            deleted.push(id);
          },
        };
      },
    };

    const run = {
      ci: { client: { sandboxes: { snapshots } } },
      step: {
        run: async (_options: unknown, body: () => Promise<unknown>) => {
          return body();
        },
      },
      // biome-ignore lint/suspicious/noExplicitAny: a partial scope is enough here
    } as any;

    let calls = 0;

    await snapshotCacheOf(run, (id) => {
      return { id, name: id };
    }).take({ scope: "ci/pr:9", key: "job/b", generation: "2" }, async () => {
      calls++;

      if (calls === 1) {
        throw Object.assign(new Error("limit"), {
          code: "sandbox_snapshot_limit_exceeded",
        });
      }

      return { id: "new", createdAt: new Date().toISOString() };
    });

    expect(deleted).toEqual(["pr"]);
  });
});
