/**
 * Starting a job from its `from` base: working out what `from` names, asking a
 * parent job's build function for a snapshot and starting from it, plus the
 * fallback that re-runs the parent's handler when no snapshot is available.
 * A base image is the other kind of base: a snapshot captured by name, looked
 * up once per run.
 *
 * A job's name includes the snapshot of the base it starts from, so a
 * parent's own base is resolved first, and its build is handed that same
 * snapshot to start from.
 *
 * @module
 */

import { NonRetriableError } from "inngest";
import type {
  BaseIdentity,
  CachedSnapshot,
  CacheTarget,
} from "../cache/cache.ts";
import {
  cacheTarget,
  deleteSnapshot,
  describeCached,
  findNamed,
  lookupParent,
  runTarget,
  warnJustInTime,
  warnUncachedBase,
} from "../cache/cache.ts";
import { CiUsageError } from "../errors.ts";
import type { BaseImage } from "../image.ts";
import { isBaseImage } from "../image.ts";
import { requestAppJob } from "../pipeline/appJob.ts";
import type { CacheBuildResult } from "../pipeline/cacheBuild.ts";
import type { RegisteredJob } from "../pipeline/job.ts";
import {
  adoptBuilt,
  describeIssues,
  invokeBuild,
  reusedBuild,
  validateInput,
} from "../pipeline/job.ts";
import { ciRun } from "../pipeline/metadata.ts";
import { ciStep, traceName } from "../pipeline/names.ts";
import type { CiJobScope, CiRunScope } from "../pipeline/scope.ts";
import {
  countApi,
  outsideJobs,
  rebuildSuffix,
  scopeSeparator,
} from "../pipeline/scope.ts";
import type { AnyJob, JobConfig, JobRef } from "../types.ts";
import { errorMessage, hash, stableStringify } from "../util.ts";

/** The jobs defined on one CI client, by ID. */
type JobRegistry = Map<string, Pick<RegisteredJob, "config" | "handler">>;

/** A `from` parent, worked out: the job's config and the input it's built with. */
export interface Parent {
  config: JobConfig;
  input: unknown;
  /**
   * The job above it with no `cache`, when that made its own `cache` unusable
   * (see `withoutUnreusableCache`).
   */
  uncachedBase?: string;
}

/** A job's parent, and the build that gave its snapshot. */
export interface ParentBuild {
  parent: Parent;
  built: CacheBuildResult;
}

/** A base image, and the snapshot it names in this pipeline run. */
export interface ImageBase {
  image: BaseImage;
  snapshot: CachedSnapshot;
}

/** What a job starts from, once resolved: a parent job's build or an image. */
export type FromBase = ParentBuild | ImageBase;

export const isImageBase = (base: FromBase): base is ImageBase => {
  return "image" in base;
};

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
const jobOwners = new WeakMap<object, JobRegistry>();

/** Record which client's registry a job was defined on. */
export const ownJob = (job: object, jobs: JobRegistry): void => {
  jobOwners.set(job, jobs);
};

/** The error for a `from` that names something that isn't a job. */
const malformedFrom = (config: Pick<JobConfig, "id">): CiUsageError => {
  return new CiUsageError(
    `The \`from\` of job "${config.id}" must name a job, a job with input from \`job.with(input)\`, or an image.`,
  );
};

/**
 * What a `from` value names, checked: a job or job ref defined on the client
 * whose registry is `jobs`.
 *
 * @throws {CiUsageError} When it names something that isn't a job of this
 * client.
 */
const resolveRef = (
  jobs: JobRegistry,
  config: Pick<JobConfig, "id">,
  named: unknown,
): {
  job: AnyJob;
  registered: Pick<RegisteredJob, "config" | "handler">;
  input: unknown;
} => {
  const ref = isJobRef(named)
    ? named
    : isJob(named)
      ? { job: named, input: undefined }
      : undefined;

  if (!ref) {
    throw malformedFrom(config);
  }

  const registered = jobs.get(ref.job.id);

  if (!registered || jobOwners.get(ref.job) !== jobs) {
    throw new CiUsageError(
      `Job "${config.id}" starts from \`${ref.job.id}\`, which isn't defined on this CI client.`,
    );
  }

  return { job: ref.job, registered, input: ref.input };
};

/**
 * Check a static `from` when the job or matrix is defined, so a mistake fails
 * when the app boots rather than mid-pipeline. A function is left to run time,
 * as is input checked by a schema that validates asynchronously.
 *
 * @throws {CiUsageError} When `from` isn't a job of this client, or its input
 * fails the parent's schema.
 */
