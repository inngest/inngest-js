/**
 * Defining and running a job: the `ci.job()` factory, starting a run of a job
 * or joining the shared one `from()` uses, and the job body that reports
 * checks, caches and pauses machines.
 *
 * @module
 */

import { NonRetriableError } from "inngest";
import type { CachedSnapshot, CacheTarget } from "../cache/cache.ts";
import { cacheTarget, describeCached, lookupCache } from "../cache/cache.ts";
import {
  CiUsageError,
  CommandFailedError,
  CommandTimeoutError,
} from "../errors.ts";
import type { CheckReporter } from "../github/checks.ts";
import { pauseMachine, snapshotJob } from "../machine/machine.ts";
import type { AnyJob, CheckConclusion, JobConfig } from "../types.ts";
import { errorMessage, formatDuration, shortReason } from "../util.ts";
import type { CacheBuildData, CacheBuildResult } from "./cacheBuild.ts";
import { tagStep } from "./metadata.ts";
import { ciStep, traceName } from "./names.ts";
import type { CiJobScope, CiRunScope } from "./scope.ts";
import {
  getRunScope,
  inJobSpan,
  jobHandlerKey,
  matrixOriginOf,
  rebuildSuffix,
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
  const config: JobConfig =
    typeof idOrConfig === "string" ? { id: idOrConfig } : idOrConfig;

  // Inside a run, curried job factories and matrices build a new job object
  // per call, so the same ID being registered again is expected.
  if (jobs.has(config.id) && !getRunScope()) {
    throw new CiUsageError(
      `Job IDs must be unique per app, and "${config.id}" is already defined.`,
    );
  }

  jobs.set(config.id, { id: config.id, config, handler });

  const job = ((input: unknown) => {
    return runJob({ config, handler, input });
  }) as AnyJob;

  Object.defineProperties(job, {
    id: { value: config.id, enumerable: true },
    kind: { value: "inngest/ci.job", enumerable: true },
    [jobHandlerKey]: { value: handler },
  });

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
 * job's ID as its path and is the one `from()` shares, and each later call gets
 * `${id} (n)`, so it has its own machine, steps and check.
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

  if (!run.jobs.has(config.id)) {
    return startShared({ run, config, handler, input });
  }

  const number = (run.jobCalls.get(config.id) ?? 1) + 1;

  run.jobCalls.set(config.id, number);

  return jobBody({
    run,
    config,
    handler,
    input,
    path: `${config.id} (${number})`,
    number,
  });
};

/**
 * Get the shared run of a job, the one `from()` copies from: join it if it has
 * started, whether by a direct call or another `from()`, or start it.
 */
export const joinJob = ({
  id,
  input,
}: {
  id: string;
  input: unknown;
}): Promise<void> => {
  const run = getRunScope();

  if (!run) {
    throw new CiUsageError(
      `Jobs can only run inside a pipeline. \`${id}\` was started outside \`ci.pipeline()\`.`,
    );
  }

  const existing = run.jobs.get(id);

  if (existing) {
    return existing;
  }

  const registered = run.ci.jobs.get(id);

  if (!registered) {
    throw new CiUsageError(`Job \`${id}\` isn't registered on this client.`);
  }

  return startShared({
    run,
    config: registered.config,
    handler: registered.handler,
    input,
  });
};

const startShared = ({
  run,
  config,
  handler,
  input,
}: RunJobArgs & { run: CiRunScope }): Promise<void> => {
  const started = jobBody({
    run,
    config,
    handler,
    input,
    path: config.id,
    number: 1,
  });

  run.jobs.set(config.id, started);
  run.jobCalls.set(config.id, 1);

  return started;
};

/**
 * Build a cached job's snapshot in a run of its own, and give back what the
 * build ended with.
 *
 * `step.invoke` is durable, so a retried pipeline replays the same build rather
 * than starting another. A build that failed fails the job with its reason,
 * and no retry can change that, since the invoke's outcome is memoized.
 */
