import type { CiRunScope } from "../scope.ts";
import type { CheckAnnotation, CheckConclusion } from "../types.ts";
import { formatDuration } from "../util.ts";
import type { GitHubProvider } from "./auth.ts";

/** GitHub truncates check output, so we do it first and say so. */
export const maxSummaryLength = 65_000;

/** GitHub accepts at most 50 annotations per request, and appends them. */
export const annotationBatchSize = 50;

/** How often a "current command" title update may be sent per check. */
export const titleThrottleMs = 10_000;

export interface CheckStartArgs {
  run: CiRunScope;
  /** `pipeline` for the pipeline check, or the job path. */
  key: string;
  name: string;
  title?: string;
}

export interface CheckCompleteArgs extends CheckStartArgs {
  conclusion: CheckConclusion;
  title: string;
  summary?: string;
  annotations?: CheckAnnotation[];
}

export interface CheckReporter {
  pipelineStart(args: { run: CiRunScope }): Promise<void>;
  pipelineComplete(args: {
    run: CiRunScope;
    conclusion: CheckConclusion;
    title: string;
    summary?: string;
  }): Promise<void>;
  jobStart(args: {
    run: CiRunScope;
    jobPath: string;
    name?: string;
  }): Promise<void>;
  jobComplete(args: {
    run: CiRunScope;
    jobPath: string;
    name?: string;
    conclusion: CheckConclusion;
    title: string;
    summary?: string;
    annotations?: CheckAnnotation[];
  }): Promise<void>;
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

export const truncateSummary = (summary: string): string =>
  summary.length <= maxSummaryLength
    ? summary
    : `${summary.slice(0, maxSummaryLength - 40)}\n\n_…truncated, see the trace._`;

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

  const jobCheckName = (run: CiRunScope, jobPath: string, name?: string) =>
    `${run.checkName ?? run.pipelineId} / ${name ?? jobPath}`;

  const start = async (
    run: CiRunScope,
    key: string,
    name: string,
    stepId: string,
  ) => {
    const externalId = `${run.runId}:${key}`;
    const detailsUrl = run.ci.runUrl({
      runId: run.runId,
      functionId: run.functionId,
    });

    const result = await run.step.run({ id: stepId, name: stepId }, () =>
      sink.start({ run, name, externalId, detailsUrl }),
    );

    if (result?.id) {
      checkRunIds.set(key, result.id);
    }
  };

  const complete = async (
    run: CiRunScope,
    key: string,
    name: string,
    stepId: string,
    args: {
      conclusion: CheckConclusion;
      title: string;
      summary?: string;
      annotations?: CheckAnnotation[];
    },
  ) => {
    const externalId = `${run.runId}:${key}`;
    const detailsUrl = run.ci.runUrl({
      runId: run.runId,
      functionId: run.functionId,
    });
    const checkRunId = checkRunIds.get(key);

    await run.step.run({ id: stepId, name: stepId }, () =>
      sink.complete({
        run,
        name,
        externalId,
        detailsUrl,
        conclusion: args.conclusion,
        title: args.title,
        summary: truncateSummary(args.summary ?? ""),
        annotations: (args.annotations ?? []).map(normaliseAnnotation),
        ...(checkRunId === undefined ? {} : { checkRunId }),
      }),
    );
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

    pipelineComplete: async ({ run, conclusion, title, summary }) => {
      if (!run.checkName) {
        return;
      }
      await complete(
        run,
        "pipeline",
        run.checkName,
        `github › check:${run.checkName}:complete`,
        { conclusion, title, ...(summary === undefined ? {} : { summary }) },
      );
    },

    jobStart: async ({ run, jobPath, name }) => {
      if (!run.checkName || !run.jobChecks) {
        return;
      }
      await start(
        run,
        jobPath,
        jobCheckName(run, jobPath, name),
        `github › check:${jobPath}:start`,
      );
    },

    jobComplete: async ({
      run,
      jobPath,
      name,
      conclusion,
      title,
      summary,
      annotations,
    }) => {
      if (!run.checkName || !run.jobChecks) {
        return;
      }
      await complete(
        run,
        jobPath,
        jobCheckName(run, jobPath, name),
        `github › check:${jobPath}:complete`,
        {
          conclusion,
          title,
          ...(summary === undefined ? {} : { summary }),
          ...(annotations === undefined ? {} : { annotations }),
        },
      );
    },

    commandRetry: async ({ run, jobPath, attempt, of, error }) => {
      if (!run.checkName || !run.jobChecks) {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);

      await run.step.run(
        {
          id: `github › check:${jobPath}:attempt:${attempt}`,
          name: `check:${jobPath}:attempt:${attempt}`,
        },
        () =>
          sink.update?.({
            run,
            name: jobCheckName(run, jobPath),
            title: `Attempt ${attempt} of ${of}: ${message.split("\n")[0]}`,
            ...(checkRunIds.has(jobPath)
              ? { checkRunId: checkRunIds.get(jobPath) as number }
              : {}),
          }) ?? Promise.resolve(null),
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
          ...(checkRunIds.has(jobPath)
            ? { checkRunId: checkRunIds.get(jobPath) as number }
            : {}),
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
  start: async () => ({}),
  complete: async () => undefined,
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
  const symbols: Record<string, string> = {
    success: "✓",
    failure: "✕",
    timed_out: "✕",
    cancelled: "⊘",
    neutral: "•",
    skipped: "•",
    stale: "•",
    action_required: "!",
  };

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
        `[${run.pipelineId}] ${symbols[conclusion] ?? "•"} ${name}  ${title}  → ${detailsUrl}`,
        { check: name, conclusion, url: detailsUrl },
      );
    },
    update: async ({ run, name, title }) => {
      write(`[${run.pipelineId}] … ${name}  ${title}`, { check: name });
    },
  };
};

