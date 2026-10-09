/**
 * Defining and running a job: the `ci.job()` factory, running a direct call of
 * a job, asking a build function for a job's snapshot, and the job body that
 * reports checks and caches.
 *
 * @module
 */

import { NonRetriableError } from "inngest";
import type { CachedSnapshot, CacheTarget } from "../cache/cache.ts";
import {
  cacheTarget,
  describeCached,
  lookupBeforeBuild,
  lookupCache,
  runTarget,
} from "../cache/cache.ts";
import {
  CiUsageError,
  CommandFailedError,
  CommandTimeoutError,
} from "../errors.ts";
import type { CheckReporter } from "../github/checks.ts";
import {
  buildsInRun,
  identityOf,
  ownJob,
  parentBuildOf,
  startFrom,
} from "../machine/from.ts";
import { snapshotMachine } from "../machine/machine.ts";
import type { AnyJob, CheckConclusion, JobConfig } from "../types.ts";
import { errorMessage, formatDuration, shortReason } from "../util.ts";
import type { CacheBuildData, CacheBuildResult } from "./cacheBuild.ts";
import { ciRun } from "./metadata.ts";
import { ciStep, traceName } from "./names.ts";
import type {
  BuildOutcome,
  CiJobScope,
  CiRunScope,
  InlineBuild,
  JobSummary,
} from "./scope.ts";
import {
  getRunScope,
  inJobSpan,
  inlineKey,
  isInline,
  matrixOriginOf,
  rootRunIdOf,
  runJobBody,
  scopeSeparator,
} from "./scope.ts";

export interface RegisteredJob {
  id: string;
  config: JobConfig;
  // biome-ignore lint/suspicious/noExplicitAny: user handler
  handler: (input: any) => Promise<void>;
}

export const defineJob = ({
  jobs,
  idOrConfig,
  handler,
}: {
  jobs: Map<string, RegisteredJob>;
  // biome-ignore lint/suspicious/noExplicitAny: overloaded signature
  idOrConfig: any;
  // biome-ignore lint/suspicious/noExplicitAny: user handler
  handler: any;
  // biome-ignore lint/suspicious/noExplicitAny: overloaded signature
}): any => {
  const given: JobConfig =
    typeof idOrConfig === "string" ? { id: idOrConfig } : idOrConfig;

  const run = getRunScope();

  // A job defined while a run is active exists only in this worker's memory,
  // so the build function can't find it. A matrix says so for its own jobs.
  const config: JobConfig =
    run && !(inlineKey in given)
      ? ({ ...given, [inlineKey]: true } as JobConfig)
      : given;

  if (!run && jobs.has(config.id)) {
    throw new CiUsageError(
      `Job IDs must be unique per app, and "${config.id}" is already defined.`,
    );
  }

  // Inside a run, one ID is one job: a second definition would share the first
  // one's registry entry, snapshot names and checks. A matrix defines its
  // combinations again on every call, which is expected.
  if (run && !matrixOriginOf(config)) {
    if (run.definedJobs.has(config.id)) {
      throw new CiUsageError(
        `Job "${config.id}" is defined twice in this run. Jobs made inside a pipeline need an ID of their own: put what varies, like the package name, in the \`id\`.`,
      );
    }

    run.definedJobs.add(config.id);
  }

  jobs.set(config.id, { id: config.id, config, handler });

  const job = ((input: unknown) => {
    return runJob({ config, handler, input });
  }) as AnyJob;

  Object.defineProperties(job, {
    id: { value: config.id, enumerable: true },
    kind: { value: "inngest/ci.job", enumerable: true },
    with: {
      value: (input: unknown) => {
        return Object.freeze({ kind: "inngest/ci.jobRef", job, input });
      },
    },
  });

  ownJob(job, jobs);

  return job;
};

export const conclusionForError = (error: unknown): CheckConclusion => {
  return error instanceof CommandTimeoutError ? "timed_out" : "failure";
};

interface RunJobArgs {
  /** Where the job runs and keeps its steps, when that isn't its ID. */
  path?: string;
  config: JobConfig;
  // biome-ignore lint/suspicious/noExplicitAny: user handler
  handler: (input: any) => Promise<void>;
  input: unknown;
}

