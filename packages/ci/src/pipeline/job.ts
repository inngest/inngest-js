/**
 * Defining and running a job: the `ci.job()` factory, starting a run of a job
 * or joining the shared one `from` uses, and the job body that reports
 * checks and caches.
 *
 * @module
 */

import type { CachedSnapshot, CacheTarget } from "../cache/cache.ts";
import { cacheTarget, describeCached, lookupCache } from "../cache/cache.ts";
import {
  CiUsageError,
  CommandFailedError,
  CommandTimeoutError,
} from "../errors.ts";
import type { CheckReporter } from "../github/checks.ts";
import { parentOf, parentSnapshot, startFrom } from "../machine/from.ts";
import { snapshotJob } from "../machine/machine.ts";
import type { AnyJob, CheckConclusion, JobConfig } from "../types.ts";
import { formatDuration } from "../util.ts";
import { tagStep } from "./metadata.ts";
import type { CiJobScope, CiRunScope } from "./scope.ts";
import { getRunScope, runJobBody } from "./scope.ts";

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

  // Curried job factories build a new job object per call, so the same ID
  // being registered again is expected.
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

  return job;
};

export const conclusionForError = (error: unknown): CheckConclusion => {
  return error instanceof CommandTimeoutError ? "timed_out" : "failure";
};

interface RunJobArgs {
  config: JobConfig;
  // biome-ignore lint/suspicious/noExplicitAny: user handler
  handler: (input: any) => Promise<void>;
  input: unknown;
}

/**
 * Run a job. Every direct call is its own run of the job: the first has the
 * job's ID as its path and is the one `from` shares, and each later call gets
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
 * Get the shared run of a job, the one `from` copies from: join it if it has
 * started, whether by a direct call or another job's `from`, or start it.
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

const jobBody = async ({
  run,
  config,
  handler,
  input,
  path,
  number,
}: RunJobArgs & {
  run: CiRunScope;
  /** The job's path: its ID, or `${id} (n)` for a later direct call. */
  path: string;
  /** Which run of this job in the pipeline run this is, counting from 1. */
  number: number;
}): Promise<void> => {
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
  };

  const configuredName =
    config.check === false ? undefined : config.check?.name;

  const checkName = configuredName
    ? `${configuredName}${number > 1 ? ` (${number})` : ""}`
    : undefined;
  const checked = config.check !== false;

  const target = {
    run,
    jobPath: scope.path,
    ...(checkName ? { name: checkName } : {}),
  };

  // A cached job is named after its parent's snapshot, so the parent comes
  // first: a parent that changed gives this job a new name, and a miss.
  const parent = parentOf(run, config, input);
  const base = parent ? await parentSnapshot(scope, parent) : undefined;

  if (config.cache) {
    run.ci.hooks.activity(run, scope.jobPath, "checking cache…");
  }

  const cacheAt = config.cache
    ? await cacheTarget(
        run,
        { id: config.id, path: scope.path },
        config.cache,
        input,
        base,
      )
    : undefined;

  const hit =
    config.cache && cacheAt
      ? await lookupCache(scope, config.cache, cacheAt)
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
    (await durableNow(run, `start:${scope.path}`, scope.path));

  if (checked) {
    run.openChecks.set(scope.path, checkName);
  }

  try {
    await runJobBody(scope, async () => {
      if (parent && base) {
        await startFrom(scope, parent, base);
      }

      return handler(input);
    });

    if (cacheAt) {
      await snapshotCached(scope, cacheAt);
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
        title: `Passed in ${formatDuration(Date.now() - startedAt)}`,
        ...(scope.summaries.length > 0
          ? { summary: scope.summaries.join("\n\n") }
          : {}),
        ...(scope.annotations.length > 0
          ? { annotations: scope.annotations }
          : {}),
      });
    }

    const endedAt =
      checkEndedAt ?? (await durableNow(run, `end:${scope.path}`, scope.path));
    const durationMs = endedAt - startedAt;

    run.summaries.push({
      path: scope.path,
      conclusion: "success",
      title: `Passed in ${formatDuration(durationMs)}`,
      durationMs,
    });
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
      checkEndedAt ?? (await durableNow(run, `end:${scope.path}`, scope.path));

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
  jobPath: string,
): Promise<number> => {
  return run.step.run({ id, name: id }, async () => {
    await tagStep(run, { kind: "job", job: jobPath });

    return Date.now();
  });
};

/** What a job's check says when its snapshot was found rather than built. */
const cachedTitle = (snapshot: CachedSnapshot): string => {
  return describeCached(snapshot.createdAt).replace(/^./, (first) => {
    return first.toUpperCase();
  });
};

/**
 * Take a snapshot found by name as this job's result, so the job doesn't run
 * and the jobs that start from it clone it. Returns the summary title.
 */
const restoreFromCache = (scope: CiJobScope, hit: CachedSnapshot): string => {
  const { run } = scope;

  run.cachedSnapshots.set(scope.path, hit);
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
 * Snapshot a cached job's machine under its name, once the job has passed. A
 * job that ran no commands has no machine, so there is nothing to snapshot,
 * and nothing for a cache to reuse.
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

  await snapshotJob(run, scope.path, { target });
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
