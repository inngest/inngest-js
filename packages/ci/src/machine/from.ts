/**
 * Starting a job from another job's machine: `from()`, plus the fallback that
 * re-runs the parent's handler when no snapshot is available.
 *
 * @module
 */

import { CiUsageError } from "../errors.ts";
import { joinJob } from "../pipeline/job.ts";
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
 * its own copy, so they can't affect each other. If the parent was already
 * called directly, `from()` uses that run instead of starting another. The copy is made when this
 * job runs its first command, so a job that starts from another and then
 * waits doesn't pay for a machine while it waits.
 *
 * `from()` shares a job's machine within one run. Only a `cache` key on the
 * parent reuses it across runs.
 *
 * The snapshot behind the copy is deleted when the pipeline run ends, unless
 * the parent is cached (the cache keeps it for later runs) or fails with
 * `keepOnFailure`.
 *
 * ```ts
 * const setup = ci.job("setup", async () => {
 *   await checkout();
 *   await $`pnpm install`;
 * });
 *
 * const test = ci.job("test", async () => {
 *   await from(setup);   // runs `setup` first
 *   await $`pnpm test`;  // runs on a copy of its machine
 * });
 * ```
 *
 * `await setup()` and `await from(setup)` differ: the first runs setup on its
 * own machine every time it's called, the second joins the one shared run of
 * setup *and* starts this job from where it finished.
 *
 * @throws {CiUsageError} When called outside a job, after this job's first
 * command, or a second time.
 */
export async function from(
  /** The job to start from. */
  job: Job,
): Promise<void>;
export async function from<TInput>(
  /** The job to start from. */
  job: Job<TInput>,
  /** The parent's input, when it takes one. */
  input: TInput,
): Promise<void>;
export async function from(job: AnyJob, input?: unknown): Promise<void> {
  const scope = requireJobScope("from");

  countApi("from");

  if (scope.machine || scope.fromCalled) {
    throw new CiUsageError(
      "`from()` must come before this job's first command, and can only be called once.",
    );
  }

  scope.fromCalled = true;

  scope.fromJobIds.push(job.id);

  const children = scope.run.fromChildren.get(job.id) ?? new Set<string>();

  children.add(scope.jobPath);
  scope.run.fromChildren.set(job.id, children);

  if (input !== undefined) {
    scope.fromInputs[job.id] = input;
  }

  await joinJob({ id: job.id, input });

  const snapshotId = await snapshotJob(scope.run, job.id);

  if (snapshotId) {
    scope.fromSnapshotId = snapshotId;
  } else if (
    scope.run.machines.has(job.id) ||
    scope.run.cacheEntries.has(job.id)
  ) {
    await rerunOnThisMachine(scope, job, input);
  }
}

/**
 * Without a snapshot to copy, get this machine to where the parent's finished
 * the slow way: run the parent's handler again, here. Its commands and steps
 * show in the trace under this job, and this job doesn't run the
 * parent's job again.
 *
 * TODO: This is a stopgap, not the design. Every job that starts from the
 * same parent repeats the parent's work, so N children means N builds. A
 * proper fix builds the parent once and has every concurrent caller wait on
 * that one build (no thundering herd), which needs reliable snapshots or a
 * shared base image to copy from.
 */
const rerunOnThisMachine = async (
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
