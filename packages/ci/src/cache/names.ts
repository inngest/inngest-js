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
  | { kind: "cache"; jobId: string; ownKey: string; local?: boolean }
  | { kind: "run"; rootRunId: string; jobId: string; ownKey: string };

/**
 * The name a snapshot has: `ci/<where>/<job>/<key>`. A cache entry is named
 * only by its job and key, so every run that computes the same key finds it,
 * and `where` is `cache`, or `local` for one a local run wrote. A run's own
 * snapshots have `run:<root run>`. A name too long for a snapshot has everything
 * before its last part shortened, keeping its start and gaining a hash of it,
 * so the last part stays whole and no two names collide.
 */
export const formatName = (name: SnapshotName): string => {
  const where =
    name.kind === "run"
      ? `run:${name.rootRunId}`
      : name.local
        ? "local"
        : "cache";

  const full = `ci/${where}/${name.jobId}/${name.ownKey}`;
  const split = full.lastIndexOf("/");
  const last = full.slice(split + 1);

  return `${boundedName(full.slice(0, split), 255 - 1 - last.length)}/${last}`;
};

/** Whether a name belongs to one pipeline run, which deletes the snapshot when it ends. */
export const isRunName = (name: string): boolean => {
  return name.startsWith("ci/run:");
};
