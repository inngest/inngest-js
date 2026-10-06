/**
 * Starting a job from another job's machine: `from()`, plus the fallback that
 * re-runs the parent's handler when no snapshot is available.
 *
 * @module
 */

import { describeCached } from "../cache/cache.ts";
import { CiUsageError } from "../errors.ts";
import { rebuildJob } from "../pipeline/job.ts";
import type { CiJobScope } from "../pipeline/scope.ts";
import { countApi, jobHandlerKey, requireJobScope } from "../pipeline/scope.ts";
import type { AnyJob, Job } from "../types.ts";
import { snapshotJob } from "./machine.ts";

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Start this job on a copy of another job's machine.
 *
 * The parent runs once however many jobs start from it, and each child gets
 * its own copy, so they can't affect each other. The copy is made when this
 * job runs its first command, so a job that starts from another and then
 * waits doesn't pay for a machine while it waits.
 *
 * ```ts
 * const setup = ci.job("setup", async () => {
 *   await checkout();
 *   await $`pnpm install`;
 *   return { installedAt: Date.now() };
 * });
 *
 * const test = ci.job("test", async () => {
 *   const { installedAt } = await from(setup); // typed from `setup`
 *   await $`pnpm test`;                        // runs on a copy of it
 * });
 * ```
 *
 * `await setup()` and `await from(setup)` differ: the first runs setup on its
 * own machine and gives you its result, the second does that *and* starts this
 * job from where it finished.
 *
 * Resolves to whatever the parent job returned. A cached parent is built in a
 * run of its own, or not at all, so it resolves to `undefined`.
 *
 * @throws {CiUsageError} When called outside a job, after this job's first
 * command, or a second time.
 */
export async function from<TResult>(
  /** The job to start from. Its result type comes back. */
  job: Job<TResult>,
): Promise<TResult>;
export async function from<TResult, TInput>(
  /** The job to start from. Its result type comes back. */
  job: Job<TResult, TInput>,
  /** The parent's input, when it takes one. */
  input: TInput,
): Promise<TResult>;
export async function from(job: AnyJob, input?: unknown): Promise<unknown> {
  const scope = requireJobScope("from");

  countApi("from");

  if (scope.machine || scope.fromCalled) {
    throw new CiUsageError(
      "`from()` must come before this job's first command, and can only be called once.",
    );
  }

  scope.fromCalled = true;

  scope.fromJobIds.push(job.id);

  scope.run.ci.reporter.jobFrom(scope, job.id);

  if (input !== undefined) {
    scope.parentInputs[job.id] = input;
  }

  scope.run.ci.reporter.activity(
    scope.run,
    scope.jobPath,
    `waiting for ${job.id}…`,
  );

  const result = await job(input as never);

  const snapshotId = await snapshotJob(scope.run, job.id);

  const { run } = scope;
  const cached = run.cached.get(job.id);
  const cacheable = Boolean(run.ci.jobs.get(job.id)?.config.cache);

  if (snapshotId) {
    scope.fromSnapshotId = snapshotId;

    scope.startNote =
      cached?.snapshotId === snapshotId
        ? `starting ${job.id} · ${describeCached(cached.createdAt)}`
        : `starting ${job.id}`;

    scope.rebuildSnapshot = () => {
      return rebuildJob(run, job.id, input);
    };

    scope.rebuildParent = () => {
      return rerunOnThisMachine(scope, job, input);
    };
  } else if (run.machines.has(job.id) || cacheable) {
    // A cached job is built in a run of its own, so without a snapshot its
    // work isn't on any machine here.
    const why = run.snapshotsUnavailable
      ? " · no snapshots"
      : cacheable
        ? " · no cache"
        : "";

    scope.startNote = `rebuilding ${job.id}${why}`;

    run.ci.reporter.activity(run, scope.jobPath, scope.startNote);

    await rerunOnThisMachine(scope, job, input);
  }

  return result;
}

/**
 * Without a snapshot to copy, get this machine to where the parent's finished
 * the slow way: run the parent's handler again, here. Its commands and steps
 * show in the trace under this job, and this job still gets the parent's
 * original result.
 *
 * TODO: This is a stopgap, not the design. Every job that starts from the
 * same parent repeats the parent's work, so N children means N builds. A
 * proper fix builds the parent once and has every concurrent caller wait on
 * that one build (no thundering herd), which needs reliable snapshots or a
 * shared base image to copy from.
 */
export const rerunOnThisMachine = async (
  scope: CiJobScope,
  job: AnyJob,
  input: unknown,
): Promise<void> => {
  const handler = (job as unknown as Record<symbol, unknown>)[jobHandlerKey] as
    | ((input: unknown) => Promise<unknown>)
    | undefined;

  if (!handler) {
    return;
  }

  // The parent may start from another job itself, which re-runs that one
  // here too.
  scope.fromCalled = false;

  try {
    await handler(input);
  } finally {
    scope.fromCalled = true;
  }
};
