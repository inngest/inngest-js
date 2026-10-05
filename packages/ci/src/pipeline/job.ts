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
import type { AnyJob, CheckConclusion, JobConfig } from "../types.ts";
import { formatDuration, formatRelative } from "../util.ts";
import type { CiInternals, CiJobScope, CiRunScope } from "./scope.ts";
import { jobHandlerKey, runJobBody } from "./scope.ts";

export interface RegisteredJob {
  id: string;
  config: JobConfig;
  // biome-ignore lint/suspicious/noExplicitAny: user handler
  handler: (input: any) => Promise<any>;
}

export const defineJob = ({
  internals,
  jobs,
  idOrConfig,
  handler,
}: {
  internals: CiInternals;
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

  const job = ((input: unknown) =>
    runJob({ internals, config, handler, input })) as AnyJob;

  Object.defineProperties(job, {
    id: { value: config.id, enumerable: true },
    kind: { value: "inngest/ci.job", enumerable: true },
    [jobHandlerKey]: { value: handler },
  });

  return job;
};

export const conclusionForError = (error: unknown): CheckConclusion => {
  if (error instanceof CommandTimeoutError) {
    return "timed_out";
  }
  return "failure";
};

interface RunJobArgs {
  internals: CiInternals;
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
  const { getRunScope } = await import("./scope.ts");
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
}: {
  run: CiRunScope;
  config: JobConfig;
  // biome-ignore lint/suspicious/noExplicitAny: user handler
  handler: (input: any) => Promise<any>;
  input: unknown;
}): Promise<unknown> => {
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
    checkStarted: false,
    env: {},
    secrets: [],
  };

  const startedAt = Date.now();
  const jobCheckName = config.check === false ? undefined : config.check?.name;
  const jobChecksOn = config.check !== false;

  const cacheLookup = config.cache
    ? await lookupCache(scope, config.cache, {})
    : undefined;

  // A hit with a usable snapshot means the job doesn't run at all, and jobs
  // that start from it clone the saved machine.
  if (cacheLookup?.entry) {
    const entry = cacheLookup.entry;
    const usable = entry.snapshotId
      ? await snapshotIsReady(run, scope.path, entry.snapshotId)
      : true;

    if (usable) {
      run.cacheEntries.set(config.id, entry);

      if (entry.snapshotId) {
        run.snapshots.set(config.id, Promise.resolve(entry.snapshotId));
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

      if (jobChecksOn) {
        await checks.jobStart({
          run,
          jobPath: scope.path,
          ...(jobCheckName ? { name: jobCheckName } : {}),
        });
        await checks.jobComplete({
          run,
          jobPath: scope.path,
          ...(jobCheckName ? { name: jobCheckName } : {}),
          conclusion: "success",
          title,
        });
      }

      return entry.result;
    }
  }

  if (jobChecksOn) {
    await checks.jobStart({
      run,
      jobPath: scope.path,
      ...(jobCheckName ? { name: jobCheckName } : {}),
    });
    run.openChecks.set(scope.path, jobCheckName);
  }

  try {
    const result = await runJobBody(scope, () => handler(input));
    const durationMs = Date.now() - startedAt;
    const title = `Passed in ${formatDuration(durationMs)}`;

    if (cacheLookup) {
      const snapshotId = scope.machine
        ? await snapshotJob(run, scope.path)
        : undefined;

      await storeCache(scope, cacheLookup, {
        jobId: config.id,
        ...(snapshotId ? { snapshotId } : {}),
        result,
        builtAt: new Date().toISOString(),
        builtBy: {
          runId: run.runId,
          ...(run.repo?.sha ? { sha: run.repo.sha } : {}),
          trigger: (run.event as { name?: string })?.name ?? "manual",
        },
        ...(scope.fromJobIds.length > 0
          ? { fromJobIds: scope.fromJobIds }
          : {}),
      });
    }

    run.summaries.push({
      path: scope.path,
      conclusion: "success",
      title,
      durationMs,
    });

    if (jobChecksOn) {
      await checks.jobComplete({
        run,
        jobPath: scope.path,
        ...(jobCheckName ? { name: jobCheckName } : {}),
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

    if (jobChecksOn) {
      await checks.jobComplete({
        run,
        jobPath: scope.path,
        ...(jobCheckName ? { name: jobCheckName } : {}),
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