/**
 * Run a job. Every direct call is its own run of the job: the first has the
 * job's ID as its path, and each later call gets `${id} (n)`, so it has its
 * own machine, steps and check.
 */
export const runJob = async ({
  config,
  handler,
  input,
}: RunJobArgs): Promise<void> => {
  const run = getRunScope();

  if (!run) {
    throw new CiUsageError(
      `Jobs can only run inside a pipeline. \`${config.id}\` was called outside \`ci.pipeline()\`.`,
    );
  }

  const number = (run.jobCalls.get(config.id) ?? 0) + 1;

  run.jobCalls.set(config.id, number);

  return jobBody({
    run,
    config,
    handler,
    input,
    path: number === 1 ? config.id : `${config.id} (${number})`,
    number,
  });
};

/**
 * Build a job's snapshot in a run of its own, and give back what the build
 * ended with.
 *
 * `step.invoke` is durable, so a retried pipeline replays the same build rather
 * than starting another. A build that failed fails the job with its reason,
 * and no retry can change that, since the invoke's outcome is memoized.
 */
export const invokeBuild = async (
  args: BuildArgs,
): Promise<CacheBuildResult> => {
  const { run, config, input } = args;

  // The build function can't find a job that exists only in this run, nor one
  // whose parent does, so such a job builds here.
  if (buildsInRun(run, config, input)) {
    return buildInline(args);
  }

  return invokeBuildRun(args);
};

interface BuildArgs {
  run: CiRunScope;
  /** The job's path here, which is where the build's activity goes. */
  path: string;
  /** What the invoke's step ID is built on, when it isn't the job's path. */
  stepPath?: string;
  config: JobConfig;
  input: unknown;
  target: CacheTarget;
  /** A bad snapshot the build must not reuse. */
  exclude?: string;
  check?: CacheBuildData["parent"]["check"];
  /** What the job starts from, which the build must start from too. */
  base?: CacheBuildResult;
  /** Whether to look the snapshot up before invoking. Off when the caller just did. */
  lookup?: boolean;
}

/**
 * Build a job that exists only in this run, as a job of the run: it looks its
 * name up, builds on a miss and snapshots under the name. No other run can
 * build it, so a name two runs race for is settled by whoever takes it first,
 * and the other adopts that snapshot.
 */
const buildInline = async ({
  run,
  path,
  stepPath = path,
  config,
  input,
  target,
  exclude,
  base,
}: BuildArgs): Promise<CacheBuildResult> => {
  const registered = run.ci.jobs.get(config.id);

  if (!registered) {
    throw new NonRetriableError(
      `No job with the ID "${config.id}" is defined, so it can't be built.`,
    );
  }

  const inline: InlineBuild = {
    target,
    ...(exclude ? { exclude } : {}),
    ...(base ? { base: baseForBuild(base) } : {}),
  };

  await jobBody({
    run,
    config: registered.config,
    handler: registered.handler,
    input,
    path: stepPath,
    number: 1,
    inline,
  });

  const outcome = inline.outcome;

  return {
    ...(outcome?.snapshotId ? { snapshotId: outcome.snapshotId } : {}),
    ...(outcome?.cached ? { cached: outcome.cached } : {}),
    reused: outcome?.reused ?? false,
    target,
    hadMachine: outcome?.hadMachine ?? false,
    createdSnapshots: [],
    ...(inline.summary ? { summary: inline.summary } : {}),
    warnings: [],
  };
};