const invokeBuild = async ({
  run,
  path,
  config,
  input,
  target,
  exclude,
  check,
}: {
  run: CiRunScope;
  /** The job's path here, which is where its steps and activity go. */
  path: string;
  config: JobConfig;
  input: unknown;
  target: CacheTarget;
  /** A bad snapshot the build must not reuse. */
  exclude?: string;
  check?: CacheBuildData["parent"]["check"];
}): Promise<CacheBuildResult> => {
  const origin = matrixOriginOf(config);
  const parent = run.build?.parent;

  const data: CacheBuildData = {
    jobId: config.id,
    ...(origin ? { matrix: origin } : {}),
    ...(input === undefined ? {} : { input }),
    ownKey: target.ownKey,
    cacheKey: target.name,
    ...(exclude ? { exclude } : {}),
    ...(run.repo ? { repo: run.repo } : {}),
    parent: {
      runId: parent?.runId ?? run.runId,
      pipelineId: parent?.pipelineId ?? run.pipelineId,
      jobPath: path,
      trigger:
        parent?.trigger ?? (run.event as { name?: string })?.name ?? "manual",
      ...(check ? { check } : {}),
    },
  };

  let output: CacheBuildResult | null;

  try {
    output = (await run.step.invoke(
      ciStep(`${path}${scopeSeparator}build`, traceName.buildInOwnRun(path)),
      { function: run.ci.cacheBuild(origin?.id ?? config.id), data },
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
 * Take what a build ended with as this run's own, so jobs that start `from()`
 * the job clone its snapshot. A snapshot without a name is used in this run
 * only: it isn't cached.
 */
const adoptBuilt = (
  run: CiRunScope,
  jobId: string,
  target: CacheTarget,
  built: CacheBuildResult,
): void => {
  if (built.cached) {
    run.cached.set(jobId, {
      ...built.cached,
      ownKey: target.ownKey,
      writeName: target.name,
      restored: built.reused,
    });
  } else {
    run.cached.delete(jobId);
  }

  if (built.snapshotId) {
    run.snapshots.set(jobId, Promise.resolve(built.snapshotId));

    // A named snapshot belongs to the cache and is never deleted by a run. One
    // without a name is the build's unnamed fallback (see createNamedSnapshot),
    // which the build run left for this one to delete when it ends.
    if (!built.cached) {
      run.createdSnapshots.add(built.snapshotId);
    }
  }
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

  run.ci.reporter.jobRunUrl(run, run.build.parent.jobPath, url);

  run.ci.reporter.activity(
    run,
    run.build.parent.jobPath,
    "building in its own run",
  );

  await (run.ci.checks as CheckReporter).building({ run, detailsUrl: url });
};

/**
 * Run a job again as a job of its own, once per run, and give its snapshot.
 *
 * This is how a parent whose snapshot won't start, or is stale, is rebuilt. A
 * cached parent is built by its build function, like on a miss, told which
 * snapshot is bad so it never reuses it: the build runs the job, unless another
 * run's build got there first. Any other parent runs again here, with the same handler under the
 * stable path `<id> (rebuild)` so its steps and machine are distinct from the
 * original's and replays find them again. It has no check of its own, since
 * the original job's is already complete.
 */
export const rebuildJob = async (
  run: CiRunScope,
  jobId: string,
  input: unknown,
): Promise<string | undefined> => {
  const registered = run.ci.jobs.get(jobId) as RegisteredJob | undefined;

  if (!registered) {
    return undefined;
  }

  const path = `${jobId}${rebuildSuffix}`;

  const cached = run.cached.get(jobId);

  if (registered.config.cache && cached) {
    const target = { ownKey: cached.ownKey, name: cached.writeName };

    run.rebuilds ??= new Map();

    let building = run.rebuilds.get(path);

    if (!building) {
      building = invokeBuild({
        run,
        path,
        config: registered.config,
        input,
        target,
        exclude: cached.snapshotId,
      });

      run.rebuilds.set(path, building);
    }

    const built = await building;

    adoptBuilt(run, jobId, target, built);

    return built.snapshotId;
  }

  let started = run.jobs.get(path);

  if (!started) {
    started = jobBody({
      run,
      path,
      config: { ...registered.config, check: false },
      handler: registered.handler,
      input,
      number: 1,
    });

    run.jobs.set(path, started);
  }

  await started;

  return snapshotJob(run, path);
};

/**
 * What the job's `input` schema makes of `input`: the validated value, with
 * its defaults applied. Without a schema, the input as given. Pure, so a
 * handler replaying from the top gets the same answer without a step.
 */
const validateInput = async (
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
  args: RunJobArgs & { run: CiRunScope; path: string; number: number },
): Promise<void> => {
  const running = inJobSpan(args.run, args.path, () => {
    return jobSteps(args);
  });

  args.run.jobRuns.add(running);

  return running;
};

const jobSteps = async ({
  run,
  config,
  handler,
  input: given,
  path,
  number,
}: RunJobArgs & {
  run: CiRunScope;
  /** The job's path: its ID, or `${id} (n)` for a later direct call. */
  path: string;
  /** Which run of this job in the pipeline run this is, counting from 1. */
  number: number;
}): Promise<void> => {
  const input = await validateInput(config, given);
  const checks = run.ci.checks as CheckReporter;

  const scope: CiJobScope = {
    run,
    path,
    jobPath: path,
    config,
    fromCalled: false,
    fromJobIds: [],
    parentInputs: {},
    annotations: [],
    summaries: [],
    env: {},
    secrets: [],
  };

  const configuredName =
    config.check === false ? undefined : config.check?.name;

  const checkName = configuredName
    ? `${configuredName}${number > 1 ? ` (${number})` : ""}`
    : undefined;
  const checked = config.check !== false;
  const isBuild = run.build?.jobId === config.id;

  const target = {
    run,
    jobPath: scope.path,
    ...(checkName ? { name: checkName } : {}),
  };

  if (config.cache) {
    run.ci.reporter.activity(run, scope.jobPath, "checking cache…");
  }

  // A cached job is always asked of its build function, which is the one place
  // that decides to reuse the snapshot or build it. So outside a build run,
  // only the name is needed here.
  const asksBuild = Boolean(config.cache) && !isBuild;

  const cacheAt = config.cache
    ? await cacheTarget(scope, config.cache, input)
    : undefined;

  const hit =
    config.cache && cacheAt && isBuild
      ? await lookupCache(scope, config.cache, cacheAt, run.build?.exclude)
      : undefined;

  if (hit && cacheAt) {
    const title = restoreFromCache(scope, hit, cacheAt);

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
    ));

  try {
    let reusedTitle: string | undefined;

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
      });

      adoptBuilt(run, config.id, cacheAt, built);

      run.warnings.push(...built.warnings);

      if (built.reused && built.cached) {
        reusedTitle = cachedTitle(built.cached);
      }
    } else {
      if (isBuild) {
        await announceBuild(run);
      }

      await runJobBody(scope, () => {
        return handler(input);
      });

      if (cacheAt) {
        await snapshotCached(scope, cacheAt);
      }
    }

    // Replays run this from the top, so the clock here is only right on the
    // replay that executes the check's complete step. Its title is memoized
    // with that value, and the job's real end comes back from the step.
    let checkEndedAt: number | undefined;

    if (checked) {
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
      ));
    const durationMs = endedAt - startedAt;

    run.summaries.push({
      path: scope.path,
      conclusion: "success",
      title: reusedTitle ?? `Passed in ${formatDuration(durationMs)}`,
      durationMs: reusedTitle ? 0 : durationMs,
      ...(reusedTitle ? { cached: true } : {}),
    });

    pauseMachine(scope);
  } catch (error) {
    const conclusion = conclusionForError(error);
    const title = jobErrorTitle(error);

    const keptSnapshotId =
      config.keepOnFailure && scope.machine
        ? await snapshotJob(run, scope.path)
        : undefined;

    // Kept on purpose, so the run's cleanup leaves it alone.
    if (keptSnapshotId) {
      run.createdSnapshots.delete(keptSnapshotId);
    }

    let checkEndedAt: number | undefined;

    if (checked) {
      const result = {
        conclusion,
        title,
        summary: jobFailureSummary(error, scope),
        annotations: scope.annotations,
      };

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
      ));

    run.summaries.push({
      path: scope.path,
      conclusion,
      title,
      durationMs: endedAt - startedAt,
      ...(keptSnapshotId ? { keptSnapshotId } : {}),
    });

    run.jobErrors.push(error);

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
): Promise<number> => {
  return run.step.run(ciStep(id, name), async () => {
    await tagStep(run, { kind: "job", job: jobPath });

    return Date.now();
  });
};

