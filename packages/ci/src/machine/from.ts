/**
 * Starting a job from its `from` parent's machine: working out what `from`
 * names, getting the parent's snapshot, and starting the job from it, plus the
 * fallback that re-runs the parent's handler when no snapshot is available.
 *
 * @module
 */

import type { BaseIdentity } from "../cache/cache.ts";
import { CiUsageError } from "../errors.ts";
import { joinJob } from "../pipeline/job.ts";
import type { CiJobScope, CiRunScope } from "../pipeline/scope.ts";
import { countApi } from "../pipeline/scope.ts";
import type { AnyJob, JobConfig, JobRef } from "../types.ts";
import { snapshotJob } from "./machine.ts";

/** A `from` parent, worked out: the job's config and the input it's built with. */
export interface Parent {
  config: JobConfig;
  input: unknown;
}

const isJob = (value: unknown): value is AnyJob => {
  return (
    typeof value === "function" &&
    (value as Partial<AnyJob>).kind === "inngest/ci.job"
  );
};

const isJobRef = (value: unknown): value is JobRef => {
  return (value as JobRef | undefined)?.kind === "inngest/ci.jobRef";
};

/**
 * The registry of the CI client each job object was defined on. A job is
 * compared by this rather than by ID, so a job of the same ID from another
 * client is caught. Curried factories make a new job object per call, so it's
 * the registry that has to match, not the registered entry.
 */
const jobOwners = new WeakMap<object, unknown>();

/** Record which client's registry a job was defined on. */
export const ownJob = (job: object, jobs: unknown): void => {
  jobOwners.set(job, jobs);
};

/**
 * What a job's `from` names for this call: the parent job and the input it's
 * built with, or nothing for a job without one. A function is called with the
 * job's input. Pure, so a handler replaying from the top gets the same answer
 * without a step.
 *
 * @throws {CiUsageError} When `from` names something that isn't a job of this
 * client.
 */
export const parentOf = (
  run: CiRunScope,
  config: JobConfig,
  /** The job's own input. */
  input: unknown,
): Parent | undefined => {
  const from = config.from;

  if (from === undefined) {
    return undefined;
  }

  const named: unknown =
    typeof from === "function" && !isJob(from)
      ? (from as (ctx: { input: unknown }) => unknown)({ input })
      : from;

  const ref = isJobRef(named)
    ? named
    : isJob(named)
      ? { job: named, input: undefined }
      : undefined;

  if (!ref) {
    throw new CiUsageError(
      `The \`from\` of job "${config.id}" must name a job, or a job with input from \`job.with(input)\`.`,
    );
  }

  const registered = run.ci.jobs.get(ref.job.id);

  if (!registered || jobOwners.get(ref.job) !== run.ci.jobs) {
    throw new CiUsageError(
      `Job "${config.id}" starts from \`${ref.job.id}\`, which isn't defined on this CI client.`,
    );
  }

  return { config: registered.config, input: ref.input };
};

/**
 * Get the parent's machine to copy: join its shared run, or start it, and
 * snapshot it. The parent runs once however many jobs start from it, and if
 * it's also called directly, that run is the one used.
 *
 * What comes back is what a cached job's name is built from, so a parent with
 * a new snapshot gives every job below it a new name.
 */
export const parentSnapshot = async (
  scope: CiJobScope,
  parent: Parent,
): Promise<BaseIdentity> => {
  const { run } = scope;
  const { id } = parent.config;

  countApi("from");

  scope.fromJobIds.push(id);

  run.ci.hooks.jobFrom(scope, id);

  const children = run.fromChildren.get(id) ?? new Set<string>();

  children.add(scope.jobPath);
  run.fromChildren.set(id, children);

  await joinJob({ id, input: parent.input });

  const snapshotId = await snapshotJob(run, id);

  return { jobId: id, ...(snapshotId ? { snapshotId } : {}) };
};

/**
 * Start this job on a copy of its parent's machine, before its handler runs.
 * The copy is made when this job runs its first command, so a job that starts
 * from another and then waits doesn't pay for a machine while it waits.
 */
export const startFrom = async (
  scope: CiJobScope,
  parent: Parent,
  /** The parent's snapshot, from `parentSnapshot`. */
  base: BaseIdentity,
): Promise<void> => {
  const { run } = scope;
  const { id } = parent.config;

  if (base.snapshotId) {
    scope.fromSnapshotId = base.snapshotId;

    scope.rebuildParent = () => {
      return rerunOnThisMachine(scope, parent);
    };
  } else if (run.machines.has(id) || run.cachedSnapshots.has(id)) {
    await rerunOnThisMachine(scope, parent);
  }
};

/**
 * Without a snapshot to copy, get this machine to where the parent's finished
 * the slow way: start from the parent's own parent, then run the parent's
 * handler again, here. Its commands and steps show in the trace under this
 * job, and this job doesn't run the parent's job again.
 *
 * TODO: This is a stopgap, not the design. Every job that starts from the
 * same parent repeats the parent's work, so N children means N builds. A
 * proper fix builds the parent once and has every concurrent caller wait on
 * that one build (no thundering herd), which needs reliable snapshots or a
 * shared base image to copy from.
 */
const rerunOnThisMachine = async (
  scope: CiJobScope,
  parent: Parent,
): Promise<void> => {
  const { run } = scope;
  const registered = run.ci.jobs.get(parent.config.id);

  if (!registered) {
    return;
  }

  const grandparent = parentOf(run, parent.config, parent.input);

  // Before the machine exists, it can still start from the grandparent's
  // snapshot. After, as when a snapshot wouldn't start, the grandparent has to
  // run here too.
  if (grandparent && scope.machine) {
    await rerunOnThisMachine(scope, grandparent);
  } else if (grandparent) {
    await startFrom(
      scope,
      grandparent,
      await parentSnapshot(scope, grandparent),
    );
  }

  await registered.handler(parent.input);
};