export const checkStaticFrom = (
  jobs: JobRegistry,
  config: { id: string; from?: unknown },
): void => {
  const from = config.from;

  if (
    from === undefined ||
    isBaseImage(from) ||
    (typeof from === "function" && !isJob(from))
  ) {
    return;
  }

  const { job, registered, input } = resolveRef(jobs, config, from);
  const schema = registered.config.input;

  if (!schema || input === undefined) {
    return;
  }

  const result = schema["~standard"].validate(input);

  if (result instanceof Promise) {
    // Left to run time, which validates it again.
    result.catch(() => {});

    return;
  }

  if (result.issues) {
    throw new CiUsageError(
      `The input that job "${config.id}" gives \`${job.id}\` in \`from\` doesn't match its \`input\` schema:\n${describeIssues(result.issues)}`,
    );
  }
};

/**
 * What a job's `from` names for this call: the parent job and the input it's
 * built with, a base image, or nothing for a job without one. A job without a
 * `from` gets the client's default image, if it has one. A function is called
 * with the job's input. Pure, so a handler replaying from the top gets the
 * same answer without a step.
 *
 * @throws {CiUsageError} When `from` names something that isn't a job of this
 * client or an image.
 */
export const parentOf = (
  run: CiRunScope,
  config: JobConfig,
  /** The job's own input, already validated. */
  input: unknown,
): Parent | BaseImage | undefined => {
  const from = config.from ?? run.ci.defaultImage;

  if (from === undefined) {
    return undefined;
  }

  const named: unknown =
    typeof from === "function" && !isJob(from)
      ? (from as (ctx: { input: unknown }) => unknown)({ input })
      : from;

  if (isBaseImage(named)) {
    return named;
  }

  const ref = resolveRef(run.ci.jobs, config, named);

  return { config: ref.registered.config, input: ref.input };
};

/**
 * Throw when starting from `jobId` would bring a job back to a parent it's
 * already starting from, so a cycle fails with its path instead of recursing.
 *
 * The chain holds job IDs, not inputs, so a job that starts from itself with
 * a different input counts as a cycle too. That's coarser than it needs to be,
 * and fine until someone needs a job to build on its own other inputs.
 *
 * @throws {CiUsageError} When `jobId` is already in `chain`.
 */
const assertNoCycle = (chain: string[], jobId: string): void => {
  if (!chain.includes(jobId)) {
    return;
  }

  throw new CiUsageError(cycleMessage([...chain, jobId]));
};

/** What a cycle of `from`s says, given the jobs along it. */
export const cycleMessage = (path: string[]): string => {
  const named = path
    .map((id) => {
      return `\`${id}\``;
    })
    .join(" → ");

  return `${named} starts from itself.`;
};

/**
 * A job's `from` base, worked out: a base image as it is, or the parent job
 * with its input validated and with the cache it can actually use (see
 * `withoutUnreusableCache`).
 */
const namedParent = async (
  run: CiRunScope,
  config: JobConfig,
  /** The job's own input, already validated. */
  input: unknown,
): Promise<Parent | BaseImage | undefined> => {
  const named = parentOf(run, config, input);

  if (!named || isBaseImage(named)) {
    return named;
  }

  const validated = await validateInput(named.config, named.input);

  const usable = await withoutUnreusableCache(run, {
    config: named.config,
    input: validated,
  });

  return { ...usable, input: validated };
};

/**
 * The first job above `job` in its chain of `from` parents that has no cache,
 * if there is one. A job without a cache is built fresh in every run, so every
 * cached job below it gets a new snapshot, and a new key, each run.
 *
 * Every parent here is a job or a base image, and an image is stable like a
 * cached job, so it ends the walk.
 *
 * A chain that comes back on itself stops the walk. Resolving the chain fails
 * on it with a message of its own.
 */
const uncachedAncestorOf = async (
  run: CiRunScope,
  job: Parent,
): Promise<string | undefined> => {
  const seen = new Set([job.config.id]);
  let current = job;

  while (true) {
    const named = parentOf(run, current.config, current.input);

    if (!named || isBaseImage(named) || seen.has(named.config.id)) {
      return undefined;
    }

    if (!named.config.cache) {
      return named.config.id;
    }

    seen.add(named.config.id);

    current = {
      config: named.config,
      input: await validateInput(named.config, named.input),
    };
  }
};