const invokeBuildRun = async ({
  run,
  path,
  stepPath = path,
  config,
  input,
  target,
  exclude,
  check,
  base,
  lookup = true,
}: BuildArgs): Promise<CacheBuildResult> => {
  const origin = matrixOriginOf(config);
  const parent = run.build?.parent;
  const rootRunId = rootRunIdOf(run);

  const data: CacheBuildData = {
    jobId: config.id,
    ...(origin ? { matrix: origin } : {}),
    ...(input === undefined ? {} : { input }),
    ownKey: target.ownKey,
    cacheKey: target.name,
    ...(exclude ? { exclude } : {}),
    ...(base ? { base: baseForBuild(base) } : {}),
    ...(run.repo ? { repo: run.repo } : {}),
    rootRunId,
    parent: {
      runId: rootRunId,
      pipelineId: parent?.pipelineId ?? run.pipelineId,
      jobPath: path,
      trigger:
        parent?.trigger ?? (run.event as { name?: string })?.name ?? "manual",
      ...(check ? { check } : {}),
    },
  };

  // A snapshot that is already there needs no build run, and no wait behind
  // the builds that are queued for its name. A caller that has just looked it
  // up itself has no use for a second lookup.
  if (lookup) {
    const hit = await lookupBeforeBuild(
      run,
      { id: config.id, path, stepPath },
      config.cache,
      target,
      exclude,
    );

    if (hit) {
      return reusedBuild(config, target, hit);
    }
  }

  let output: CacheBuildResult | null;

  try {
    output = (await run.step.invoke(
      ciStep(
        `${stepPath}${scopeSeparator}build`,
        traceName.buildInOwnRun(path),
      ),
      { function: run.ci.cacheBuild(), data },
    )) as CacheBuildResult | null;
  } catch (error) {
    throw new NonRetriableError(errorMessage(error), { cause: error });
  }

  if (!output) {
    throw new NonRetriableError(
      `The build of \`${config.id}\` gave nothing back.`,
    );
  }

  return output;
};

/**
 * A parent's build as a build run is handed it: what starting from it and
 * rebuilding it need, without the summary and warnings the invoking run has
 * already taken.
 */
const baseForBuild = (built: CacheBuildResult): CacheBuildResult => {
  return {
    ...(built.snapshotId ? { snapshotId: built.snapshotId } : {}),
    ...(built.cached ? { cached: built.cached } : {}),
    reused: built.reused,
    target: built.target,
    hadMachine: built.hadMachine,
    createdSnapshots: [],
    warnings: [],
  };
};

/** What a build run would have given back, for a snapshot that was already there. */
export const reusedBuild = (
  config: JobConfig,
  target: CacheTarget,
  hit: CachedSnapshot,
): CacheBuildResult => {
  return {
    snapshotId: hit.snapshotId,
    ...(config.cache ? { cached: hit } : {}),
    reused: true,
    target,
    hadMachine: true,
    createdSnapshots: [],
    summary: {
      path: config.id,
      conclusion: "success",
      title: cachedTitle(hit),
      durationMs: 0,
      cached: true,
    },
    warnings: [],
  };
};

/**
 * Take what a build ended with as this run's concern: its warnings, and its
 * snapshot when it isn't one the cache keeps, which the run deletes when it
 * ends. That is a snapshot only this run needs.
 */
export const adoptBuilt = (run: CiRunScope, built: CacheBuildResult): void => {
  run.warnings.push(...built.warnings);

  for (const id of built.createdSnapshots) {
    run.createdSnapshots.add(id);
  }

  if (built.snapshotId && !built.cached) {
    run.createdSnapshots.add(built.snapshotId);
  }
};

/**
 * What a job's snapshot is named, for a build run: the name the invoking run
 * limited builds on, so the two can't drift apart.
 */
const buildTarget = (run: CiRunScope): CacheTarget | undefined => {
  return run.build
    ? { ownKey: run.build.ownKey, name: run.build.cacheKey }
    : undefined;
};

/**
 * Tell the invoking run, as the first thing a build that has to build does,
 * where this run is.
 */
const announceBuild = async (run: CiRunScope): Promise<void> => {
  if (!run.build) {
    return;
  }

  const url = run.ci.runUrl({ runId: run.runId, functionId: run.functionId });

  run.ci.hooks.jobRunUrl(run, run.build.parent.jobPath, url);

  run.ci.hooks.activity(
    run,
    run.build.parent.jobPath,
    "building in its own run",
  );

  await (run.ci.checks as CheckReporter).building({ run, detailsUrl: url });
};

/**
 * What the job's `input` schema makes of `input`: the validated value, with
 * its defaults applied. Without a schema, the input as given. Pure, so a
 * handler replaying from the top gets the same answer without a step.
 */
export const validateInput = async (
  config: JobConfig,
  input: unknown,
): Promise<unknown> => {
  if (!config.input) {
    return input;
  }

  const result = await config.input["~standard"].validate(input);

  if (!result.issues) {
    return result.value;
  }

  const problems = result.issues.map((issue) => {
    const path = (issue.path ?? [])
      .map((segment) => {
        return String(typeof segment === "object" ? segment.key : segment);
      })
      .join(".");

    return `  - ${path ? `${path}: ` : ""}${issue.message}`;
  });

  throw new CiUsageError(
    `The input for job "${config.id}" doesn't match its \`input\` schema:\n${problems.join("\n")}`,
  );
};

