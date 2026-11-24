/**
 * The names snapshots are found by. A name is the core cache's
 * `<scope>/<key>/<generation>`; everything that builds a snapshot's entry goes
 * through here, so a change to the naming is a change to this file.
 *
 * @module
 */

import type { SnapshotEntry } from "inngest/experimental";

/** What a snapshot's name says it is. */
export type SnapshotName =
  | { kind: "cache"; scope: string; jobId: string; ownKey: string }
  | { kind: "run"; rootRunId: string; jobId: string; ownKey: string };

/** What every CI snapshot's scope starts with. */
const prefix = "ci";

/** The scope a cache scope (`main`, `pr:4`) is in a snapshot's entry. */
export const entryScope = (scope: string): string => {
  return `${prefix}/${scope}`;
};

/**
 * A job's own key: the `slot` that its app, repository and input share, and
 * the `generation` that a changed key replaces. `snapshotEntry` reads it back.
 */
export const ownKeyOf = (slot: string, generation: string): string => {
  return `${slot}/${generation}`;
};

/**
 * The cache entry a snapshot is: scope `ci/<scope>`, key `<job>/<slot>` and
 * the rest of the job's key as the generation, so the name is
 * `ci/<scope>/<job>/<slot>/<key hash>`. A run's own snapshots have the scope
 * `ci/run:<root run>`, with the job's key in the entry's key so the inputs of one
 * job never replace each other.
 */
export const snapshotEntry = (name: SnapshotName): SnapshotEntry => {
  if (name.kind === "run") {
    return {
      scope: entryScope(`run:${name.rootRunId}`),
      key: name.ownKey ? `${name.jobId}/${name.ownKey}` : name.jobId,
      generation: "run",
    };
  }

  const split = name.ownKey.lastIndexOf("/");
  const slot = split < 0 ? "" : name.ownKey.slice(0, split);

  return {
    scope: entryScope(name.scope),
    key: slot ? `${name.jobId}/${slot}` : name.jobId,
    generation: name.ownKey.slice(split + 1),
  };
};

/**
 * The entry a build run is asked for: its `entry`, or for a run invoked by an
 * earlier release, one that has the name its `cacheKey` held (the scope is the
 * literal `ci` prefix at its start, the generation is what follows the last
 * `/`).
 *
 * @throws {Error} When the data has neither.
 */
export const buildEntryOf = (data: {
  entry?: SnapshotEntry;
  cacheKey?: string;
}): SnapshotEntry => {
  if (data.entry) {
    return data.entry;
  }

  if (data.cacheKey === undefined) {
    throw new Error("A cache build needs its `entry`.");
  }

  const parts = data.cacheKey.split("/");

  // A name the earlier release made for a job it called itself: it has no
  // snapshot, so the name only keeps runs apart.
  if (parts.length < 3) {
    return { scope: prefix, key: data.cacheKey, generation: "run" };
  }

  return {
    scope: parts[0] as string,
    key: parts.slice(1, -1).join("/"),
    // A run's own snapshot of an earlier release ended its name with a `/`.
    generation: parts.at(-1) || "run",
  };
};
