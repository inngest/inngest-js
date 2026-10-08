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
  describeCached,
  findNamed,
  lookupParent,
  runTarget,
} from "../cache/cache.ts";
import { CiUsageError } from "../errors.ts";
import type { BaseImage } from "../image.ts";
import { isBaseImage } from "../image.ts";
import { requestAppJob } from "../pipeline/appJob.ts";
import type { CacheBuildResult } from "../pipeline/cacheBuild.ts";
import {
  adoptBuilt,
  invokeBuild,
  reusedBuild,
  validateInput,
} from "../pipeline/job.ts";
import { ciRun } from "../pipeline/metadata.ts";
import { ciStep, traceName } from "../pipeline/names.ts";
import type { CiJobScope, CiRunScope } from "../pipeline/scope.ts";
import { countApi, outsideJobs, rebuildSuffix } from "../pipeline/scope.ts";
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

  const ref = isJobRef(named)
    ? named
    : isJob(named)
      ? { job: named, input: undefined }
      : undefined;

  if (!ref) {
    throw new CiUsageError(
      `The \`from\` of job "${config.id}" must name a job, a job with input from \`job.with(input)\`, or an image.`,
    );
  }

  const registered = run.ci.jobs.get(ref.job.id);

  if (!registered) {
    throw new CiUsageError(
      `Job "${config.id}" starts from \`${ref.job.id}\`, which isn't defined on this CI client.`,
    );
  }

  return { config: registered.config, input: ref.input };
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
  const named = parentOf(run, config, input);

  if (!named) {
    return undefined;
  }

  if (isBaseImage(named)) {
    const handed = run.build?.jobId === config.id ? run.build.image : undefined;

    return {
      image: named,
      snapshot: handed ?? (await resolveImage(run, named)),
    };
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
    ...(base ? { base: identityOf(base) } : {}),
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
 */
const baseOf = async (
  run: CiRunScope,
  parent: Parent,
): Promise<FromBase | undefined> => {
  const named = parentOf(run, parent.config, parent.input);

  if (!named) {
    return undefined;
  }

  if (isBaseImage(named)) {
    return { image: named, snapshot: await resolveImage(run, named) };
  }

  const grandparent = {
    config: named.config,
    input: await validateInput(named.config, named.input),
  };

  return { parent: grandparent, built: await buildBase(run, grandparent) };
};

/**
 * Find or build a job's snapshot that no job of this run starts from
 * directly: a parent's parent, or a job another app asked for. Its key, lookup
 * and build are steps of their own, made once per run however many ask.
 */
export const buildBase = (
  run: CiRunScope,
  parent: Parent,
): Promise<CacheBuildResult> => {
  const { config, input } = parent;
  const path = `${buildPathOf(config.id, input)} (base)`;
  const existing = run.builds.get(path);

  if (existing) {
    return existing;
  }

  const built = outsideJobs(run, async () => {
    const base = await baseOf(run, parent);
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

    scope.rebuildSnapshot = async () => {
      // The parent's base is looked up again here, and an image may have been
      // captured again since, so the name is worked out again too: the rebuild
      // is named after what it's built on.
      const base = await baseOf(run, parent);

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
        replacing: { snapshotId },
        ...(base ? { base } : {}),
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
  } else {
    // A parent that ran no commands has no machine to copy, but the image it
    // starts from is still where its children begin.
    const parentBase = await baseOf(run, parent);

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
  base?: FromBase;
  /** The bad snapshot the build replaces. */
  replacing?: { snapshotId: string };
}): Promise<CacheBuildResult> => {
  const own = buildPathOf(config.id, input);
  const path = replacing ? `${own}${rebuildSuffix}` : own;
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
            ...(base ? { base } : {}),
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

  if (named && isBaseImage(named)) {
    // An image is a machine, not a handler, so it can only be where the
    // machine starts.
    if (scope.machine) {
      throw new NonRetriableError(
        `\`${parent.config.id}\` starts from image \`${named.name}\`, which can't be applied to a machine that already started.`,
      );
    }

    startFromImage(scope, {
      image: named,
      snapshot: await resolveImage(run, named),
    });
  } else if (named) {
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
