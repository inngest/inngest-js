/**
 * Reporting pipeline and job progress as GitHub check runs, commit statuses or
 * console output, and the summaries shown on them.
 *
 * @module
 */

import type { CiRunScope } from "../pipeline/scope.ts";
import type { CheckAnnotation, CheckConclusion } from "../types.ts";
import { errorMessage, formatDuration } from "../util.ts";
import type { GitHubProvider, Octokit } from "./auth.ts";

/**
 * GitHub rejects `output.summary` over 65535 bytes (not characters), so we
 * truncate to 65,000 bytes first, leaving room for the truncation note.
 */
export const maxSummaryBytes = 65_000;

/** GitHub accepts at most 50 annotations per request, and appends them. */
export const annotationBatchSize = 50;

/** How often a "current command" title update may be sent per check. */
export const titleThrottleMs = 10_000;

/** What a check is told when it finishes. */
interface CheckResult {
  conclusion: CheckConclusion;
  title: string;
  summary?: string | undefined;
  annotations?: CheckAnnotation[] | undefined;
}

export interface CheckReporter {
  pipelineStart(args: { run: CiRunScope }): Promise<void>;
  pipelineComplete(
    args: { run: CiRunScope } & Omit<CheckResult, "annotations">,
  ): Promise<void>;
  /**
   * Start a job's check. Returns when the job started, read inside the step so
   * it's memoized, or `undefined` when there's no check to start.
   */
  jobStart(args: {
    run: CiRunScope;
    jobPath: string;
    name?: string;
  }): Promise<number | undefined>;
  jobComplete(
    args: { run: CiRunScope; jobPath: string; name?: string } & CheckResult,
  ): Promise<void>;
  commandRetry(args: {
    run: CiRunScope;
    jobPath: string;
    attempt: number;
    of: number;
    error: unknown;
  }): Promise<void>;
  /** Best-effort "running `pnpm test`" title update. Never fails a command. */
  currentCommand(args: {
    run: CiRunScope;
    jobPath: string;
    command: string;
  }): Promise<void>;
}

/**
 * What a reporter actually does with a transition. Everything above this is
 * shared: step wrapping, naming, truncation, and batching.
 */
export interface CheckSink {
  start(args: {
    run: CiRunScope;
    name: string;
    externalId: string;
    detailsUrl: string;
    title?: string;
  }): Promise<{ id?: number }>;
  complete(args: {
    run: CiRunScope;
    name: string;
    externalId: string;
    detailsUrl: string;
    conclusion: CheckConclusion;
    title: string;
    summary: string;
    annotations: NormalisedAnnotation[];
    checkRunId?: number;
  }): Promise<void>;
  update?(args: {
    run: CiRunScope;
    name: string;
    title: string;
    checkRunId?: number;
  }): Promise<void>;
}

/** An annotation in the shape GitHub's Checks API wants. */
export interface NormalisedAnnotation {
  path: string;
  message: string;
  start_line: number;
  end_line: number;
  annotation_level: "notice" | "warning" | "failure";
  title?: string;
  raw_details?: string;
}

/** Cut to `maxSummaryBytes` of UTF-8, never splitting a code point. */
export const truncateSummary = (summary: string): string => {
  const bytes = Buffer.from(summary, "utf8");

  if (bytes.length <= maxSummaryBytes) {
    return summary;
  }

  const notice = "\n\n_…truncated, see the trace._";
  let end = maxSummaryBytes - Buffer.byteLength(notice);

  // Back up over continuation bytes (10xxxxxx) to the start of a code point.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end--;
  }

  return `${bytes.subarray(0, end).toString("utf8")}${notice}`;
};

export const batchAnnotations = (
  annotations: NormalisedAnnotation[],
): NormalisedAnnotation[][] => {
  const batches: NormalisedAnnotation[][] = [];

  for (let i = 0; i < annotations.length; i += annotationBatchSize) {
    batches.push(annotations.slice(i, i + annotationBatchSize));
  }

  return batches;
};

/**
 * Normalise a user-supplied annotation into GitHub's shape.
 */
