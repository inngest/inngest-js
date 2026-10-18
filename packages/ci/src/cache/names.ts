/**
 * The names snapshots are found by. Everything that builds a snapshot's name
 * goes through here, so a change to the naming (such as named images) is a
 * change to this file.
 *
 * @module
 */

import { boundedName } from "../util.ts";

/** What a snapshot's name says it is. */
export type SnapshotName =
  | { kind: "cache"; scope: string; jobId: string; ownKey: string }
  | { kind: "run"; rootRunId: string; jobId: string; ownKey: string };

/**
 * The name a snapshot has: `ci/<scope>/<job>/<key>`, where a run's own
 * snapshots have the scope `run:<root run>`. A name too long for a snapshot
 * keeps its start and gains a hash of the whole, so it stays unique.
 */
export const formatName = (name: SnapshotName): string => {
  const scope = name.kind === "cache" ? name.scope : `run:${name.rootRunId}`;

  return boundedName(`ci/${scope}/${name.jobId}/${name.ownKey}`);
};
