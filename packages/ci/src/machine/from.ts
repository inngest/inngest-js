/**
 * Starting a job from another job's machine: `from()`, which asks the
 * parent's build function for a snapshot and starts from it, plus the fallback
 * that re-runs the parent's handler when no snapshot is available.
 *
 * @module
 */

import type { CachedSnapshot, CacheTarget } from "../cache/cache.ts";
import { describeCached, lookupParent } from "../cache/cache.ts";
import { CiUsageError } from "../errors.ts";
import type { CacheBuildResult } from "../pipeline/cacheBuild.ts";
import {
  adoptBuilt,
  invokeBuild,
  reusedBuild,
  validateInput,
} from "../pipeline/job.ts";
import type { CiJobScope, CiRunScope } from "../pipeline/scope.ts";
import {
  countApi,
  jobHandlerKey,
  outsideJobs,
  rebuildSuffix,
  requireJobScope,
} from "../pipeline/scope.ts";
import type { AnyJob, Job, JobConfig } from "../types.ts";
import { errorMessage, hash, stableStringify } from "../util.ts";

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Start this job on a copy of another job's machine.
 *
 * The parent runs once however many jobs start from it, in a run of its own,
 * and each child gets its own copy of its machine, so they can't affect each
 * other. The copy is made when this job runs its first command, so a job that
 * starts from another and then waits doesn't pay for a machine while it waits.
 *
 * `from()` shares a parent's build within one pipeline run. Only a `cache` key
 * on the parent reuses it across runs.
 *
 * The snapshot behind the copy is deleted when the pipeline run ends, unless
 * the parent is cached under a name (the cache keeps it for later runs).
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
 * own machine every time it's called, the second starts this job from the one
 * shared build of setup. A job that is both called and started from builds
 * twice.
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

  const { run } = scope;

  run.ci.hooks.jobFrom(scope, job.id);

  const registered = run.ci.jobs.get(job.id);

  if (!registered) {
    throw new CiUsageError(
      `Job \`${job.id}\` isn't registered on this client.`,
    );
  }

  const { config } = registered;
  const given = await validateInput(config, input);

  if (given !== undefined) {
    scope.parentInputs[job.id] = given;
  }

  run.ci.hooks.activity(run, scope.jobPath, `waiting for ${job.id}…`);

  const { target, hit } = await lookupParent(scope, { config, input: given });

  const built = await requestBuild({ run, config, input: given, target, hit });

  scope.fromBuilt[job.id] = built;

  if (built.snapshotId) {
    const snapshotId = built.snapshotId;

    scope.fromSnapshotId = snapshotId;

    scope.startNote =
      built.cached?.snapshotId === snapshotId
        ? `starting ${job.id} · ${describeCached(built.cached.createdAt)}`
        : `starting ${job.id}`;

    scope.rebuildSnapshot = async () => {
      const rebuilt = await requestBuild({
        run,
        config,
        input: given,
        target: built.target,
        replacing: { snapshotId },
      });

      scope.fromBuilt[job.id] = rebuilt;

      return rebuilt.snapshotId;
    };

    scope.rebuildParent = () => {
      return rerunOnThisMachine(scope, job, given);
    };
  } else if (built.hadMachine || config.cache) {
    // A cached job is built in a run of its own, so without a snapshot its
    // work isn't on any machine here. This job's own parent gave no snapshot:
    // for a cached job it wasn't found, and for any other the machine
    // couldn't be snapshotted.
    const why = config.cache ? " · no cache" : " · no snapshots";

    scope.startNote = `rebuilding ${job.id}${why}`;

    run.ci.hooks.activity(run, scope.jobPath, scope.startNote);

    await rerunOnThisMachine(scope, job, given);
  }
}

/**
 * What a build asked for by `from()` is called in step IDs: the
 * job's ID, plus a hash of its input when it has one, so builds of one job
 * with different inputs are different builds. No job of the run has a path
 * like it.
 */
const buildPathOf = (jobId: string, input: unknown): string => {
  const suffix =
    input === undefined ? "" : ` #${hash(stableStringify(input), 8)}`;

  return `${jobId}${suffix} (from)`;
};

/**
 * Ask for a `from()` parent's snapshot, after the asking child looked it up
 * by name: the hit it found, or, on a miss, a build run of its own. Children of
 * one parent share one invoke, which `run.builds` holds as a promise, so
 * whichever child comes first makes no difference to the steps the run plans.
 *
 * A parent without a `cache` is built under a name that belongs to this
 * pipeline run: the build function runs one build at a time per name and looks
 * it up before it builds, so a second invoke of the same build in this run
 * finds the first's snapshot instead of making another.
 *
 * With `replacing`, it's the one build of the same parent that replaces a
 * snapshot that wouldn't start, shared by every child that found it bad.
 */
const requestBuild = ({
  run,
  config,
  input,
  target,
  hit,
  replacing,
}: {
  run: CiRunScope;
  config: JobConfig;
  input: unknown;
  /** The parent's key and snapshot name, which every child worked out alike. */
  target: CacheTarget;
  /** The snapshot the asking child found, when it found one. */
  hit?: CachedSnapshot;
  /** The bad snapshot the build replaces. */
  replacing?: { snapshotId: string };
}): Promise<CacheBuildResult> => {
  const base = buildPathOf(config.id, input);
  const path = replacing ? `${base}${rebuildSuffix}` : base;
  const existing = run.builds.get(path);

  if (existing) {
    return existing;
  }

  const built = outsideJobs(run, async () => {
    // Every child that asked has just looked the snapshot up itself, so the
    // build function is the only guard left against a build that raced it.
    const result =
      hit && !replacing
        ? reusedBuild(config, target, hit)
        : await invokeBuild({
            run,
            path: config.id,
            stepPath: path,
            config,
            input,
            target,
            lookup: false,
            ...(replacing ? { exclude: replacing.snapshotId } : {}),
          });

    adoptBuilt(run, result);

    return result;
  });

  run.builds.set(path, built);

  if (!replacing) {
    reportBuilt(run, config.id, built);
  }

  return built;
};

/**
 * Say how a parent's build ended, where the build itself can't: its row in the
 * pipeline's summary and in the local CLI. Each is made once however many jobs
 * start from the parent.
 */
const reportBuilt = (
  run: CiRunScope,
  jobId: string,
  built: Promise<CacheBuildResult>,
): void => {
  built.then(
    (result) => {
      if (result.summary) {
        run.summaries.push(result.summary);
      }

      run.ci.hooks.jobEnded(
        run,
        jobId,
        result.reused ? "cached" : "passed",
        result.summary?.title,
      );
    },
    (error: unknown) => {
      run.ci.hooks.jobEnded(run, jobId, "failed", errorMessage(error));
    },
  );
};

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
