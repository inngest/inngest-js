/**
 * The names snapshots are found by. Everything that builds a snapshot's name,
 * or reads one back, goes through here, so a change to the naming (such as
 * named images) is a change to this file.
 *
 * @module
 */

import { boundedName, maxNameLength } from "../util.ts";

/** What a snapshot's name says it is. */
export type SnapshotName =
  | { kind: "cache"; scope: string; jobId: string; ownKey: string }
  | { kind: "run"; rootRunId: string; jobId: string; ownKey: string };

/** The scope a name is in: a cache scope, or `run:<root run>` for a run's own. */
const scopeOf = (name: SnapshotName): string => {
  return name.kind === "cache" ? name.scope : `run:${name.rootRunId}`;
};

/**
 * The name a snapshot has: `ci/<scope>/<job>/<key>`, where a run's own
 * snapshots have the scope `run:<root run>`. A name too long for a snapshot
 * keeps its start and gains a hash of the whole, so it stays unique.
 */
export const formatName = (name: SnapshotName): string => {
  return boundedName(`ci/${scopeOf(name)}/${name.jobId}/${name.ownKey}`);
};

/**
 * What a name says, or `undefined` if it isn't one of CI's. Scopes (branches)
 * and job IDs may both contain `/`, so where one ends is read against the
 * known job IDs: the longest one the name ends in is the job. A name that was
 * cut for length has lost its key and is read by `matchesJob` instead.
 */
export const parseName = (
  name: string,
  jobIds: Iterable<string>,
): SnapshotName | undefined => {
  const keyStart = name.lastIndexOf("/");

  if (!name.startsWith("ci/") || keyStart <= "ci/".length) {
    return undefined;
  }

  const head = name.slice("ci/".length, keyStart);
  const ownKey = name.slice(keyStart + 1);

  let jobId: string | undefined;

  for (const id of jobIds) {
    if (
      head.length > id.length + 1 &&
      head.endsWith(`/${id}`) &&
      id.length > (jobId?.length ?? -1)
    ) {
      jobId = id;
    }
  }

  if (jobId === undefined) {
    return undefined;
  }

  const scope = head.slice(0, -(jobId.length + 1));

  return scope.startsWith("run:")
    ? { kind: "run", rootRunId: scope.slice("run:".length), jobId, ownKey }
    : { kind: "cache", scope, jobId, ownKey };
};

/** Whether the start a cut name kept could be the start of this job's names. */
const cutNameMayBe = (kept: string, job: string, scope?: string): boolean => {
  if (scope !== undefined) {
    const expected = `ci/${scope}/${job}/`;

    return kept.startsWith(expected) || expected.startsWith(kept);
  }

  // The cut may fall inside the job segment, so a tail of the start that
  // begins a `/<job>/` counts too.
  const marker = `/${job}/`;

  for (let i = kept.indexOf("/"); i >= 0; i = kept.indexOf("/", i + 1)) {
    if (kept.startsWith(marker, i) || marker.startsWith(kept.slice(i))) {
      return true;
    }
  }

  return false;
};

/**
 * Whether a snapshot is a job's, in one scope or any. `jobIds` are all the
 * registered job IDs, so a job `b` isn't mistaken for `a/b`.
 *
 * A name cut for length has lost its end, so it matches by what it kept, and
 * may match more than it should: deleting too much only costs a rebuild.
 */
export const matchesJob = (
  name: string | undefined,
  match: { job: string; scope?: string; jobIds: string[] },
): boolean => {
  const { job, scope, jobIds } = match;

  if (!name?.startsWith("ci/")) {
    return false;
  }

  // A cut name is exactly the longest length, ending in `-<8 hex>`.
  if (name.length === maxNameLength && /-[0-9a-f]{8}$/.test(name)) {
    const kept = name.slice(0, maxNameLength - "-".length - 8);

    const longer = jobIds.some((id) => {
      return id !== job && id.endsWith(`/${job}`) && kept.includes(`/${id}/`);
    });

    return !longer && cutNameMayBe(kept, job, scope);
  }

  const parsed = parseName(name, jobIds);

  return (
    parsed?.jobId === job && (scope === undefined || scopeOf(parsed) === scope)
  );
};
