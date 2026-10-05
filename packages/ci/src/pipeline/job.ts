/**
 * Defining and running a job: the `ci.job()` factory, joining a run already in
 * progress, and the job body that reports checks, caches and pauses machines.
 *
 * @module
 */

import { lookupCache, snapshotIsReady, storeCache } from "../cache/cache.ts";
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
import { formatDuration, formatRelative } from "../util.ts";
import type { CiJobScope, CiRunScope } from "./scope.ts";
import { getRunScope, jobHandlerKey, runJobBody } from "./scope.ts";

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

  // Curried job factories build a new job object per call, so the same ID
  // being registered again is expected.
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

const jobBody = async ({
  run,
  config,
  handler,
  input,
}: RunJobArgs & { run: CiRunScope }): Promise<unknown> => {
  const checks = run.ci.checks as CheckReporter;

  const scope: CiJobScope = {
    run,
    path: config.id,
    jobPath: config.id,
    config,
    fromCalled: false,
    fromJobIds: [],
    annotations: [],
    summaries: [],
    env: {},
    secrets: [],
  };

  const checkName = config.check === false ? undefined : config.check?.name;
  const checked = config.check !== false;

  const target = {
    run,
    jobPath: scope.path,
    ...(checkName ? { name: checkName } : {}),
  };

  const cacheLookup = config.cache
    ? await lookupCache(scope, config.cache, input)
    : undefined;

  if (cacheLookup?.entry) {
    const title = await restoreFromCache(scope, cacheLookup.entry);

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
    const result = await runJobBody(scope, () => {
      return handler(input);
    });

    const durationMs = Date.now() - startedAt;
    const title = `Passed in ${formatDuration(durationMs)}`;

    if (cacheLookup) {
      await storeCache(scope, cacheLookup, await cacheEntryFor(scope, result));
    }

    run.summaries.push({
      path: scope.path,
      conclusion: "success",
      title,
      durationMs,
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
      await checks.jobComplete({
        ...target,
        conclusion,
        title,
        summary: jobFailureSummary(error, scope),
        ...(scope.annotations.length > 0
          ? { annotations: scope.annotations }
          : {}),
      });

      run.openChecks.delete(scope.path);
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

  return run.step.run({ id, name: id }, () => {
    return Date.now();
  });
};

/**
 * Use a cache hit if its snapshot is still there, so the job doesn't run and
 * jobs that start from it clone the saved machine. Returns the summary title,
 * or `undefined` when the entry is unusable.
 */
const restoreFromCache = async (
  scope: CiJobScope,
  entry: CacheEntry,
): Promise<string | undefined> => {
  const { run } = scope;

  if (
    entry.snapshotId &&
    !(await snapshotIsReady(run, scope.path, entry.snapshotId))
  ) {
    return undefined;
  }

  run.cacheEntries.set(scope.config.id, entry);

  if (entry.snapshotId) {
    run.snapshots.set(scope.config.id, Promise.resolve(entry.snapshotId));
  }

  const title = entry.snapshotId
    ? `Restored, built ${formatRelative(entry.builtAt)} by ${entry.builtBy.trigger}`
    : `Passed at ${(entry.builtBy.sha ?? "").slice(0, 7)}, no changes since`;

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
      trigger: (run.event as { name?: string })?.name ?? "manual",
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

  return error instanceof Error
    ? (error.message.split("\n")[0] ?? "Failed")
    : "Failed";
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