export const normaliseAnnotation = (
  annotation: CheckAnnotation,
): NormalisedAnnotation => {
  const start = annotation.start_line ?? annotation.line ?? 1;

  return {
    path: annotation.path,
    message: annotation.message,
    start_line: start,
    end_line: annotation.end_line ?? start,
    annotation_level: annotation.annotation_level ?? "failure",
    ...(annotation.title ? { title: annotation.title } : {}),
    ...(annotation.raw_details ? { raw_details: annotation.raw_details } : {}),
  };
};

const lastTitleUpdate = new Map<string, number>();

/**
 * Build the reporter used by every pipeline run.
 *
 * Every GitHub call is a `step.run`, so a check is never created twice, even
 * when a step retries.
 */
export const createCheckReporter = (sink: CheckSink): CheckReporter => {
  const checkRunIds = new Map<string, number>();

  const jobCheckName = (run: CiRunScope, jobPath: string, name?: string) => {
    return `${run.checkName ?? run.pipelineId} / ${name ?? jobPath}`;
  };

  const identity = (run: CiRunScope, key: string) => {
    return {
      externalId: `${run.runId}:${key}`,
      detailsUrl: run.ci.runUrl({
        runId: run.runId,
        functionId: run.functionId,
      }),
    };
  };

  const idFor = (key: string) => {
    const checkRunId = checkRunIds.get(key);

    return checkRunId === undefined ? {} : { checkRunId };
  };

  const start = async (
    run: CiRunScope,
    key: string,
    name: string,
    stepId: string,
  ) => {
    const result = await run.step.run(
      { id: stepId, name: stepId },
      async () => {
        const started = await sink.start({ run, name, ...identity(run, key) });

        return { ...started, startedAt: Date.now() };
      },
    );

    if (result?.id) {
      checkRunIds.set(key, result.id);
    }

    return result?.startedAt;
  };

  const complete = async (
    run: CiRunScope,
    key: string,
    name: string,
    stepId: string,
    result: CheckResult,
  ) => {
    await run.step.run({ id: stepId, name: stepId }, () => {
      return sink.complete({
        run,
        name,
        ...identity(run, key),
        conclusion: result.conclusion,
        title: result.title,
        summary: truncateSummary(result.summary ?? ""),
        annotations: (result.annotations ?? []).map(normaliseAnnotation),
        ...idFor(key),
      });
    });
  };

  return {
    pipelineStart: async ({ run }) => {
      if (!run.checkName) {
        return;
      }

      await start(
        run,
        "pipeline",
        run.checkName,
        `github › check:${run.checkName}:start`,
      );
    },

    pipelineComplete: async ({ run, ...result }) => {
      if (!run.checkName) {
        return;
      }

      await complete(
        run,
        "pipeline",
        run.checkName,
        `github › check:${run.checkName}:complete`,
        result,
      );
    },

    jobStart: async ({ run, jobPath, name }) => {
      if (!run.checkName || !run.jobChecks) {
        return undefined;
      }

      return start(
        run,
        jobPath,
        jobCheckName(run, jobPath, name),
        `github › check:${jobPath}:start`,
      );
    },

    jobComplete: async ({ run, jobPath, name, ...result }) => {
      if (!run.checkName || !run.jobChecks) {
        return;
      }

      await complete(
        run,
        jobPath,
        jobCheckName(run, jobPath, name),
        `github › check:${jobPath}:complete`,
        result,
      );
    },

    commandRetry: async ({ run, jobPath, attempt, of, error }) => {
      if (!run.checkName || !run.jobChecks) {
        return;
      }

      const message = errorMessage(error).split("\n")[0];

      await run.step.run(
        {
          id: `github › check:${jobPath}:attempt:${attempt}`,
          name: `check:${jobPath}:attempt:${attempt}`,
        },
        async () => {
          await sink.update?.({
            run,
            name: jobCheckName(run, jobPath),
            title: `Attempt ${attempt} of ${of}: ${message}`,
            ...idFor(jobPath),
          });

          return null;
        },
      );
    },

    currentCommand: async ({ run, jobPath, command }) => {
      if (!run.checkName || !run.jobChecks || !sink.update) {
        return;
      }

      // Title updates aren't steps: they're cosmetic, throttled, and a failed
      // one must never fail the command it was describing.
      const key = `${run.runId}:${jobPath}`;
      const now = Date.now();

      if (now - (lastTitleUpdate.get(key) ?? 0) < titleThrottleMs) {
        return;
      }

      lastTitleUpdate.set(key, now);

      try {
        await sink.update({
          run,
          name: jobCheckName(run, jobPath),
          title: `Running \`${command}\``,
          ...idFor(jobPath),
        });
      } catch {
        // Best effort.
      }
    },
  };
};

