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
      scope: `ci/run:${name.rootRunId}`,
      key: name.ownKey ? `${name.jobId}/${name.ownKey}` : name.jobId,
      generation: "run",
    };
  }

  const split = name.ownKey.lastIndexOf("/");
  const slot = split < 0 ? "" : name.ownKey.slice(0, split);

  return {
    scope: `ci/${name.scope}`,
    key: slot ? `${name.jobId}/${slot}` : name.jobId,
    generation: name.ownKey.slice(split + 1),
  };
};
