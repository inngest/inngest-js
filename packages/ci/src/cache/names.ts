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
 * has everything before its last part shortened, keeping its start and gaining a hash
 * of it, so the last part stays whole and no two names collide.
 */
export const formatName = (name: SnapshotName): string => {
  const scope = name.kind === "cache" ? name.scope : `run:${name.rootRunId}`;
  const full = `ci/${scope}/${name.jobId}/${name.ownKey}`;
  const split = full.lastIndexOf("/");
  const last = full.slice(split + 1);

  return `${boundedName(full.slice(0, split), 255 - 1 - last.length)}/${last}`;
};

/** What every snapshot a run owns starts with. */
export const runNamePrefix = (rootRunId: string): string => {
  return `ci/run:${rootRunId}/`;
};