/** What a job's check says when its snapshot was reused rather than built. */
const cachedTitle = (snapshot: CachedSnapshot): string => {
  return describeCached(snapshot.createdAt).replace(/^./, (first) => {
    return first.toUpperCase();
  });
};

/**
 * Take a snapshot found by name as this run's, so the job doesn't run and jobs
 * that start from it clone it. Returns the summary title.
 */
const restoreFromCache = (
  scope: CiJobScope,
  hit: CachedSnapshot,
  target: CacheTarget,
): string => {
  const { run } = scope;

  run.cached.set(scope.config.id, {
    ...hit,
    ownKey: target.ownKey,
    writeName: target.name,
    restored: true,
  });

  run.snapshots.set(scope.path, Promise.resolve(hit.snapshotId));

  const title = cachedTitle(hit);

  run.summaries.push({
    path: scope.path,
    conclusion: "success",
    title,
    durationMs: 0,
    cached: true,
  });

  return title;
};

/**
 * Snapshot a cached job's machine under its name, once it has passed. A job
 * that ran no commands has no machine, so there is nothing to cache, and it
 * runs again next time.
 */
const snapshotCached = async (
  scope: CiJobScope,
  target: CacheTarget,
): Promise<void> => {
  const { run } = scope;

  if (!scope.machine) {
    run.warnings.push(
      `not cached: \`${scope.path}\` ran no commands, so it has no machine to snapshot and runs again next time`,
    );

    return;
  }

  await snapshotJob(run, scope.path, {
    target,
    ...(run.build?.exclude ? { exclude: run.build.exclude } : {}),
  });
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
