/**
 * Defining and running a job: the `ci.job()` factory, joining a run already in
 * progress, and the job body that reports checks, caches and pauses machines.
 *
 * @module
 */

import {
  describeCached,
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
import { formatDuration, shortReason } from "../util.ts";
import { tagStep } from "./metadata.ts";
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
  run,
  config,
  handler,
  input: given,
}: RunJobArgs & { run: CiRunScope }): Promise<unknown> => {
  const input = await validateInput(config, given);
  const checks = run.ci.checks as CheckReporter;

  const scope: CiJobScope = {
    run,
    path: config.id,
    jobPath: config.id,
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

  const target = {
    run,
    jobPath: scope.path,
    ...(checkName ? { name: checkName } : {}),
  };

  if (config.cache) {
    run.ci.reporter.activity(run, scope.jobPath, "checking cache…");
  }

  const cacheLookup = config.cache
    ? await lookupCache(scope, config.cache, input)
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

  const title = entry.snapshotId
    ? `${describeCached(entry).replace(/^./, (first) => {
        return first.toUpperCase();
      })} by ${entry.builtBy.trigger}`
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