/**
 * The job as it is built in this run: without its `cache` if a job above it
 * has none, and that job's ID when so.
 *
 * A job's key holds the snapshot of the parent it starts from, and a job
 * without a cache is built fresh in every run, so its snapshot is new every
 * time. Below it, a cached job's key would change in every run too: its
 * snapshot could never be found again, and a snapshot named for it would stay
 * in the environment forever, since cached snapshots are left for later runs.
 * So it is built as a job without a cache is, under a name that belongs to
 * this run. Its children in the run still start from its snapshot, and the
 * run deletes it at its end. There is no lookup or write for it in the cache.
 *
 * It says so once, in the run that asked for it.
 */
export const withoutUnreusableCache = async (
  run: CiRunScope,
  job: Parent,
): Promise<{ config: JobConfig; uncachedBase?: string }> => {
  if (!job.config.cache) {
    return { config: job.config };
  }

  const uncached = await uncachedAncestorOf(run, job);

  if (!uncached) {
    return { config: job.config };
  }

  // A build run's warnings go to the run that invoked it, which has said it.
  if (!run.build) {
    warnUncachedBase(run, job.config.id, uncached);
  }

  const { cache: _cache, ...uncachedConfig } = job.config;

  return { config: uncachedConfig, uncachedBase: uncached };
};

/** What a job's key knows of the base it starts from. */
export const identityOf = (base: FromBase): BaseIdentity => {
  if (isImageBase(base)) {
    return {
      image: imageKey(base.image),
      snapshotId: base.snapshot.snapshotId,
    };
  }

  return {
    jobId: base.parent.config.id,
    ...(base.built.snapshotId ? { snapshotId: base.built.snapshotId } : {}),
  };
};

/**
 * A job's base and its snapshot, for this call of the job, or nothing for a
 * job without a `from`. A build run is handed its job's base by the run that
 * asked for it, so it starts from exactly the snapshot its name was worked out
 * from, and never looks an image up again.
 */
export const parentBuildOf = async (
  scope: CiJobScope,
  /** The job's own input, already validated. */
  input: unknown,
): Promise<FromBase | undefined> => {
  const { run, config } = scope;
  const parent = await namedParent(run, config, input);

  if (!parent) {
    return undefined;
  }

  if (isBaseImage(parent)) {
    const handed = run.build?.jobId === config.id ? run.build.image : undefined;

    return {
      image: parent,
      snapshot: handed ?? (await resolveImage(run, parent)),
    };
  }

  const chain = [config.id];

  assertNoCycle(chain, parent.config.id);

  const given = run.build?.jobId === config.id ? run.build.base : undefined;

  return {
    parent,
    built:
      given ??
      (await resolveParent(scope, parent, [...chain, parent.config.id])),
  };
};

/**
 * Get a parent's snapshot for the job that starts from it. The job looks the
 * parent up itself, in a step of its own, and on a miss waits for the one
 * build every job that needs the parent shares.
 */
const resolveParent = async (
  scope: CiJobScope,
  parent: Parent,
  /** The jobs being started from, this job first and `parent` last. */
  chain: string[],
): Promise<CacheBuildResult> => {
  const { run } = scope;
  const { config, input } = parent;

  countApi("from");

  scope.fromJobIds.push(config.id);

  run.ci.hooks.jobFrom(scope, config.id);

  const base = await baseOf(run, parent, chain);

  run.ci.hooks.activity(run, scope.jobPath, `waiting for ${config.id}…`);

  const { target, hit } = await lookupParent(scope, {
    config,
    input,
    ...(base ? { base: identityOf(base) } : {}),
    ...(parent.uncachedBase ? { uncachedBase: parent.uncachedBase } : {}),
  });

  return requestBuild({
    run,
    config,
    input,
    target,
    ...(hit ? { hit } : {}),
    ...(base ? { base } : {}),
  });
};

/**
 * What a job's parent itself starts from, built for this pipeline run once
 * however many jobs need it. It's a parent's own base, so no job of this run
 * starts from it directly: its key, lookup and build are steps of its own. An
 * image is looked up once per run, whoever asks.
 *
 * The chain only guards against cycles. It never reaches a step ID.
 */
const baseOf = async (
  run: CiRunScope,
  parent: Parent,
  /** The jobs being started from, ending with `parent`. */
  chain: string[],
): Promise<FromBase | undefined> => {
  const grandparent = await namedParent(run, parent.config, parent.input);

  if (!grandparent) {
    return undefined;
  }

  if (isBaseImage(grandparent)) {
    return {
      image: grandparent,
      snapshot: await resolveImage(run, grandparent),
    };
  }

  assertNoCycle(chain, grandparent.config.id);

  return {
    parent: grandparent,
    built: await buildBase(run, grandparent, [...chain, grandparent.config.id]),
  };
};

/**
 * Find or build a job's snapshot that no job of this run starts from
 * directly: a parent's parent, or a job another app asked for. Its key, lookup
 * and build are steps of their own, made once per run however many ask.
 */