/**
 * Real GitHub checks, through the Checks API.
 */
export const checksSink = (provider: GitHubProvider): CheckSink => ({
  start: async ({ run, name, externalId, detailsUrl }) => {
    const repo = run.repo;
    if (!repo?.sha) {
      return {};
    }

    const octokit = await provider.octokit({
      ...(repo.installationId === undefined
        ? {}
        : { installationId: repo.installationId }),
    });

    // A retried step must not create a second check run, so look for one this
    // run already created first.
    const existing = await octokit.rest.checks.listForRef({
      owner: repo.owner,
      repo: repo.name,
      ref: repo.sha,
      check_name: name,
    });

    const match = existing.data.check_runs.find(
      (checkRun) => checkRun.external_id === externalId,
    );

    if (match) {
      return { id: match.id };
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

    const octokit = await provider.octokit({
      ...(repo.installationId === undefined
        ? {}
        : { installationId: repo.installationId }),
    });

    let id = checkRunId;

    if (!id) {
      const existing = await octokit.rest.checks.listForRef({
        owner: repo.owner,
        repo: repo.name,
        ref: repo.sha,
        check_name: name,
      });
      id = existing.data.check_runs.find(
        (checkRun) => checkRun.external_id === externalId,
      )?.id;
    }

    const batches = batchAnnotations(annotations);

    const base = {
      owner: repo.owner,
      repo: repo.name,
      name,
      head_sha: repo.sha,
      details_url: detailsUrl,
      external_id: externalId,
    };

    if (!id) {
      const created = await octokit.rest.checks.create({
        ...base,
        status: "completed",
        conclusion,
        completed_at: new Date().toISOString(),
        output: {
          title,
          summary,
          ...(batches[0] ? { annotations: batches[0] } : {}),
        },
      });
      id = created.data.id;
    } else {
      await octokit.rest.checks.update({
        ...base,
        check_run_id: id,
        status: "completed",
        conclusion,
        completed_at: new Date().toISOString(),
        output: {
          title,
          summary,
          ...(batches[0] ? { annotations: batches[0] } : {}),
        },
      });
    }

    // GitHub appends annotations, so the rest go up in further updates.
    for (const batch of batches.slice(1)) {
      await octokit.rest.checks.update({
        ...base,
        check_run_id: id,
        output: { title, summary, annotations: batch },
      });
    }
  },

  update: async ({ run, name, title, checkRunId }) => {
    const repo = run.repo;
    if (!repo?.sha || !checkRunId) {
      return;
    }

    const octokit = await provider.octokit({
      ...(repo.installationId === undefined
        ? {}
        : { installationId: repo.installationId }),
    });

    await octokit.rest.checks.update({
      owner: repo.owner,
      repo: repo.name,
      check_run_id: checkRunId,
      output: { title: name, summary: title },
    });
  },
});

/**
 * Commit statuses, for token auth. There are no summaries or annotations.
 */
export const statusesSink = (provider: GitHubProvider): CheckSink => {
  const state = (
    conclusion: CheckConclusion,
  ): "error" | "failure" | "pending" | "success" => {
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

  const post = async (args: {
    run: CiRunScope;
    name: string;
    detailsUrl: string;
    status: "error" | "failure" | "pending" | "success";
    description: string;
  }) => {
    const repo = args.run.repo;
    if (!repo?.sha) {
      return;
    }

    const octokit = await provider.octokit({
      ...(repo.installationId === undefined
        ? {}
        : { installationId: repo.installationId }),
    });

    await octokit.rest.repos.createCommitStatus({
      owner: repo.owner,
      repo: repo.name,
      sha: repo.sha,
      state: args.status,
      context: args.name,
      target_url: args.detailsUrl,
      description: args.description.slice(0, 140),
    });
  };

  return {
    start: async ({ run, name, detailsUrl }) => {
      await post({
        run,
        name,
        detailsUrl,
        status: "pending",
        description: "Running",
      });
      return {};
    },
    complete: async ({ run, name, detailsUrl, conclusion, title }) => {
      await post({
        run,
        name,
        detailsUrl,
        status: state(conclusion),
        description: title,
      });
    },
  };
};

/**
 * The markdown summary on the pipeline check: a table of jobs, a trace link,
 * and any snapshots kept for debugging.
 */
export const pipelineSummary = (run: CiRunScope): string => {
  const rows = run.summaries.map(
    (summary) =>
      `| ${summary.path} | ${summary.conclusion} | ${summary.title} | ${formatDuration(summary.durationMs)} |`,
  );

  const kept = run.summaries
    .filter((summary) => summary.keptSnapshotId)
    .map(
      (summary) =>
        `- \`${summary.path}\` kept as snapshot \`${summary.keptSnapshotId}\``,
    );

  return [
    "| Job | Result | Detail | Duration |",
    "| --- | --- | --- | --- |",
    ...(rows.length > 0 ? rows : ["| _no jobs ran_ |  |  |  |"]),
    "",
    `[View the trace](${run.ci.runUrl({ runId: run.runId, functionId: run.functionId })})`,
    ...(kept.length > 0 ? ["", "**Kept machines**", ...kept] : []),
    ...(run.warnings.length > 0
      ? ["", "**Notes**", ...run.warnings.map((warning) => `- ${warning}`)]
      : []),
  ].join("\n");
};

/**
 * Only for tests: forget the title-update throttle.
 */
export const resetTitleThrottle = (): void => {
  lastTitleUpdate.clear();
};
