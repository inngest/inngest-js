/**
 * Starting a job from its `from` base: working out what `from` names, asking
 * a parent job's build function for a snapshot and starting from it, plus the
 * fallback that re-runs the parent's handler when no snapshot is available. A
 * base image is the other kind of base: a snapshot captured by name, which
 * the run looks up once.
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
  runTarget,
  warnUncachedBase,
} from "../cache/cache.ts";
import type { NamePolicy } from "../cache/namePolicy.ts";
import { deletesHolder } from "../cache/namePolicy.ts";
import { CiUsageError } from "../errors.ts";
import type { BaseImage } from "../image.ts";
import { imageKey, isBaseImage } from "../image.ts";
import { requestAppJob } from "../pipeline/appJob.ts";
import type { CacheBuildResult } from "../pipeline/cacheBuild.ts";
import type { RegisteredJob } from "../pipeline/job.ts";
import {
  adoptBuilt,
  describeIssues,
  invokeBuild,
  validateInput,
} from "../pipeline/job.ts";
import { ciRun } from "../pipeline/metadata.ts";
import { steps } from "../pipeline/names.ts";
import type { CiJobScope, CiRunScope } from "../pipeline/scope.ts";
import {
  countApi,
  isInline,
  joinId,
  outsideJobs,
  rebuildSuffix,
} from "../pipeline/scope.ts";
import type { AnyJob, JobConfig, JobRef } from "../types.ts";
import { errorMessage, hash, stableStringify } from "../util.ts";

/** The jobs defined on one CI client, by ID. */
type JobRegistry = Map<string, Pick<RegisteredJob, "config" | "handler">>;

/** A `from` parent, worked out: the job's config and the input it's built with. */
export interface Parent {
  config: JobConfig;
  /** The input the job is built with, after its schema. */
  input: unknown;
  /**
   * The input as `from` named it, before the schema: what a build is sent, so
   * its run validates it again rather than trusting the invoker's output.
   */
  raw: unknown;
}

/**
 * What a job starts from, the one record everything reads: a parent job or a
 * base image, the build that gave the snapshot, and what the job's own key
 * knows of both. Whoever starts from it, names itself after it or hands it to
 * a build reads these fields and never asks which kind it is.
 */
export interface ResolvedBase {
  /** The parent's job ID, or the image's name. */
  id: string;
  /**
   * The parent job. An image has none, which also means there is nothing to
   * rebuild it with, or to re-run on a machine that has started.
   */
  parent?: Parent;
  built: CacheBuildResult;
  identity: BaseIdentity;
}

/** What a `from` names: a parent job, or a base image. */
type Named = Parent | BaseImage;