export const buildBase = (
  run: CiRunScope,
  parent: Parent,
  /** The jobs being started from, ending with `parent`. */
  chain: string[],
): Promise<CacheBuildResult> => {
  const { config, input } = parent;
  const path = `${buildPathOf(config.id, input)} (base)`;
  const existing = run.builds.get(path);

  if (existing) {
    return existing;
  }

  const built = outsideJobs(run, async () => {
    const base = await baseOf(run, parent, chain);
    const target = await targetOf(run, parent, base, path);

    const result = await invokeBuild({
      run,
      path: config.id,
      stepPath: path,
      config,
      input,
      target,
      ...(base ? { base } : {}),
    });

    adoptBuilt(run, result);

    // From the resolved result, so it's the same on every replay. A job whose
    // cache is unusable has none here, and has said so already.
    if (config.cache && !result.reused) {
      warnJustInTime(run, config);
    }

    return result;
  });

  run.builds.set(path, built);

  reportBuilt(run, config.id, built);

  return built;
};

/**
 * What tells one image from another, in this run and in names: a captured
 * snapshot's name, or `job:` and another app's job, so the two never meet.
 */
const imageKey = (image: BaseImage): string => {
  return image.source === "job" ? `job:${image.name}` : image.name;
};

/**
 * The snapshot a base image names, once per pipeline run per image: the first
 * job to ask makes the one step, and the rest wait on its promise, so which
 * job asks first never changes the steps the run plans. Another app's job is
 * asked of that app, and a captured image is looked up by name.
 *
 * @throws {NonRetriableError} When no ready snapshot has that name, or the
 * other app can't give one.
 */
export const resolveImage = (
  run: CiRunScope,
  image: BaseImage,
): Promise<CachedSnapshot> => {
  const key = imageKey(image);
  const existing = run.images.get(key);

  if (existing) {
    return existing;
  }

  if (image.source === "job") {
    const asked = outsideJobs(run, () => {
      return requestAppJob(run, image, `image ${key}`);
    });

    run.images.set(key, asked);

    return asked;
  }

  const resolved = outsideJobs(run, async () => {
    const found = await ciRun<CachedSnapshot | null>(
      run,
      {
        step: ciStep(
          `image ${image.name}`,
          traceName.findBaseImage(image.name),
        ),
        intent: `Find the newest ready snapshot named \`${image.name}\``,
      },
      async (note) => {
        const hit = await findNamed(run, image.name);

        note.outcome(
          hit ? { found: true, snapshotId: hit.snapshotId } : { found: false },
        );

        return hit ?? null;
      },
    );

    if (!found) {
      throw new NonRetriableError(
        `No base image named \`${image.name}\`. Capture one with \`sandbox.snapshot({ name: "${image.name}" })\`.`,
      );
    }

    return found;
  });

  run.images.set(key, resolved);

  return resolved;
};

/**
 * Start this job on a machine made from a base image's snapshot. If the
 * snapshot won't start there is nothing to rebuild it from, so the job fails
 * (see `createMachine`).
 */
const startFromImage = (scope: CiJobScope, base: ImageBase): void => {
  const { run } = scope;

  scope.fromSnapshotId = base.snapshot.snapshotId;

  scope.fromImage = base.image.name;

  scope.startNote = `starting from image ${base.image.name}`;

  run.ci.hooks.activity(run, scope.jobPath, scope.startNote);
};

/**
 * The key and name a job is built under, given what it starts from, as a
 * memoized step under `path` for a cached job.
 */
const targetOf = (
  run: CiRunScope,
  parent: Parent,
  base: FromBase | undefined,
  /** What the key step's ID is built on. */
  path: string,
): Promise<CacheTarget> | CacheTarget => {
  const { config, input } = parent;
  const identity = base ? identityOf(base) : undefined;

  return config.cache
    ? cacheTarget(run, { id: config.id, path }, config.cache, input, identity)
    : runTarget(run, config.id, input, identity);
};

/**
 * Start this job on a copy of its base's machine, before its handler runs.
 *
 * The parent runs once however many jobs start from it, in a run of its own,
 * and each child gets its own copy of its machine, so they can't affect each
 * other. The copy is made when this job runs its first command, so a job that
 * starts from another and then waits doesn't pay for a machine while it waits.
 */
