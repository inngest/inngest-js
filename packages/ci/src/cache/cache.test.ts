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
import { deleteSnapshot, resolveTakenName } from "./cache.ts";

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

describe("resolveTakenName", () => {
  /** A run whose only snapshot holds the name, recording what is deleted. */
  const holding = (
    deleted: string[],
    /** When the holder was created, in place of now. */
    createdAt = new Date().toISOString(),
  ): CiRunScope => {
    const holder = {
      id: "main-snapshot",
      name: "ci/main/base/k",
      status: "READY",
      createdAt,
    };

    const snapshots = {
      list: async () => {
        return { items: [holder] };
      },
      get: async (id: string) => {
        return {
          delete: async () => {
            deleted.push(id);
          },
        };
      },
    };

    return {
      runId: "01TESTRUN",
      createdSnapshots: new Set<string>(),
      ci: { client: { sandboxes: { snapshots } } },
      step: {
        run: async (_options: unknown, body: () => Promise<unknown>) => {
          return body();
        },
      },
      // biome-ignore lint/suspicious/noExplicitAny: a partial scope is enough here
    } as any;
  };

  test("an excluded holder that isn't known to be broken is left alone", async () => {
    const deleted: string[] = [];

    const taken = await resolveTakenName(
      holding(deleted),
      "name-taken",
      "ci/main/base/k",
      "main-snapshot",
    );

    expect(deleted).toEqual([]);
    expect(taken.cleared).toBe(false);
  });

  test("an excluded holder that is broken is deleted, freeing the name", async () => {
    const deleted: string[] = [];

    const taken = await resolveTakenName(
      holding(deleted),
      "name-taken",
      "ci/main/base/k",
      "main-snapshot",
      true,
    );

    expect(deleted).toEqual(["main-snapshot"]);
    expect(taken.cleared).toBe(true);
  });

  test("a holder that is too old is replaced without being known to be broken", async () => {
    const deleted: string[] = [];

    const taken = await resolveTakenName(
      holding(deleted, "2020-01-01T00:00:00.000Z"),
      "name-taken",
      "ci/main/base/k",
      undefined,
      false,
      60_000,
    );

    expect(deleted).toEqual(["main-snapshot"]);
    expect(taken.cleared).toBe(true);
  });
});