/** Everything a job does is in its span. */
const jobBody = (
  args: RunJobArgs & {
    run: CiRunScope;
    path: string;
    number: number;
    inline?: InlineBuild;
  },
): Promise<void> => {
  return inJobSpan(
    args.run,
    args.path,
    () => {
      return jobSteps(args);
    },
    args.inline ? traceName.buildInline(args.config.id) : undefined,
  );
};

const jobSteps = async ({
  run,
  config,
  handler,
  input: given,
  path,
  number,
  inline,
}: RunJobArgs & {
  run: CiRunScope;
  /** The job's path: its ID, or `${id} (n)` for a later direct call. */
  path: string;
  /** Which run of this job in the pipeline run this is, counting from 1. */
  number: number;
  /** Set when the job is built here for a job that starts from it. */
  inline?: InlineBuild;
}): Promise<void> => {
  const input = await validateInput(config, given);
  const checks = run.ci.checks as CheckReporter;

  const scope: CiJobScope = {
    run,
    path,
    jobPath: path,
    config,
    fromJobIds: [],
    annotations: [],
    summaries: [],
    env: {},
    secrets: [],
    ...(inline ? { inline } : {}),
  };

  const configuredName =
    config.check === false ? undefined : config.check?.name;

  const checkName = configuredName
    ? `${configuredName}${number > 1 ? ` (${number})` : ""}`
    : undefined;
  // A job built here for another has no check: the job that needs it has one.
  const checked = config.check !== false && !inline;
  const isBuild = run.build?.jobId === config.id;

  const target = {
    run,
    jobPath: scope.path,
    ...(checkName ? { name: checkName } : {}),
  };

  // A job's name includes the snapshot of the parent it starts from, so the
  // parent comes first: a parent that changed gives this job a new name. A
  // parent that failed fails this job too, once its check has started.
  let parentFailure: { error: unknown } | undefined;

  // Only a job with a `from` waits here, so a job without one plans its
  // first step at once, as a run that ends without awaiting it expects.
  const fromParent =
    config.from === undefined
      ? undefined
      : await parentBuildOf(scope, input).catch((error: unknown) => {
          parentFailure = { error };

          return undefined;
        });

  if (config.cache) {
    run.ci.hooks.activity(run, scope.jobPath, "checking cache…");
  }

  // A cached job is always asked of its build function, which is the one place
  // that decides to reuse the snapshot or build it. So outside a build run,
  // only the name is needed here. A job the build function can't find builds
  // right here, and is its own build.
  const inRun = !inline && buildsInRun(run, config, input);
  const asksBuild = Boolean(config.cache) && !isBuild && !inRun;

  const cacheAt =
    config.cache && !parentFailure && !inline
      ? await cacheTarget(
          run,
          { id: config.id, path: scope.path },
          config.cache,
          input,
          fromParent
            ? identityOf(fromParent.parent.config.id, fromParent.built)
            : undefined,
        )
      : undefined;

  // A build snapshots its job, cached or not, under the name the run that
  // invoked it asked for.
  const builtAs = inline
    ? inline.target
    : isBuild
      ? (cacheAt ?? buildTarget(run))
      : inRun
        ? cacheAt
        : undefined;

  const exclude = inline
    ? inline.exclude
    : isBuild
      ? run.build?.exclude
      : undefined;

  const hit = builtAs
    ? await lookupCache(scope, config.cache, builtAs, exclude)
    : undefined;

  if (hit) {
    const title = restoreFromCache(scope, hit);

    if (checked) {
      await checks.jobStart(target);
      await checks.jobComplete({ ...target, conclusion: "success", title });
    }

    return;
  }

  // Handlers replay from the top on every step, so reading the clock here
  // would time the last replay. The start comes from the check's step, which
  // memoizes it, or from a step of its own when there's no check.
  const checkStartedAt = checked ? await checks.jobStart(target) : undefined;
  const startedAt =
    checkStartedAt ??
    (await durableNow(
      run,
      `start:${scope.path}`,
      traceName.recordStartTime,
      scope.path,
      "started",
    ));

  if (checked) {
    run.openChecks.set(scope.path, checkName);
  }

  try {
    let reusedTitle: string | undefined;

    if (parentFailure) {
      throw parentFailure.error;
    }

    if (cacheAt && asksBuild) {
      // The build run looks the snapshot up when it starts, and builds only if
      // it still has to, so a herd of runs needing one name builds it once.
      const built = await invokeBuild({
        run,
        path: scope.path,
        config,
        input,
        target: cacheAt,
        check: checks.target(target),
        ...(fromParent ? { base: fromParent.built } : {}),
      });

      adoptBuilt(run, built);

      if (built.reused && built.cached) {
        reusedTitle = cachedTitle(built.cached);
      }
    } else {
      if (isBuild) {
        await announceBuild(run);
      }

      if (builtAs && config.cache && (inline || inRun)) {
        warnBuiltInRun(run, config.id);
      }

      await runJobBody(scope, async () => {
        if (fromParent) {
          await startFrom(scope, fromParent);
        }

        return handler(input);
      });

      if (builtAs) {
        await snapshotBuilt(scope, builtAs, exclude);
      }
    }

    // Replays run this from the top, so the clock here is only right on the
    // replay that executes the check's complete step. Its title is memoized
    // with that value, and the job's real end comes back from the step.
    let checkEndedAt: number | undefined;

    if (checked) {
      // Before the step, not after: a sibling's failure can end the run while
      // it's in flight, and a job that passed must not be cancelled for it.
      run.openChecks.delete(scope.path);

      checkEndedAt = await checks.jobComplete({
        ...target,
        conclusion: "success",
        title:
          reusedTitle ?? `Passed in ${formatDuration(Date.now() - startedAt)}`,
        ...(scope.summaries.length > 0
          ? { summary: scope.summaries.join("\n\n") }
          : {}),
        ...(scope.annotations.length > 0
          ? { annotations: scope.annotations }
          : {}),
      });
    }

    const endedAt =
      checkEndedAt ??
      (await durableNow(
        run,
        `end:${scope.path}`,
        traceName.recordEndTime,
        scope.path,
        "ended",
      ));
    const durationMs = endedAt - startedAt;

    recordSummary(scope, {
      path: scope.path,
      conclusion: "success",
      title: reusedTitle ?? `Passed in ${formatDuration(durationMs)}`,
      durationMs: reusedTitle ? 0 : durationMs,
      ...(reusedTitle ? { cached: true } : {}),
    });
  } catch (error) {
    const conclusion = conclusionForError(error);
    const title = jobErrorTitle(error);

    // Kept on purpose, so the run's cleanup leaves it alone.
    const keptSnapshotId = config.keepOnFailure
      ? (await snapshotMachine(scope))?.snapshotId
      : undefined;

    let checkEndedAt: number | undefined;

    if (checked) {
      const result = {
        conclusion,
        title,
        summary: jobFailureSummary(error, scope),
        annotations: scope.annotations,
      };

      run.openChecks.delete(scope.path);

      if (run.willRetry(error)) {
        // A later attempt may pass, and the check's complete step is memoized,
        // so the result is held back until the run knows it's final.
        run.deferredChecks.set(scope.path, {
          ...(checkName ? { name: checkName } : {}),
          ...result,
        });
      } else {
        checkEndedAt = await checks.jobComplete({ ...target, ...result });
      }
    }

    const endedAt =
      checkEndedAt ??
      (await durableNow(
        run,
        `end:${scope.path}`,
        traceName.recordEndTime,
        scope.path,
        "ended",
      ));

    run.summaries.push({
      path: scope.path,
      conclusion,
      title,
      durationMs: endedAt - startedAt,
      ...(keptSnapshotId ? { keptSnapshotId } : {}),
    });

    throw error;
  }
};