/**
 * A reporter that does nothing, used when there's no provider.
 */
export const noopSink: CheckSink = {
  start: async () => {
    return {};
  },
  complete: async () => {
    return undefined;
  },
};

const conclusionSymbols: Record<string, string> = {
  success: "✓",
  failure: "✕",
  timed_out: "✕",
  cancelled: "⊘",
  neutral: "•",
  skipped: "•",
  stale: "•",
  action_required: "!",
};

/**
 * Prints each transition to the SDK logger, one line per transition.
 */
export const consoleSink = (
  // biome-ignore lint/suspicious/noExplicitAny: any logger-ish
  logger: { info: (...args: any[]) => void } | undefined,
  history: Array<{
    at: string;
    pipeline: string;
    name: string;
    status: "in_progress" | "completed";
    conclusion?: string;
    title?: string;
    url?: string;
  }>,
): CheckSink => {
  const write = (line: string, meta: Record<string, unknown>) => {
    (logger ?? console).info(meta, line);
  };

  return {
    start: async ({ run, name, detailsUrl }) => {
      history.push({
        at: new Date().toISOString(),
        pipeline: run.pipelineId,
        name,
        status: "in_progress",
        url: detailsUrl,
      });

      write(`[${run.pipelineId}] … ${name}`, { check: name, url: detailsUrl });

      return {};
    },
    complete: async ({ run, name, conclusion, title, detailsUrl }) => {
      history.push({
        at: new Date().toISOString(),
        pipeline: run.pipelineId,
        name,
        status: "completed",
        conclusion,
        title,
        url: detailsUrl,
      });

      write(
        `[${run.pipelineId}] ${conclusionSymbols[conclusion] ?? "•"} ${name}  ${title}  → ${detailsUrl}`,
        { check: name, conclusion, url: detailsUrl },
      );
    },
    update: async ({ run, name, title }) => {
      write(`[${run.pipelineId}] … ${name}  ${title}`, { check: name });
    },
  };
};

type Repo = NonNullable<CiRunScope["repo"]>;

const clientFor = (provider: GitHubProvider, repo: Repo) => {
  return provider.octokit(
    repo.installationId === undefined
      ? {}
      : { installationId: repo.installationId },
  );
};

/**
 * Real GitHub checks, through the Checks API.
 */
export const checksSink = (provider: GitHubProvider): CheckSink => {
  // A retried step must not create a second check run, so look for one this
  // run already created.
  const findCheckRun = async (
    octokit: Octokit,
    repo: Repo,
    name: string,
    externalId: string,
  ) => {
    const existing = await octokit.rest.checks.listForRef({
      owner: repo.owner,
      repo: repo.name,
      ref: repo.sha,
      check_name: name,
    });

    return existing.data.check_runs.find((checkRun) => {
      return checkRun.external_id === externalId;
    })?.id;
  };

  return {
    start: async ({ run, name, externalId, detailsUrl }) => {
      const repo = run.repo;

      if (!repo?.sha) {
        return {};
      }

      const octokit = await clientFor(provider, repo);
      const existingId = await findCheckRun(octokit, repo, name, externalId);

      if (existingId !== undefined) {
        return { id: existingId };
      }

      const created = await octokit.rest.checks.create({
        owner: repo.owner,
        repo: repo.name,
        name,
        head_sha: repo.sha,
        status: "in_progress",
        external_id: externalId,
        details_url: detailsUrl,
        started_at: new Date().toISOString(),
      });

      return { id: created.data.id };
    },

    complete: async ({
      run,
      name,
      externalId,
      detailsUrl,
      conclusion,
      title,
      summary,
      annotations,
      checkRunId,
    }) => {
      const repo = run.repo;

      if (!repo?.sha) {
        return;
      }

      const octokit = await clientFor(provider, repo);

      const id =
        checkRunId ?? (await findCheckRun(octokit, repo, name, externalId));

      const [firstBatch, ...otherBatches] = batchAnnotations(annotations);

      const base = {
        owner: repo.owner,
        repo: repo.name,
        name,
        head_sha: repo.sha,
        details_url: detailsUrl,
        external_id: externalId,
      };

      const completed = {
        ...base,
        status: "completed" as const,
        conclusion,
        completed_at: new Date().toISOString(),
        output: {
          title,
          summary,
          ...(firstBatch ? { annotations: firstBatch } : {}),
        },
      };

      const checkRun =
        id === undefined
          ? await octokit.rest.checks.create(completed)
          : await octokit.rest.checks.update({
              ...completed,
              check_run_id: id,
            });

      // GitHub appends annotations, so the rest go up in further updates.
      for (const batch of otherBatches) {
        await octokit.rest.checks.update({
          ...base,
          check_run_id: checkRun.data.id,
          output: { title, summary, annotations: batch },
        });
      }
    },

    update: async ({ run, name, title, checkRunId }) => {
      const repo = run.repo;

      if (!repo?.sha || checkRunId === undefined) {
        return;
      }

      const octokit = await clientFor(provider, repo);

      // `output.summary` is required on every update and replaces what's
      // there, so send back what the check already shows.
      const current = await octokit.rest.checks.get({
        owner: repo.owner,
        repo: repo.name,
        check_run_id: checkRunId,
      });

      await octokit.rest.checks.update({
        owner: repo.owner,
        repo: repo.name,
        check_run_id: checkRunId,
        output: { title, summary: current.data.output?.summary || name },
      });
    },
  };
};

