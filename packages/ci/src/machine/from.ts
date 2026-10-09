/**
 * Starting a job from its `from` parent's machine: working out what `from`
 * names, asking the parent's build function for a snapshot and starting from
 * it, plus the fallback that re-runs the parent's handler when no snapshot is
 * available.
 *
 * A job's name includes the snapshot of the parent it starts from, so a
 * parent's own parent is resolved first, and its build is handed that same
 * snapshot to start from.
 *
 * @module
 */

import type {
  BaseIdentity,
  CachedSnapshot,
  CacheTarget,
} from "../cache/cache.ts";
import {
  cacheTarget,
  describeCached,
  lookupParent,
  runTarget,
} from "../cache/cache.ts";
import { CiUsageError } from "../errors.ts";
import type { CacheBuildResult } from "../pipeline/cacheBuild.ts";
import {
  adoptBuilt,
  invokeBuild,
  reusedBuild,
  validateInput,
} from "../pipeline/job.ts";
import type { CiJobScope, CiRunScope } from "../pipeline/scope.ts";
import { countApi, rebuildSuffix } from "../pipeline/scope.ts";
import type { AnyJob, JobConfig, JobRef } from "../types.ts";
import { errorMessage, hash, stableStringify } from "../util.ts";

/** A `from` parent, worked out: the job's config and the input it's built with. */
export interface Parent {
  config: JobConfig;
  input: unknown;
}

/** A job's parent, and the build that gave its snapshot. */
export interface ParentBuild {
  parent: Parent;
  built: CacheBuildResult;
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
  /** The job's own input, already validated. */
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

/** What a job's key knows of the parent it starts from. */
export const identityOf = (
  jobId: string,
  built: CacheBuildResult,
): BaseIdentity => {
  return {
    jobId,
    ...(built.snapshotId ? { snapshotId: built.snapshotId } : {}),
  };
};

/**
 * A job's parent and its snapshot, for this call of the job, or nothing for a
 * job without a `from`. A build run is handed its job's parent by the run
 * that asked for it, so it starts from exactly the snapshot its name was
 * worked out from.
 */
export const parentBuildOf = async (
  scope: CiJobScope,
  /** The job's own input, already validated. */
  input: unknown,
): Promise<ParentBuild | undefined> => {
  const { run, config } = scope;
  const named = parentOf(run, config, input);

  if (!named) {
    return undefined;
  }

  const parent = {
    config: named.config,
    input: await validateInput(named.config, named.input),
  };

  const given = run.build?.jobId === config.id ? run.build.base : undefined;

  return { parent, built: given ?? (await resolveParent(scope, parent)) };
};

/**
 * Get a parent's snapshot for the job that starts from it. The job looks the
 * parent up itself, in a step of its own, and on a miss waits for the one
 * build every job that needs the parent shares.
 */
const resolveParent = async (
  scope: CiJobScope,
  parent: Parent,
): Promise<CacheBuildResult> => {
  const { run } = scope;
  const { config, input } = parent;

  countApi("from");

  scope.fromJobIds.push(config.id);

  run.ci.hooks.jobFrom(scope, config.id);

  const base = await baseOf(run, parent);

  run.ci.hooks.activity(run, scope.jobPath, `waiting for ${config.id}…`);

  const { target, hit } = await lookupParent(scope, {
    config,
    input,
    ...(base ? { base: identityOf(base.parent.config.id, base.built) } : {}),
  });

  return requestBuild({
    run,
    config,
    input,
    target,
    ...(hit ? { hit } : {}),
    ...(base ? { base: base.built } : {}),
  });
};

/**
 * What a job's parent itself starts from, built for this pipeline run once
 * however many jobs need it. It's a parent's parent, so no job of this run
 * starts from it directly: its key, lookup and build are steps of its own.
 */
const baseOf = async (
  run: CiRunScope,
  parent: Parent,
): Promise<ParentBuild | undefined> => {
  const named = parentOf(run, parent.config, parent.input);

  if (!named) {
    return undefined;
  }

  const grandparent = {
    config: named.config,
    input: await validateInput(named.config, named.input),
  };

  return { parent: grandparent, built: await buildBase(run, grandparent) };
};

const buildBase = (
  run: CiRunScope,
  parent: Parent,
): Promise<CacheBuildResult> => {
  const { config, input } = parent;
  const path = `${buildPathOf(config.id, input)} (base)`;
  const existing = run.builds.get(path);

  if (existing) {
    return existing;
  }

  const built = (async () => {
    const base = await baseOf(run, parent);
    const identity = base
      ? identityOf(base.parent.config.id, base.built)
      : undefined;

    const target = config.cache
      ? await cacheTarget(
          run,
          { id: config.id, path },
          config.cache,
          input,
          identity,
        )
      : runTarget(run, config.id, input, identity);

    const result = await invokeBuild({
      run,
      path: config.id,
      stepPath: path,
      config,
      input,
      target,
      ...(base ? { base: base.built } : {}),
    });

    adoptBuilt(run, result);

    return result;
  })();

  run.builds.set(path, built);

  reportBuilt(run, config.id, built);

  return built;
};

/**
 * Start this job on a copy of its parent's machine, before its handler runs.
 *
 * The parent runs once however many jobs start from it, in a run of its own,
 * and each child gets its own copy of its machine, so they can't affect each
 * other. The copy is made when this job runs its first command, so a job that
 * starts from another and then waits doesn't pay for a machine while it waits.
 */
export const startFrom = async (
  scope: CiJobScope,
  { parent, built }: ParentBuild,
): Promise<void> => {
  const { run } = scope;
  const { config, input } = parent;

  if (built.snapshotId) {
    const snapshotId = built.snapshotId;

    scope.fromSnapshotId = snapshotId;

    scope.startNote =
      built.cached?.snapshotId === snapshotId
        ? `starting ${config.id} · ${describeCached(built.cached.createdAt)}`
        : `starting ${config.id}`;

    scope.rebuildSnapshot = async () => {
      const base = await baseOf(run, parent);

      const rebuilt = await requestBuild({
        run,
        config,
        input,
        target: built.target,
        replacing: { snapshotId },
        ...(base ? { base: base.built } : {}),
      });

      return rebuilt.snapshotId;
    };

    scope.rebuildParent = () => {
      return rerunOnThisMachine(scope, parent);
    };
  } else if (built.hadMachine || config.cache) {
    // A cached job is built in a run of its own, so without a snapshot its
    // work isn't on any machine here. This job's own parent gave no snapshot:
    // for a cached job it wasn't found, and for any other the machine
    // couldn't be snapshotted.
    const why = config.cache ? " · no cache" : " · no snapshots";

    scope.startNote = `rebuilding ${config.id}${why}`;

    run.ci.hooks.activity(run, scope.jobPath, scope.startNote);

    await rerunOnThisMachine(scope, parent);
  }
};

/**
 * What the build of a `from` parent is called in step IDs: the job's ID, plus
 * a hash of its input when it has one, so builds of one job with different
 * inputs are different builds. No job of the run has a path like it.
 */
const buildPathOf = (jobId: string, input: unknown): string => {
  const suffix =
    input === undefined ? "" : ` #${hash(stableStringify(input), 8)}`;

  return `${jobId}${suffix} (from)`;
};

/**
 * Ask for a `from` parent's snapshot, after the asking child looked it up by
 * name: the hit it found, or, on a miss, a build run of its own. Children of
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
  base,
  replacing,
}: {
  run: CiRunScope;
  config: JobConfig;
  input: unknown;
  /** The parent's key and snapshot name, which every child worked out alike. */
  target: CacheTarget;
  /** The snapshot the asking child found, when it found one. */
  hit?: CachedSnapshot;
  /** What the parent starts from, which its build must start from too. */
  base?: CacheBuildResult;
  /** The bad snapshot the build replaces. */
  replacing?: { snapshotId: string };
}): Promise<CacheBuildResult> => {
  const own = buildPathOf(config.id, input);
  const path = replacing ? `${own}${rebuildSuffix}` : own;
  const existing = run.builds.get(path);

  if (existing) {
    return existing;
  }

  const built = (async () => {
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
            ...(base ? { base } : {}),
            ...(replacing ? { exclude: replacing.snapshotId } : {}),
          });

    adoptBuilt(run, result);

    return result;
  })();

  run.builds.set(path, built);

  if (!replacing) {
    reportBuilt(run, config.id, built);
  }

  return built;
};

