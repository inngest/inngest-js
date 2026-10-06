/**
 * Defining and running a job: the `ci.job()` factory, joining a run already in
 * progress, and the job body that reports checks, caches and pauses machines.
 *
 * @module
 */

import { NonRetriableError } from "inngest";
import type { CacheLookup } from "../cache/cache.ts";
import {
  cacheScopes,
  describeCached,
  cacheTarget,
  lookupCache,
  snapshotIsReady,
  storeCache,
} from "../cache/cache.ts";
import {
  CiUsageError,
  CommandFailedError,
  CommandTimeoutError,
} from "../errors.ts";
import type { CheckReporter } from "../github/checks.ts";
import { pauseMachine, snapshotJob } from "../machine/machine.ts";
import type {
  AnyJob,
  CacheEntry,
  CheckConclusion,
  JobConfig,
} from "../types.ts";
import { errorMessage, formatDuration, shortReason } from "../util.ts";
import type { CacheBuildData, CacheBuildResult } from "./cacheBuild.ts";
import { tagStep } from "./metadata.ts";
import type { CiJobScope, CiRunScope } from "./scope.ts";
import {
  getRunScope,
  jobHandlerKey,
  matrixOriginOf,
  runJobBody,
  scopeSeparator,
} from "./scope.ts";

export interface RegisteredJob {
  id: string;
  config: JobConfig;
  // biome-ignore lint/suspicious/noExplicitAny: user handler
  handler: (input: any) => Promise<any>;
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
  handler: (input: any) => Promise<any>;
  input: unknown;
}

/**
 * Run a job, or join the run already in progress for this ID.
 */
export const runJob = async ({
  config,
  handler,
  input,
}: RunJobArgs): Promise<unknown> => {
  const run = getRunScope();

  if (!run) {
    throw new CiUsageError(
      `Jobs can only run inside a pipeline. \`${config.id}\` was called outside \`ci.pipeline()\`.`,
    );
  }

  const existing = run.jobs.get(config.id);

  if (existing) {
    return existing;
  }

  const started = jobBody({ run, config, handler, input });

  run.jobs.set(config.id, started);

  return started;
};

/**
 * Build a cached job's entry in a run of its own, and take what comes back as
 * this run's own: the entry, the snapshot children start from, and the result.
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
  ownKey,
  writeKey,
  check,
}: {
  run: CiRunScope;
  /** The job's path here, which is where its steps and activity go. */
  path: string;
  config: JobConfig;
  input: unknown;
  ownKey: string;
  writeKey: string;
  check?: CacheBuildData["parent"]["check"];
}): Promise<CacheBuildResult> => {
  const origin = matrixOriginOf(config);
  const parent = run.build?.parent;

  const data: CacheBuildData = {
    jobId: config.id,
    ...(origin ? { matrix: origin } : {}),
    ...(input === undefined ? {} : { input }),
    ownKey,
    cacheKey: writeKey,
    scope: cacheScopes(run.repo, config.cache?.scope).write,
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
      { id: `${path}${scopeSeparator}build`, name: `build ${path}` },
      { function: run.ci.cacheBuild(origin?.id ?? config.id), data },
    )) as CacheBuildResult | null;
  } catch (error) {
    throw new NonRetriableError(errorMessage(error), { cause: error });
  }

  if (!output?.entry) {
    throw new NonRetriableError(
      `The build of \`${config.id}\` gave no cache entry.`,
    );
  }

  return output;
};

/**
 * Take a built entry as this run's own, as if it had been restored from the
 * cache, so jobs that start `from()` the job clone its snapshot.
 */