/**
 * The time, memoized under the step `id`. Only for a job whose check didn't
 * start or complete, which has no step to carry its start or end time.
 */
const durableNow = (
  run: CiRunScope,
  id: string,
  name: string,
  jobPath: string,
  edge: "started" | "ended",
): Promise<number> => {
  return ciRun(
    run,
    {
      step: ciStep(id, name),
      intent: `Record when \`${jobPath}\` ${edge}`,
      tag: { kind: "job", job: jobPath },
    },
    (note) => {
      const now = Date.now();

      note.outcome({ at: new Date(now).toISOString() });

      return now;
    },
  );
};

/** What a job's check says when its snapshot was reused rather than built. */
const cachedTitle = (snapshot: CachedSnapshot): string => {
  return describeCached(snapshot.createdAt).replace(/^./, (first) => {
    return first.toUpperCase();
  });
};

/**
 * Take a snapshot found by name as this build's result, so the job doesn't run
 * and the jobs that start from it clone it. Returns the summary title.
 */
const restoreFromCache = (scope: CiJobScope, hit: CachedSnapshot): string => {
  setOutcome(scope, {
    snapshotId: hit.snapshotId,
    ...(scope.config.cache ? { cached: hit } : {}),
    reused: true,
    hadMachine: true,
  });

  const title = cachedTitle(hit);

  recordSummary(scope, {
    path: scope.path,
    conclusion: "success",
    title,
    durationMs: 0,
    cached: true,
  });

  return title;
};