/** What a name resolved to, with the build that gave its snapshot. */
const resolvedBase = (named: Named, built: CacheBuildResult): ResolvedBase => {
  const snapshot = built.snapshotId ? { snapshotId: built.snapshotId } : {};

  if (isBaseImage(named)) {
    return {
      id: named.name,
      built,
      identity: { from: `image:${imageKey(named)}`, ...snapshot },
    };
  }

  return {
    id: named.config.id,
    parent: named,
    built,
    identity: { from: named.config.id, ...snapshot },
  };
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
    throw new CiUsageError(
      `The \`from\` of job "${config.id}" must name a job, a job with input from \`job.with(input)\`, or an image.`,
    );
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
 * built with, a base image, or nothing for a job without one. A function is
 * called with the job's input. Pure, so a handler replaying from the top gets
 * the same answer without a step.
 *
 * @throws {CiUsageError} When `from` names something that isn't a job of this
 * client or an image.
 */
export const parentOf = (
  run: CiRunScope,
  config: JobConfig,
  /** The job's own input, already validated. */
  input: unknown,
): Named | undefined => {
  const from = config.from;

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

  return {
    config: ref.registered.config,
    input: ref.input,
    raw: ref.input,
  };
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
 * Whether a job has to be built in this run: it was defined here, or its
 * parent was, and either way the build function couldn't find it.
 */
export const buildsInRun = (
  config: JobConfig,
  /** The job's `from` parent, if it has one. */
  parent: Parent | undefined,
): boolean => {
  return isInline(config) || (parent ? isInline(parent.config) : false);
};

/**
 * The jobs above a job, nearest first: its `from` parent, that job's parent,
 * and so on, each with its input validated. The one walk of `from`, so every
 * question about the chain is asked of this list.
 *
 * A cycle is judged by job ID, not input, so a job that starts from itself with
 * a different input counts as one. That's coarser than it needs to be, and fine
 * until someone needs a job to build on its own other inputs.
 *
 * @throws {CiUsageError} When `from` names something that isn't a job of this
 * client, or a job comes back on itself, naming the path.
 */
const walkParents = async (
  run: CiRunScope,
  config: JobConfig,
  /** The job's own input, already validated. */
  input: unknown,
): Promise<Parent[]> => {
  const parents: Parent[] = [];
  const path = [config.id];
  let current: Pick<Parent, "config" | "input"> = { config, input };

  while (true) {
    const named = parentOf(run, current.config, current.input);

    // An image is where a chain ends: it is no job to build or to cycle.
    if (!named || isBaseImage(named)) {
      return parents;
    }

    if (path.includes(named.config.id)) {
      throw new CiUsageError(cycleMessage([...path, named.config.id]));
    }

    path.push(named.config.id);

    current = {
      config: named.config,
      input: await validateInput(named.config, named.input),
    };

    parents.push({ ...current, raw: named.raw });
  }
};

/**
 * The job as it is built in this run: without its `cache` if a job above it
 * has none.
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
const reusableConfig = (
  run: CiRunScope,
  config: JobConfig,
  /** The jobs above it, nearest first, as `walkParents` found them. */
  above: readonly Parent[],
): JobConfig => {
  // Every parent here is a job, so each is either cached or not. A base image
  // is stable like a cached job, and ends the chain before it gets here.
  const uncached = above.find((parent) => {
    return !parent.config.cache;
  });

  if (!config.cache || !uncached) {
    return config;
  }

  // A build run's warnings go to the run that invoked it, which has said it.
  if (!run.build) {
    warnUncachedBase(run, config.id, uncached.config.id);
  }

  const { cache: _cache, ...uncachedConfig } = config;

  return uncachedConfig;
};

/**
 * The jobs above a job as they are built in this run, nearest first (see
 * `reusableConfig`). Pure, so a handler replaying from the top gets the same
 * answer without a step.
 *
 * @throws {CiUsageError} When `from` names something that isn't a job of this
 * client, or the chain comes back on itself.
 */
export const ancestry = async (
  run: CiRunScope,
  config: JobConfig,
  /** The job's own input, already validated. */
  input: unknown,
): Promise<Parent[]> => {
  const parents = await walkParents(run, config, input);

  return parents.map((parent, index) => {
    return {
      ...parent,
      config: reusableConfig(run, parent.config, parents.slice(index + 1)),
    };
  });
};

/** The job as it is built in this run (see `reusableConfig`). */
export const withoutUnreusableCache = async (
  run: CiRunScope,
  config: JobConfig,
  /** The job's own input, already validated. */
  input: unknown,
): Promise<JobConfig> => {
  return reusableConfig(run, config, await walkParents(run, config, input));
};

/**
 * What a job's `from` names, as `ancestry` found it: its parent job, or the
 * image that ended an empty chain.
 */
const namedBase = async (
  run: CiRunScope,
  config: JobConfig,
  input: unknown,
): Promise<Named | undefined> => {
  const [parent] = await ancestry(run, config, input);

  return parent ?? parentOf(run, config, input);
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
): Promise<ResolvedBase | undefined> => {
  const { run, config } = scope;
  const named = await namedBase(run, config, input);

  if (!named) {
    return undefined;
  }

  return resolvedBase(
    named,
    scope.request?.base ??
      (await buildNamed(run, named, (parent) => {
        return resolveParent(scope, parent);
      })),
  );
};

/**
 * Get a parent's snapshot for the job that starts from it: the one build of
 * that parent this pipeline run shares, which looks the snapshot up and, on a
 * miss, invokes the build function.
 */
const resolveParent = (
  scope: CiJobScope,
  parent: Parent,
): Promise<CacheBuildResult> => {
  const { run } = scope;
  const { config } = parent;

  countApi("from");

  scope.fromJobIds.push(config.id);

  run.ci.hooks.jobFrom(scope, config.id);
  run.ci.hooks.activity(run, scope.jobPath, `waiting for ${config.id}…`);

  return buildOf(run, parent);
};

/**
 * What a job's parent itself starts from, built for this pipeline run once
 * however many jobs need it. It's a parent's own base, so no job of this run
 * starts from it directly: its key, lookup and build are steps of its own.
 */
const baseOf = async (
  run: CiRunScope,
  parent: Parent,
): Promise<ResolvedBase | undefined> => {
  const named = await namedBase(run, parent.config, parent.input);

  if (!named) {
    return undefined;
  }

  return resolvedBase(named, await buildNamed(run, named));
};

/**
 * The build of what a `from` names in this pipeline run: a parent job's, or an
 * image's snapshot. A parent job is built the way `buildJob` says, which is
 * the run's shared build unless the caller is a job that counts it as its own.
 */
const buildNamed = (
  run: CiRunScope,
  named: Named,
  buildJob: (parent: Parent) => Promise<CacheBuildResult> = (parent) => {
    return buildOf(run, parent);
  },
): Promise<CacheBuildResult> => {
  return isBaseImage(named) ? imageBuildOf(run, named) : buildJob(named);
};

/**
 * The build of a `from` parent in this pipeline run, which every job that needs
 * the parent shares: a job that starts from it, and any job whose chain of
 * parents passes through it. `run.builds` holds it as a promise under the
 * parent's identity (its job and input), so the first to ask makes it and the
 * rest, in this run and after it resolves, await the same one. Its key, lookup
 * and invoke are steps of the parent's own, not of whichever job asked first,
 * so the steps the run plans don't depend on the order jobs ask in.
 *
 * Within a pipeline run a parent is built once. Across concurrent runs that
 * miss at the same time it is best-effort: each may invoke its own build, at
 * most one snapshot keeps the name and the rest adopt it.
 *
 * A parent without a `cache` is built under a name that belongs to this
 * pipeline run, which a second build anywhere in the run finds rather than
 * makes again.
 *
 * Exported for `answerAppJob`, which builds a job another app asked for the
 * same way.
 */
export const buildOf = (
  run: CiRunScope,
  parent: Parent,
): Promise<CacheBuildResult> => {
  const { config, input, raw } = parent;
  const path = buildPathOf(config.id, input);
  const existing = run.builds.get(path);

  if (existing) {
    return existing;
  }

  const built = outsideJobs(run, async () => {
    const base = await baseOf(run, parent);

    const target = config.cache
      ? await cacheTarget(
          run,
          { id: config.id, path },
          config.cache,
          input,
          base?.identity,
        )
      : runTarget(run, config.id, input, base?.identity);

    const result = await invokeBuild({
      run,
      path: config.id,
      stepPath: path,
      config,
      input: raw,
      target,
      ...(base ? { base: base.built } : {}),
    });

    adoptBuilt(run, result);

    return result;
  });

  run.builds.set(path, built);

  reportBuilt(run, config.id, built);

  return built;
};

/**
 * A base image as a build that was already done, found once per pipeline run
 * however many jobs start from it. It lives in `run.builds` beside the
 * parents' builds, so the first job to ask makes the one step and the rest wait
 * on its promise, and which job asks first never changes the steps the run
 * plans.
 *
 * @throws {NonRetriableError} When the image can't be found or built.
 */
const imageBuildOf = (
  run: CiRunScope,
  image: BaseImage,
): Promise<CacheBuildResult> => {
  const stepId = `image ${imageKey(image)}`;
  const existing = run.builds.get(stepId);

  if (existing) {
    return existing;
  }

  const built = outsideJobs(run, () => {
    return resolveImage(run, image, stepId);
  });

  run.builds.set(stepId, built);

  return built;
};

/**
 * Where each kind of image comes from. A new kind is a new case here, and the
 * rest of a run only ever sees the build it gives back.
 */
const resolveImage = (
  run: CiRunScope,
  image: BaseImage,
  stepId: string,
): Promise<CacheBuildResult> => {
  switch (image.source) {
    case "snapshot":
      return findSnapshotImage(run, image.name, stepId);
    case "job":
      return requestAppJob(run, image, stepId);
  }
};

/** A captured snapshot: the newest ready one with exactly this name. */
const findSnapshotImage = async (
  run: CiRunScope,
  name: string,
  stepId: string,
): Promise<CacheBuildResult> => {
  const found = await ciRun(
    run,
    steps.findBaseImage(stepId, name),
    async () => {
      return (await findNamed(run, name)) ?? null;
    },
  );

  if (!found) {
    throw new NonRetriableError(
      `No base image named \`${name}\`. Capture one with \`sandbox.snapshot({ name: "${name}" })\`.`,
    );
  }

  return imageBuild(found);
};

/**
 * What a build would have given back for a snapshot that was already there. An
 * image is never built or rebuilt, so its target is only its own name.
 */
const imageBuild = (snapshot: CachedSnapshot): CacheBuildResult => {
  return {
    snapshotId: snapshot.snapshotId,
    reused: true,
    target: { ownKey: "", name: snapshot.name },
    hadMachine: true,
    createdSnapshots: [],
    warnings: [],
  };
};

/**
 * Start this job on a copy of its base's machine, before its handler runs.
 *
 * Within a pipeline run the parent is built once however many jobs start from
 * it, in a run of its own, and each child gets its own copy of its machine, so they can't affect each
 * other. The copy is made when this job runs its first command, so a job that
 * starts from another and then waits doesn't pay for a machine while it waits.
 */
export const startFrom = async (
  scope: CiJobScope,
  { id, parent, built }: ResolvedBase,
): Promise<void> => {
  const { run } = scope;

  // An image is a machine to start on, not a handler to run, and there is
  // nothing to rebuild it from: a snapshot of it that won't start fails the
  // job (see `startSandbox`).
  if (!parent) {
    scope.fromSnapshotId = built.snapshotId;

    scope.fromImage = id;

    scope.startNote = `starting image ${id}`;

    run.ci.hooks.activity(run, scope.jobPath, scope.startNote);

    return;
  }

  const { config, input, raw } = parent;

  if (built.snapshotId) {
    const snapshotId = built.snapshotId;

    scope.fromSnapshotId = snapshotId;

    scope.startNote =
      built.cached?.snapshotId === snapshotId
        ? `starting ${config.id} · ${describeCached(built.cached.createdAt)}`
        : `starting ${config.id}`;

    scope.rebuildSnapshot = async (name) => {
      const base = await baseOf(run, parent);

      const rebuilt = await requestRebuild({
        run,
        config,
        input,
        raw,
        target: built.target,
        name,
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
  } else {
    // A parent that ran no commands has no machine to copy, but what it
    // starts from, such as an image, is still where its children begin.
    const parentBase = await baseOf(run, parent);

    if (parentBase) {
      await startFrom(scope, parentBase);
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
 * Build a `from` parent again, to replace a snapshot that wouldn't start: the
 * one rebuild shared by every child that had the trouble. If the snapshot is
 * broken, it is deleted first.
 */
const requestRebuild = ({
  run,
  config,
  input,
  raw,
  target,
  base,
  name,
}: {
  run: CiRunScope;
  config: JobConfig;
  input: unknown;
  /** The input as it was named, which the build validates again. */
  raw: unknown;
  /** The parent's key and snapshot name, which its first build worked out. */
  target: CacheTarget;
  /** What the parent starts from, which its build must start from too. */
  base?: CacheBuildResult;
  /** How the build treats the name, with the snapshot it replaces. */
  name: NamePolicy;
}): Promise<CacheBuildResult> => {
  const path = `${buildPathOf(config.id, input)}${rebuildSuffix}`;
  const existing = run.builds.get(path);

  if (existing) {
    return existing;
  }

  const built = outsideJobs(run, async () => {
    let policy = name;

    // Here, not in each child, so a snapshot that every child found broken is
    // deleted once. One that can't be deleted still holds its name, so what
    // replaces it can't have one.
    if (name.kind === "replace" && deletesHolder(name)) {
      const gone = await deleteSnapshot(
        run,
        joinId(path, "cache:delete"),
        name.exclude,
      );

      if (!gone) {
        policy = { kind: "unnamed", exclude: name.exclude };

        run.warnings.push(
          `not cached: the broken snapshot of \`${config.id}\` couldn't be deleted, so it was rebuilt without a name and later runs build it again`,
        );
      }
    }

    // The snapshot being replaced may still hold the name, so a lookup would
    // only find it again.
    const result = await invokeBuild({
      run,
      path: config.id,
      stepPath: path,
      config,
      input: raw,
      target,
      lookup: false,
      ...(base ? { base } : {}),
      name: policy,
    });

    adoptBuilt(run, result);

    return result;
  });

  run.builds.set(path, built);

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

  const grandparent = await namedBase(run, parent.config, parent.input);

  // Before the machine exists, it can still start from the grandparent's
  // snapshot. After, as when a snapshot wouldn't start, the grandparent has to
  // run here too.
  if (grandparent && !scope.machine) {
    const built = await buildNamed(run, grandparent, (job) => {
      return resolveParent(scope, job);
    });

    await startFrom(scope, resolvedBase(grandparent, built));
  } else if (grandparent && isBaseImage(grandparent)) {
    throw new NonRetriableError(
      `\`${parent.config.id}\` starts from image \`${grandparent.name}\`, which can't be applied to a machine that already started.`,
    );
  } else if (grandparent) {
    await rerunOnThisMachine(scope, grandparent);
  }

  await registered.handler(parent.input);
};