const adoptBuilt = (
  run: CiRunScope,
  jobId: string,
  entry: CacheEntry,
  writeKey: string,
): void => {
  run.cacheEntries.set(jobId, entry);

  run.cacheWriteKeys ??= new Map();
  run.cacheWriteKeys.set(jobId, writeKey);

  if (entry.snapshotId) {
    run.snapshots.set(jobId, Promise.resolve(entry.snapshotId));
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
 * This is how a parent whose cached snapshot won't start is rebuilt. A cached
 * parent is built by its build function, like on a miss: the entry was already
 * marked bad, so the build runs the job, unless another run's build got there
 * first. Any other parent runs again here, with the same handler under the
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

  const path = `${jobId} (rebuild)`;

  const ownKey = run.cacheEntries.get(jobId)?.key;
  const writeKey = run.cacheWriteKeys?.get(jobId);

  if (registered.config.cache && ownKey !== undefined && writeKey) {
    let building = run.jobs.get(path) as Promise<CacheBuildResult> | undefined;

    if (!building) {
      building = invokeBuild({
        run,
        path,
        config: registered.config,
        input,
        ownKey,
        writeKey,
      });

      run.jobs.set(path, building);
    }

    return (await building).entry.snapshotId;
  }

  let started = run.jobs.get(path);

  if (!started) {
    started = jobBody({
      run,
      path,
      config: { ...registered.config, check: false },
      handler: registered.handler,
      input,
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

const jobBody = async ({
  path,
  run,
  config,
  handler,
  input: given,
}: RunJobArgs & { run: CiRunScope }): Promise<unknown> => {
  const input = await validateInput(config, given);
  const checks = run.ci.checks as CheckReporter;

  const scope: CiJobScope = {
    run,
    path: path ?? config.id,
    jobPath: path ?? config.id,
    config,
    fromCalled: false,
    fromJobIds: [],
    fromInputs: {},
    annotations: [],
    summaries: [],
    env: {},
    secrets: [],
  };

  const checkName = config.check === false ? undefined : config.check?.name;
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
  // that decides to reuse the entry or build it. So outside a build run, only
  // the key is needed here.
  const asksBuild = Boolean(config.cache) && !isBuild;

  const cacheLookup = config.cache
    ? asksBuild
      ? await cacheTarget(scope, config.cache, input)
      : await lookupCache(scope, config.cache, input)
    : undefined;

  if (cacheLookup?.entry && !cacheLookup.entry.invalid) {
    const title = await restoreFromCache(
      scope,
      cacheLookup.entry,
      cacheLookup.writeKey,
    );

    if (title) {
      if (checked) {
        await checks.jobStart(target);
        await checks.jobComplete({ ...target, conclusion: "success", title });
      }

      return cacheLookup.entry.result;
    }
  }

  // Handlers replay from the top on every step, so reading the clock here
  // would time the last replay. The start comes from the check's step, which
  // memoizes it, or from a step of its own when there's no check.
  const checkStartedAt = checked ? await checks.jobStart(target) : undefined;
  const startedAt = checkStartedAt ?? (await durableNow(run, scope.path));

  if (checked) {
    run.openChecks.set(scope.path, checkName);
  }

  try {
    let result: unknown;
    let reusedTitle: string | undefined;

    if (cacheLookup && asksBuild) {
      // The build run looks the entry up when it starts, and builds only if it
      // still has to, so a herd of runs needing one key builds it once.
      const built = await invokeBuild({
        run,
        path: scope.path,
        config,
        input,
        ownKey: cacheLookup.ownKey,
        writeKey: cacheLookup.writeKey,
        check: checks.target(target),
      });

      adoptBuilt(run, config.id, built.entry, cacheLookup.writeKey);

      result = built.result;

      if (built.reused) {
        reusedTitle = cachedTitle(built.entry);
      }
    } else {
      if (isBuild) {
        await announceBuild(run);
      }

      result = await runJobBody(scope, () => {
        return handler(input);
      });

      if (cacheLookup) {
        const stored = await storeCache(
          scope,
          cacheLookup,
          await cacheEntryFor(scope, result),
        );

        adoptBuilt(run, config.id, stored, cacheLookup.writeKey);
      }
    }

    const durationMs = Date.now() - startedAt;
    const title = reusedTitle ?? `Passed in ${formatDuration(durationMs)}`;

    run.summaries.push({
      path: scope.path,
      conclusion: "success",
      title,
      durationMs: reusedTitle ? 0 : durationMs,
      ...(reusedTitle ? { cached: true } : {}),
    });

    if (checked) {
      await checks.jobComplete({
        ...target,
        conclusion: "success",
        title,
        ...(scope.summaries.length > 0
          ? { summary: scope.summaries.join("\n\n") }
          : {}),
        ...(scope.annotations.length > 0
          ? { annotations: scope.annotations }
          : {}),
      });

      run.openChecks.delete(scope.path);
    }

    await pauseMachine(scope);

    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const conclusion = conclusionForError(error);
    const title = jobErrorTitle(error);

    const keptSnapshotId =
      config.keepOnFailure && scope.machine
        ? await snapshotJob(run, scope.path)
        : undefined;

    run.summaries.push({
      path: scope.path,
      conclusion,
      title,
      durationMs,
      ...(keptSnapshotId ? { keptSnapshotId } : {}),
    });

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
        await checks.jobComplete({ ...target, ...result });
      }
    }

    throw error;
  }
};

/**
 * The time, memoized. Only for a job whose check didn't start, which has no
 * step to carry its start time.
 */
const durableNow = (run: CiRunScope, jobPath: string): Promise<number> => {
  const id = `start:${jobPath}`;

  return run.step.run({ id, name: id }, async () => {
    await tagStep(run, { kind: "job", job: jobPath });

    return Date.now();
  });
};

/** What a job's check says when its entry was reused rather than built. */
const cachedTitle = (entry: CacheEntry): string => {
  return entry.snapshotId
    ? `${describeCached(entry).replace(/^./, (first) => {
        return first.toUpperCase();
      })} by ${entry.builtBy.trigger}`
    : `Passed at ${(entry.builtBy.sha ?? "").slice(0, 7)}, no changes since`;
};

/**
 * Use a cache hit if its snapshot is still there, so the job doesn't run and
 * jobs that start from it clone the saved machine. Returns the summary title,
 * or `undefined` when the entry is unusable.
 */
const restoreFromCache = async (
  scope: CiJobScope,
  entry: CacheEntry,
  writeKey: string,
): Promise<string | undefined> => {
  const { run } = scope;

  if (
    entry.snapshotId &&
    !(await snapshotIsReady(run, scope.path, entry.snapshotId))
  ) {
    return undefined;
  }

  run.cacheEntries.set(scope.config.id, entry);

  run.cacheWriteKeys ??= new Map();
  run.cacheWriteKeys.set(scope.config.id, writeKey);

  if (entry.snapshotId) {
    run.snapshots.set(scope.config.id, Promise.resolve(entry.snapshotId));
  }

  const title = cachedTitle(entry);

  run.summaries.push({
    path: scope.path,
    conclusion: "success",
    title,
    durationMs: 0,
    cached: true,
  });

  return title;
};

const cacheEntryFor = async (
  scope: CiJobScope,
  result: unknown,
): Promise<Omit<CacheEntry, "key" | "fromKeys">> => {
  const { run } = scope;

  const snapshotId = scope.machine
    ? await snapshotJob(run, scope.path)
    : undefined;

  return {
    jobId: scope.config.id,
    ...(snapshotId ? { snapshotId } : {}),
    result,
    builtAt: new Date().toISOString(),
    builtBy: {
      runId: run.runId,
      ...(run.repo?.sha ? { sha: run.repo.sha } : {}),
      trigger:
        run.build?.parent.trigger ??
        (run.event as { name?: string })?.name ??
        "manual",
    },
  };
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