/**
 * Snapshot a build's machine under its name, once its job has passed, and
 * record what the build ends with. A job that ran no commands has no machine,
 * so there is nothing to snapshot, and nothing for a cache to reuse.
 */
const snapshotBuilt = async (
  scope: CiJobScope,
  target: CacheTarget,
  /** A bad snapshot the name must not be satisfied by. */
  exclude?: string,
): Promise<void> => {
  const { run } = scope;

  if (!scope.machine) {
    if (scope.config.cache) {
      run.warnings.push(
        `not cached: \`${scope.path}\` ran no commands, so it has no machine to snapshot and runs again next time`,
      );
    }

    setOutcome(scope, { reused: false, hadMachine: false });

    return;
  }

  const taken = await snapshotMachine(scope, {
    target,
    ...(exclude ? { exclude } : {}),
  });

  setOutcome(scope, {
    ...(taken ? { snapshotId: taken.snapshotId } : {}),
    ...(scope.config.cache && taken?.named ? { cached: taken.named } : {}),
    reused: taken?.reused ?? false,
    hadMachine: true,
  });
};

/**
 * Record what a build's job ended with: for the build run that hands it back,
 * or for the run that builds the job itself. A job that isn't a build has
 * nobody to tell.
 */
const setOutcome = (scope: CiJobScope, outcome: BuildOutcome): void => {
  const { run, inline } = scope;

  if (inline) {
    inline.outcome = outcome;
  } else if (run.build?.jobId === scope.config.id) {
    run.outcome = outcome;
  }
};

/**
 * Add a job's line to the summary. A job built here for another leaves it for
 * that request to report once, under the job's own ID.
 */
const recordSummary = (scope: CiJobScope, summary: JobSummary): void => {
  if (scope.inline) {
    scope.inline.summary = { ...summary, path: scope.config.id };

    return;
  }

  scope.run.summaries.push(summary);
};

/** Say a cached job builds in the run, once however many times it does. */
const warnBuiltInRun = (run: CiRunScope, jobId: string): void => {
  const warning = `built in this run: \`${jobId}\` is defined inside the pipeline, so concurrent runs aren't deduplicated`;

  if (!run.warnings.includes(warning)) {
    run.warnings.push(warning);
  }
};

const jobErrorTitle = (error: unknown): string => {
  if (error instanceof CommandFailedError) {
    return `\`${error.command.join(" ")}\` exited with ${error.exitCode}`;
  }

  if (error instanceof CommandTimeoutError) {
    return `\`${error.command.join(" ")}\` timed out after ${error.timeout}`;
  }

  return shortReason(error) || "Failed";
};

const jobFailureSummary = (error: unknown, scope: CiJobScope): string => {
  const parts: string[] = [];

  if (error instanceof CommandFailedError) {
    const output = `${error.stdoutTail}\n${error.stderrTail}`
      .split("\n")
      .slice(-60)
      .join("\n");

    parts.push(`\`\`\`\n${output}\n\`\`\``);
  } else if (error instanceof Error) {
    parts.push(error.message);
  }

  parts.push(
    `[View the trace](${scope.run.ci.runUrl({
      runId: scope.run.runId,
      functionId: scope.run.functionId,
    })})`,
  );

  return [...parts, ...scope.summaries].join("\n\n");
};