/**
 * Say how a parent's build ended, where the build itself can't: its row in the
 * pipeline's summary and in the hooks. Each is made once however many jobs
 * start from the parent, or have it further up their chain.
 */
const reportBuilt = (
  run: CiRunScope,
  jobId: string,
  built: Promise<CacheBuildResult>,
): void => {
  built.then(
    (result) => {
      const summary = result.summary;

      const known = run.summaries.some((candidate) => {
        return candidate.path === summary?.path;
      });

      if (summary && !known) {
        run.summaries.push(summary);
      }

      run.ci.hooks.jobEnded(
        run,
        jobId,
        result.reused ? "cached" : "passed",
        summary?.title,
      );
    },
    (error: unknown) => {
      run.ci.hooks.jobEnded(run, jobId, "failed", errorMessage(error));
    },
  );
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

  const named = parentOf(run, parent.config, parent.input);

  if (named) {
    const grandparent = {
      config: named.config,
      input: await validateInput(named.config, named.input),
    };

    // Before the machine exists, it can still start from the grandparent's
    // snapshot. After, as when a snapshot wouldn't start, the grandparent has
    // to run here too.
    if (scope.machine) {
      await rerunOnThisMachine(scope, grandparent);
    } else {
      await startFrom(scope, {
        parent: grandparent,
        built: await resolveParent(scope, grandparent),
      });
    }
  }

  await registered.handler(parent.input);
};