type StatusState = "error" | "failure" | "pending" | "success";

const statusFor = (conclusion: CheckConclusion): StatusState => {
  switch (conclusion) {
    case "success":
    case "neutral":
    case "skipped":
      return "success";
    case "failure":
    case "timed_out":
      return "failure";
    default:
      return "error";
  }
};

/**
 * Commit statuses, for token auth. There are no summaries or annotations.
 */
export const statusesSink = (provider: GitHubProvider): CheckSink => {
  const post = async (
    run: CiRunScope,
    name: string,
    detailsUrl: string,
    state: StatusState,
    description: string,
  ) => {
    const repo = run.repo;

    if (!repo?.sha) {
      return;
    }

    const octokit = await clientFor(provider, repo);

    await octokit.rest.repos.createCommitStatus({
      owner: repo.owner,
      repo: repo.name,
      sha: repo.sha,
      state,
      context: name,
      target_url: detailsUrl,
      description: description.slice(0, 140),
    });
  };

  return {
    start: async ({ run, name, detailsUrl }) => {
      await post(run, name, detailsUrl, "pending", "Running");

      return {};
    },
    complete: async ({ run, name, detailsUrl, conclusion, title }) => {
      await post(run, name, detailsUrl, statusFor(conclusion), title);
    },
  };
};

/**
 * The markdown summary on the pipeline check: a table of jobs, a trace link,
 * and any snapshots kept for debugging.
 */
export const pipelineSummary = (run: CiRunScope): string => {
  const rows = run.summaries.map((summary) => {
    return `| ${summary.path} | ${summary.conclusion} | ${summary.title} | ${formatDuration(summary.durationMs)} |`;
  });

  const kept = run.summaries
    .filter((summary) => {
      return summary.keptSnapshotId;
    })
    .map((summary) => {
      return `- \`${summary.path}\` kept as snapshot \`${summary.keptSnapshotId}\``;
    });

  return [
    "| Job | Result | Detail | Duration |",
    "| --- | --- | --- | --- |",
    ...(rows.length > 0 ? rows : ["| _no jobs ran_ |  |  |  |"]),
    "",
    `[View the trace](${run.ci.runUrl({ runId: run.runId, functionId: run.functionId })})`,
    ...(kept.length > 0 ? ["", "**Kept machines**", ...kept] : []),
    ...(run.warnings.length > 0
      ? [
          "",
          "**Notes**",
          ...run.warnings.map((warning) => {
            return `- ${warning}`;
          }),
        ]
      : []),
  ].join("\n");
};

/**
 * Only for tests: forget the title-update throttle.
 */
export const resetTitleThrottle = (): void => {
  lastTitleUpdate.clear();
};