export const startFrom = async (
  scope: CiJobScope,
  base: FromBase,
): Promise<void> => {
  if (isImageBase(base)) {
    startFromImage(scope, base);

    return;
  }

  const { run } = scope;
  const { parent, built } = base;
  const { config, input } = parent;

  if (built.snapshotId) {
    const snapshotId = built.snapshotId;

    scope.fromSnapshotId = snapshotId;

    scope.startNote =
      built.cached?.snapshotId === snapshotId
        ? `starting ${config.id} · ${describeCached(built.cached.createdAt)}`
        : `starting ${config.id}`;

    scope.rebuildSnapshot = async (why) => {
      // The parent's base is looked up again here, and an image may have been
      // captured again since, so the name is worked out again too: the rebuild
      // is named after what it's built on.
      const base = await baseOf(run, parent, [scope.config.id, config.id]);

      const target = await targetOf(
        run,
        parent,
        base,
        `${buildPathOf(config.id, input)}${rebuildSuffix}`,
      );

      const rebuilt = await requestBuild({
        run,
        config,
        input,
        target,
        replacing: { snapshotId, ...why },
        ...(base ? { base } : {}),
      });

      return rebuilt.snapshotId;
    };

    scope.rebuildParent = () => {
      return rerunOnThisMachine(scope, parent, [scope.config.id, config.id]);
    };
  } else if (built.hadMachine || config.cache) {
    // A cached job is built in a run of its own, so without a snapshot its
    // work isn't on any machine here. This job's own parent gave no snapshot:
    // for a cached job it wasn't found, and for any other the machine
    // couldn't be snapshotted.
    const why = config.cache ? " · no cache" : " · no snapshots";

    scope.startNote = `rebuilding ${config.id}${why}`;

    run.ci.hooks.activity(run, scope.jobPath, scope.startNote);

    await rerunOnThisMachine(scope, parent, [scope.config.id, config.id]);
  } else {
    // A parent that ran no commands has no machine to copy, but the image it
    // starts from is still where its children begin.
    const parentBase = await baseOf(run, parent, [scope.config.id, config.id]);

    if (parentBase && isImageBase(parentBase)) {
      startFromImage(scope, parentBase);
    }
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
 * snapshot that wouldn't start, shared by every child that had the trouble.
 * If the snapshot is broken, that build deletes it first.
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
  base?: FromBase;
  /** The snapshot that wouldn't start, which the build replaces. */
  replacing?: { snapshotId: string; broken: boolean; unnamed: boolean };
}): Promise<CacheBuildResult> => {
  const own = buildPathOf(config.id, input);
  const path = replacing ? `${own}${rebuildSuffix}` : own;
  const existing = run.builds.get(path);

  if (existing) {
    return existing;
  }

  const built = outsideJobs(run, async () => {
    let unnamed = replacing?.unnamed ?? false;

    // Here, not in each child, so a snapshot that every child found broken is
    // deleted once. One that can't be deleted still holds its name, so what
    // replaces it can't have one.
    if (replacing?.broken) {
      const gone = await deleteSnapshot(
        run,
        `${path}${scopeSeparator}cache:delete`,
        replacing.snapshotId,
      );

      if (!gone) {
        unnamed = true;

        run.warnings.push(
          `not cached: the broken snapshot of \`${config.id}\` couldn't be deleted, so it was rebuilt without a name and later runs build it again`,
        );
      }
    }

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
            ...(replacing
              ? {
                  exclude: replacing.snapshotId,
                  broken: replacing.broken,
                  unnamed,
                }
              : {}),
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
  /** The jobs already being started from, ending with `parent`. */
  chain: string[],
): Promise<void> => {
  const { run } = scope;
  const registered = run.ci.jobs.get(parent.config.id);

  if (!registered) {
    return;
  }

  const grandparent = await namedParent(run, parent.config, parent.input);

  if (grandparent && isBaseImage(grandparent)) {
    // An image is a machine, not a handler, so it can only be where the
    // machine starts.
    if (scope.machine) {
      throw new NonRetriableError(
        `\`${parent.config.id}\` starts from image \`${grandparent.name}\`, which can't be applied to a machine that already started.`,
      );
    }

    startFromImage(scope, {
      image: grandparent,
      snapshot: await resolveImage(run, grandparent),
    });
  } else if (grandparent) {
    assertNoCycle(chain, grandparent.config.id);

    const through = [...chain, grandparent.config.id];

    // Before the machine exists, it can still start from the grandparent's
    // snapshot. After, as when a snapshot wouldn't start, the grandparent has
    // to run here too.
    if (scope.machine) {
      await rerunOnThisMachine(scope, grandparent, through);
    } else {
      await startFrom(scope, {
        parent: grandparent,
        built: await resolveParent(scope, grandparent, through),
      });
    }
  }

  await registered.handler(parent.input);
};
