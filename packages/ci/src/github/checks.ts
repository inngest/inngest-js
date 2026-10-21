/**
 * Reporting pipeline and job progress as GitHub check runs, commit statuses or
 * console output, and the summaries shown on them.
 *
 * @module
 */

import { runLinks } from "../pipeline/jobReport.ts";
import { ciRun } from "../pipeline/metadata.ts";
import { type StepSpec, steps } from "../pipeline/names.ts";
import { markJob, pipelinePayload } from "../pipeline/pipelineReport.ts";
import type { CiRunScope } from "../pipeline/scope.ts";
import { inGitHubSpan } from "../pipeline/scope.ts";
import type { CheckAnnotation, CheckConclusion } from "../types.ts";
import {
  errorMessage,
  formatDuration,
  maxStatusDescription,
  stripAnsi,
  truncateLabel,
} from "../util.ts";
import type { GitHubProvider, Octokit } from "./auth.ts";
import type { GraphJob } from "./render/graph.ts";
import { jobCheck } from "./render/job.ts";
import { pipelineCheck } from "./render/pipeline.ts";
import {
  type CheckAction,
  type CheckPayload,
  rerunAllAction,
} from "./render/types.ts";

/**
 * GitHub rejects `output.summary` over 65535 bytes (not characters), so we
 * truncate to 65,000 bytes first, leaving room for the truncation note.
 */
export const maxSummaryBytes = 65_000;

/** GitHub accepts at most 50 annotations per request, and appends them. */
export const annotationBatchSize = 50;

/** What a check is told when it finishes. */
interface CheckResult {
  conclusion: CheckConclusion;
  title: string;
  summary?: string | undefined;
  /** Long output, shown below the summary. */
  text?: string | undefined;
  /** The buttons the check ends with. Without them it gets the defaults. */
  actions?: CheckAction[] | undefined;
  annotations?: CheckAnnotation[] | undefined;
}

/** What a check that is waiting or running offers: ending the run. */
const runningActions: CheckAction[] = [
  { label: "Cancel", description: "Stop this run", identifier: "cancel" },
];

/** What a failed check offers: running again without the cache. */
const failedActions: CheckAction[] = [
  {
    label: "Re-run, no cache",
    description: "Run again from scratch",
    identifier: "rerun-fresh",
  },
];

/** A job whose check is completed when the run ends. */
export interface ClosingJob extends CheckResult {
  jobPath: string;
  /** The check's name, when the job set one. */
  name?: string;
}

/** Run metadata to attach to the pipeline check's step, read inside the step. */
interface RunMetadata {
  metadata?: () => Record<string, unknown>;
}

export interface CheckReporter {
  /**
   * Start the pipeline's check. Returns when the run started, read inside the
   * step so it's memoized, or `undefined` when checks are off.
   */
  pipelineStart(
    args: { run: CiRunScope } & RunMetadata,
  ): Promise<number | undefined>;
  /**
   * Complete the pipeline's check. What it says is read inside the step, when
   * it runs, because the run's summaries and warnings are only complete then.
   */
  pipelineComplete(
    args: { run: CiRunScope } & RunMetadata & {
        result: () => CheckResult;
      },
  ): Promise<void>;
  /**
   * Complete every check a cancelled run left in progress, its jobs' as well
   * as the pipeline's. Jobs run inside the run, so nothing of theirs runs when
   * it's cancelled; the checks are found on GitHub instead. It isn't a step:
   * the caller makes it durable, and there is no run to read, so the run is
   * only what the sinks read.
   */
  runCancelled(args: {
    run: Pick<CiRunScope, "runId" | "checkName" | "repo">;
  }): Promise<void>;
  /**
   * Show a job's check as queued: the job is known but hasn't started. Its
   * start later moves the same check to in progress.
   */
  jobQueued(args: {
    run: CiRunScope;
    jobPath: string;
    name?: string;
    payload?: CheckPayload;
  }): Promise<void>;
  /**
   * Start a job's check. Returns when the job started, read inside the step so
   * it's memoized, or `undefined` when there's no check to start.
   */
  jobStart(args: {
    run: CiRunScope;
    jobPath: string;
    name?: string;
    payload?: CheckPayload;
  }): Promise<number | undefined>;
  /**
   * Complete a job's check. Returns when it completed, read inside the step so
   * it's memoized, or `undefined` when there's no check to complete.
   */
  jobComplete(
    args: { run: CiRunScope; jobPath: string; name?: string } & CheckResult,
  ): Promise<number | undefined>;
  /**
   * Complete the checks of every job still open when the run ended, in one
   * step. Which jobs are open depends on how far each sibling got in that
   * request, so one step per job could be found on one request and missing on
   * the next, and the jobs are read inside the step, when it runs. Returns the
   * jobs it completed, memoized, or the jobs as read when checks are off.
   */
  jobsComplete(args: {
    run: CiRunScope;
    jobs: () => ClosingJob[];
  }): Promise<Array<Omit<ClosingJob, "summary" | "annotations">>>;
  /**
   * Keep a check in progress with a retry title, because the run will be
   * attempted again and its own completion belongs to a later attempt. With no
   * `jobPath` it's the pipeline's check.
   */
  retrying(args: {
    run: CiRunScope;
    jobPath?: string;
    name?: string;
    title: string;
  }): Promise<void>;
  /**
   * Show a running job's check as it stands, when a command starts. The one before it is done by then.
   * What it says is read inside the step, so it is the state at that moment.
   */
  jobProgress(args: {
    run: CiRunScope;
    jobPath: string;
    name?: string;
    /** How many commands have started or finished, which names the step. */
    count: number;
    payload: () => CheckPayload;
  }): Promise<void>;
  commandRetry(args: {
    run: CiRunScope;
    jobPath: string;
    attempt: number;
    of: number;
    error: unknown;
  }): Promise<void>;
  /**
   * A job's check as another run can find it: its name and, once started, its
   * ID. `undefined` when the job has no check.
   */
  target(args: {
    run: CiRunScope;
    jobPath: string;
    name?: string;
  }): { name: string; checkRunId?: number } | undefined;
  /**
   * Tell the invoking run's check for a job that this run is building its
   * entry, with a link to this run. Nothing is posted for a build run's own
   * checks, which it doesn't have.
   */
  building(args: { run: CiRunScope; detailsUrl: string }): Promise<void>;
}

/**
 * What a reporter actually does with a transition. Everything above this is
 * shared: step wrapping, naming, truncation, and batching.
 */
export interface CheckSink {
  /**
   * Show a check as `queued` or `in_progress`. A check already shown moves
   * to the state asked for rather than being made again.
   */
  start(args: {
    run: CiRunScope;
    state: "queued" | "in_progress";
    name: string;
    externalId: string;
    detailsUrl: string;
    /** What the check shows and offers while it waits or runs. */
    payload?: CheckPayload;
  }): Promise<{ id?: number }>;
  complete(args: {
    run: CiRunScope;
    name: string;
    externalId: string;
    detailsUrl: string;
    conclusion: CheckConclusion;
    title: string;
    summary: string;
    text?: string;
    /** At most the first batch: the reporter sends the rest through `annotate`. */
    annotations: NormalisedAnnotation[];
    actions?: CheckAction[];
    checkRunId?: number;
  }): Promise<void>;
  /** Complete the run's checks that are still in progress, as cancelled. */
  closeOpen?(args: {
    run: Pick<CiRunScope, "runId" | "repo">;
    title: string;
  }): Promise<void>;
  /**
   * Add a batch of annotations to a completed check. GitHub takes 50 a
   * request and appends them, so the reporter sends each batch past the first
   * as a step of its own.
   */
  annotate?(args: {
    run: CiRunScope;
    name: string;
    externalId: string;
    detailsUrl: string;
    title: string;
    summary: string;
    annotations: NormalisedAnnotation[];
    checkRunId?: number;
  }): Promise<void>;
  update?(args: {
    run: CiRunScope;
    name: string;
    title: string;
    /** What the check shows below its title. Without it the check keeps its own. */
    summary?: string;
    text?: string;
    /** The buttons the check shows, which an update would otherwise clear. */
    actions?: CheckAction[];
    checkRunId?: number;
    /** Points the check's link at another run. */
    detailsUrl?: string;
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
    message: stripAnsi(annotation.message),
    start_line: start,
    end_line: annotation.end_line ?? start,
    annotation_level: annotation.annotation_level ?? "failure",
    ...(annotation.title ? { title: stripAnsi(annotation.title) } : {}),
    ...(annotation.raw_details
      ? { raw_details: stripAnsi(annotation.raw_details) }
      : {}),
  };
};

/** Run a check update as a step in the run's GitHub span. */
const githubStep = <T>(
  run: CiRunScope,
  spec: StepSpec,
  fn: () => Promise<T>,
  runValues?: () => Record<string, unknown>,
): Promise<T> => {
  return inGitHubSpan(run, () => {
    return ciRun(run, spec, fn, runValues);
  });
};

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

  const idKey = (run: CiRunScope, key: string) => {
    return `${run.runId}:${key}`;
  };

  const idFor = (run: CiRunScope, key: string) => {
    const checkRunId = checkRunIds.get(idKey(run, key));

    return checkRunId === undefined ? {} : { checkRunId };
  };

  /** What `sink.complete` is given for a finished check. */
  const completeArgs = (
    run: CiRunScope,
    key: string,
    name: string,
    read: CheckResult,
  ) => {
    return {
      run,
      name,
      ...identity(run, key),
      conclusion: read.conclusion,
      title: stripAnsi(read.title),
      summary: truncateSummary(stripAnsi(read.summary ?? "")),
      ...(read.text === undefined
        ? {}
        : { text: truncateSummary(stripAnsi(read.text)) }),
      annotations:
        batchAnnotations(
          (read.annotations ?? []).map(normaliseAnnotation),
        )[0] ?? [],
      actions:
        read.actions ??
        (read.conclusion === "failure" || read.conclusion === "timed_out"
          ? failedActions
          : []),
      ...idFor(run, key),
    };
  };

  /**
   * Bring the pipeline's check up to date when a job's check completes, in the
   * same step: it is a request, not a step. It never fails the job's.
   */
  const showPipelineProgress = async (run: CiRunScope) => {
    if (!run.checkName) {
      return;
    }

    try {
      const shown = pipelinePayload(run, "running");

      await sink.update?.({
        run,
        name: run.checkName,
        title: shown.title,
        summary: shown.summary,
        ...(shown.text === undefined ? {} : { text: shown.text }),
        actions: shown.actions,
        ...idFor(run, "pipeline"),
      });
    } catch {
      // The pipeline's check says the same at the end.
    }
  };

  /** A job's check, or the pipeline's when there's no `job`. */
  const start = async (
    run: CiRunScope,
    name: string,
    job?: string,
    metadata?: () => Record<string, unknown>,
    state: "queued" | "in_progress" = "in_progress",
    payload?: CheckPayload,
  ) => {
    const key = job ?? "pipeline";

    const shown =
      payload ??
      (job === undefined
        ? pipelinePayload(run, "running")
        : jobCheck({
            ...runLinks(run),
            name: job,
            state:
              state === "queued" ? { kind: "queued" } : { kind: "running" },
          }));

    const result = await githubStep(
      run,
      state === "queued"
        ? steps.queueCheck(name, job)
        : steps.startCheck(name, job),
      async () => {
        const started = await sink.start({
          run,
          state,
          name,
          ...identity(run, key),
          ...(shown ? { payload: shown } : {}),
        });

        return { ...started, startedAt: Date.now() };
      },
      metadata,
    );

    if (result?.id) {
      checkRunIds.set(idKey(run, key), result.id);

      if (job !== undefined) {
        markJob(run, job, { checkRunId: result.id });
      }
    }

    return result?.startedAt;
  };

  const complete = async (
    run: CiRunScope,
    name: string,
    result: () => CheckResult,
    job?: { path: string; conclusion: CheckConclusion },
    metadata?: () => Record<string, unknown>,
  ): Promise<number> => {
    const key = job?.path ?? "pipeline";

    const done = await githubStep(
      run,
      steps.completeCheck(name, job),
      async () => {
        const read = result();
        const args = completeArgs(run, key, name, read);

        await sink.complete(args);

        if (job) {
          await showPipelineProgress(run);
        }

        // What is past the first batch comes out of the step, so it is the
        // same on every replay.
        return {
          endedAt: Date.now(),
          rest: batchAnnotations(
            (read.annotations ?? []).map(normaliseAnnotation),
          ).slice(1),
          title: args.title,
          summary: args.summary,
        };
      },
      metadata,
    );

    // Each batch is a step of its own, so a retry can't add one twice.
    for (const [index, batch] of done.rest.entries()) {
      await githubStep(
        run,
        steps.annotateCheck(name, index + 2, job?.path),
        async () => {
          await sink.annotate?.({
            run,
            name,
            ...identity(run, key),
            title: done.title,
            summary: done.summary,
            annotations: batch,
            ...idFor(run, key),
          });

          return null;
        },
      );
    }

    checkRunIds.delete(idKey(run, key));

    return done.endedAt;
  };

  return {
    pipelineStart: async ({ run, metadata }) => {
      if (!run.checkName) {
        return undefined;
      }

      return start(run, run.checkName, undefined, metadata);
    },

    pipelineComplete: async ({ run, metadata, result }) => {
      if (!run.checkName) {
        return;
      }

      await complete(run, run.checkName, result, undefined, metadata);
    },

    runCancelled: async ({ run }) => {
      if (run.checkName) {
        await sink.closeOpen?.({ run, title: "Cancelled" });
      }
    },

    jobQueued: async ({ run, jobPath, name, payload }) => {
      if (!run.checkName || !run.jobChecks) {
        return;
      }

      await start(
        run,
        jobCheckName(run, jobPath, name),
        jobPath,
        undefined,
        "queued",
        payload,
      );
    },

    jobStart: async ({ run, jobPath, name, payload }) => {
      if (!run.checkName || !run.jobChecks) {
        return undefined;
      }

      return start(
        run,
        jobCheckName(run, jobPath, name),
        jobPath,
        undefined,
        "in_progress",
        payload,
      );
    },

    jobComplete: async ({ run, jobPath, name, ...result }) => {
      if (!run.checkName || !run.jobChecks) {
        return undefined;
      }

      return complete(
        run,
        jobCheckName(run, jobPath, name),
        () => {
          return result;
        },
        { path: jobPath, conclusion: result.conclusion },
      );
    },

    jobsComplete: async ({ run, jobs: read }) => {
      const closing = (jobs: ClosingJob[]) => {
        return jobs.map(({ jobPath, name, conclusion, title }) => {
          return { jobPath, ...(name ? { name } : {}), conclusion, title };
        });
      };

      if (!run.checkName || !run.jobChecks) {
        return closing(read());
      }

      const closed = await githubStep(
        run,
        steps.completeJobChecks(),
        async () => {
          const jobs = read();

          for (const { jobPath, name, ...result } of jobs) {
            const check = jobCheckName(run, jobPath, name);

            await sink.complete(completeArgs(run, jobPath, check, result));
          }

          return closing(jobs);
        },
      );

      // Outside the step, so a replay also forgets the IDs its memoized start
      // steps put back.
      for (const { jobPath } of closed) {
        checkRunIds.delete(idKey(run, jobPath));
      }

      return closed;
    },

    retrying: async ({ run, jobPath, name, title }) => {
      if (!run.checkName || (jobPath !== undefined && !run.jobChecks)) {
        return;
      }

      const key = jobPath ?? "pipeline";
      const checkName =
        jobPath === undefined
          ? run.checkName
          : jobCheckName(run, jobPath, name);
      const step = steps.retryCheck(
        checkName,
        run.attempt,
        run.maxAttempts,
        jobPath,
      );

      await githubStep(run, step, async () => {
        await sink.update?.({
          run,
          name: checkName,
          title,
          actions: runningActions,
          ...idFor(run, key),
        });

        return null;
      });
    },

    jobProgress: async ({ run, jobPath, name, count, payload }) => {
      const parent = run.build?.parent;
      const check = parent?.check;

      // A job in a run of its own has no check there: it shows on the check of
      // the run that invoked it.
      if (parent && check) {
        await githubStep(run, steps.progressCheck(jobPath, count), async () => {
          const read = payload();

          await sink.update?.({
            run: { ...run, runId: parent.runId, pipelineId: parent.pipelineId },
            name: check.name,
            title: read.title,
            summary: read.summary,
            actions: read.actions,
            ...(check.checkRunId === undefined
              ? {}
              : { checkRunId: check.checkRunId }),
          });

          return null;
        });

        return;
      }

      if (!run.checkName || !run.jobChecks) {
        return;
      }

      await githubStep(run, steps.progressCheck(jobPath, count), async () => {
        const read = payload();

        await sink.update?.({
          run,
          name: jobCheckName(run, jobPath, name),
          title: read.title,
          summary: read.summary,
          ...(read.text === undefined ? {} : { text: read.text }),
          actions: read.actions,
          ...idFor(run, jobPath),
        });

        return null;
      });
    },

    commandRetry: async ({ run, jobPath, attempt, of, error }) => {
      if (!run.checkName || !run.jobChecks) {
        return;
      }

      const message = errorMessage(error).split("\n")[0];

      const step = steps.failedAttempt(jobPath, attempt, of);

      await githubStep(run, step, async () => {
        await sink.update?.({
          run,
          name: jobCheckName(run, jobPath),
          title: `Attempt ${attempt} of ${of}: ${message}`,
          actions: runningActions,
          ...idFor(run, jobPath),
        });

        return null;
      });
    },

    target: ({ run, jobPath, name }) => {
      if (!run.checkName || !run.jobChecks) {
        return undefined;
      }

      return {
        name: jobCheckName(run, jobPath, name),
        ...idFor(run, jobPath),
      };
    },

    building: async ({ run, detailsUrl }) => {
      const check = run.build?.parent.check;

      if (!run.build || !check) {
        return;
      }

      const { parent, direct } = run.build;

      const step = steps.buildingCheck(parent.jobPath);

      const shown = jobCheck({
        ...runLinks(run),
        run: detailsUrl,
        name: parent.jobPath,
        state: direct ? { kind: "running" } : { kind: "building" },
      });

      await githubStep(run, step, async () => {
        await sink.update?.({
          // The check belongs to the pipeline run that invoked this one.
          run: { ...run, runId: parent.runId, pipelineId: parent.pipelineId },
          name: check.name,
          title: direct ? "Running in its own run" : "Building in its own run",
          summary: shown.summary,
          actions: shown.actions,
          detailsUrl,
          ...(check.checkRunId === undefined
            ? {}
            : { checkRunId: check.checkRunId }),
        });

        return null;
      });
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
    status: "queued" | "in_progress" | "updated" | "completed";
    conclusion?: string;
    title?: string;
    summary?: string;
    annotations?: Array<{
      path: string;
      start_line: number;
      annotation_level: string;
      title?: string;
      message: string;
    }>;
    url?: string;
  }>,
): CheckSink => {
  const write = (line: string, meta: Record<string, unknown>) => {
    (logger ?? console).info(meta, line);
  };

  return {
    start: async ({ run, state, name, detailsUrl, payload }) => {
      history.push({
        at: new Date().toISOString(),
        pipeline: run.pipelineId,
        name,
        status: state,
        ...(payload ? { title: payload.title, summary: payload.summary } : {}),
        url: detailsUrl,
      });

      write(`[${run.pipelineId}] ${state === "queued" ? "·" : "…"} ${name}`, {
        check: name,
        url: detailsUrl,
      });

      return {};
    },
    complete: async ({
      run,
      name,
      conclusion,
      title,
      summary,
      annotations,
      detailsUrl,
    }) => {
      history.push({
        at: new Date().toISOString(),
        pipeline: run.pipelineId,
        name,
        status: "completed",
        conclusion,
        title,
        summary,
        annotations,
        url: detailsUrl,
      });

      write(
        `[${run.pipelineId}] ${conclusionSymbols[conclusion] ?? "•"} ${name}  ${title}  → ${detailsUrl}`,
        { check: name, conclusion, url: detailsUrl },
      );
    },
    update: async ({ run, name, title, summary, detailsUrl }) => {
      history.push({
        at: new Date().toISOString(),
        pipeline: run.pipelineId,
        name,
        status: "updated",
        title,
        ...(summary === undefined ? {} : { summary }),
        ...(detailsUrl ? { url: detailsUrl } : {}),
      });

      write(
        `[${run.pipelineId}] … ${name}  ${title}${detailsUrl ? `  → ${detailsUrl}` : ""}`,
        { check: name },
      );
    },
  };
};

type Repo = NonNullable<CiRunScope["repo"]>;

const clientFor = (provider: GitHubProvider, repo: Repo) => {
  return provider.octokit({
    owner: repo.owner,
    repo: repo.name,
    ...(repo.installationId === undefined
      ? {}
      : { installationId: repo.installationId }),
  });
};

/**
 * The jobs of a run as their checks show them, for drawing a run whose own
 * state is gone. A job's check does not say what it started from, so none is
 * drawn as the child of another.
 */
const jobsFromChecks = (
  checkRuns: Array<{
    name: string;
    status: string;
    conclusion?: string | null;
    external_id?: string | null;
    started_at?: string | null;
    completed_at?: string | null;
    output?: { title?: string | null };
  }>,
  runId: string,
  startedAt: string | null | undefined,
): GraphJob[] => {
  const origin = new Date(startedAt ?? Date.now()).getTime();

  return checkRuns
    .filter((checkRun) => {
      return (
        checkRun.external_id?.startsWith(`${runId}:`) &&
        checkRun.external_id !== `${runId}:pipeline`
      );
    })
    .map((checkRun) => {
      const id = String(checkRun.external_id).slice(runId.length + 1);

      const state: GraphJob["state"] =
        checkRun.status === "queued"
          ? "queued"
          : checkRun.status !== "completed"
            ? "stopped"
            : checkRun.conclusion === "success"
              ? checkRun.output?.title?.includes("Cache hit")
                ? "cached"
                : "ok"
              : checkRun.conclusion === "cancelled"
                ? "stopped"
                : "failed";

      const startMs = checkRun.started_at
        ? Math.max(0, new Date(checkRun.started_at).getTime() - origin)
        : Math.max(0, Date.now() - origin);

      return {
        id,
        name: id,
        parents: [],
        state,
        startMs,
        ...(checkRun.completed_at
          ? {
              endMs: Math.max(
                startMs,
                new Date(checkRun.completed_at).getTime() - origin,
              ),
            }
          : {}),
      };
    });
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
    start: async ({ run, state, name, externalId, detailsUrl, payload }) => {
      const repo = run.repo;

      if (!repo?.sha) {
        return {};
      }

      const octokit = await clientFor(provider, repo);

      const shown = payload
        ? {
            output: {
              title: stripAnsi(payload.title),
              summary: truncateSummary(stripAnsi(payload.summary)),
            },
          }
        : {};

      const buttons = payload ? payload.actions : runningActions;
      const existingId = await findCheckRun(octokit, repo, name, externalId);
      const startedAt = new Date().toISOString();

      if (existingId !== undefined) {
        if (state === "in_progress") {
          await octokit.rest.checks.update({
            owner: repo.owner,
            repo: repo.name,
            check_run_id: existingId,
            status: "in_progress",
            started_at: startedAt,
            actions: buttons,
            ...shown,
          });
        }

        return { id: existingId };
      }

      const created = await octokit.rest.checks.create({
        owner: repo.owner,
        repo: repo.name,
        name,
        head_sha: repo.sha,
        status: state,
        external_id: externalId,
        details_url: detailsUrl,
        ...(state === "in_progress" ? { started_at: startedAt } : {}),
        actions: buttons,
        ...shown,
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
      text,
      annotations,
      actions,
      checkRunId,
    }) => {
      const repo = run.repo;

      if (!repo?.sha) {
        return;
      }

      const octokit = await clientFor(provider, repo);

      const id =
        checkRunId ?? (await findCheckRun(octokit, repo, name, externalId));

      const completed = {
        owner: repo.owner,
        repo: repo.name,
        name,
        head_sha: repo.sha,
        details_url: detailsUrl,
        external_id: externalId,
        status: "completed" as const,
        conclusion,
        completed_at: new Date().toISOString(),
        output: {
          title,
          summary,
          ...(text === undefined ? {} : { text }),
          ...(annotations.length > 0 ? { annotations } : {}),
        },
        ...(actions ? { actions } : {}),
      };

      if (id === undefined) {
        await octokit.rest.checks.create(completed);
      } else {
        await octokit.rest.checks.update({ ...completed, check_run_id: id });
      }
    },

    annotate: async ({
      run,
      name,
      externalId,
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

      if (id === undefined) {
        return;
      }

      // GitHub appends annotations, so each batch is an update of its own.
      await octokit.rest.checks.update({
        owner: repo.owner,
        repo: repo.name,
        check_run_id: id,
        output: { title, summary, annotations },
      });
    },

    closeOpen: async ({ run }) => {
      const repo = run.repo;

      if (!repo?.sha) {
        return;
      }

      const octokit = await clientFor(provider, repo);

      // Every check a run starts has its ID in its external ID. All of them are
      // read, finished ones too, because the pipeline's check draws the run.
      const listed = await octokit.rest.checks.listForRef({
        owner: repo.owner,
        repo: repo.name,
        ref: repo.sha,
        per_page: 100,
      });

      const mine = listed.data.check_runs.filter((checkRun) => {
        return checkRun.external_id?.startsWith(`${run.runId}:`);
      });

      const links = {
        ...(repo.sha
          ? {
              commit: {
                sha: repo.sha.slice(0, 7),
                url: `https://github.com/${repo.fullName}/commit/${repo.sha}`,
              },
            }
          : {}),
      };

      const pipeline = mine.find((checkRun) => {
        return checkRun.external_id === `${run.runId}:pipeline`;
      });

      for (const checkRun of mine) {
        if (checkRun.status === "completed") {
          continue;
        }

        const isPipeline = checkRun === pipeline;

        const shown = isPipeline
          ? pipelineCheck({
              ...links,
              run: checkRun.details_url ?? "",
              state: "cancelled",
              elapsedMs: Math.max(
                0,
                Date.now() -
                  new Date(checkRun.started_at ?? Date.now()).getTime(),
              ),
              jobs: jobsFromChecks(mine, run.runId, checkRun.started_at),
            })
          : jobCheck({
              ...links,
              run: checkRun.details_url ?? "",
              name: checkRun.name,
              state: {
                kind: "cancelled",
                reason: "the run was cancelled before it finished",
              },
            });

        await octokit.rest.checks.update({
          owner: repo.owner,
          repo: repo.name,
          check_run_id: checkRun.id,
          status: "completed",
          conclusion: "cancelled",
          completed_at: new Date().toISOString(),
          actions: shown.actions,
          output: {
            title: shown.title,
            summary: truncateSummary(shown.summary),
          },
        });
      }
    },

    update: async ({
      run,
      name,
      title,
      summary,
      text,
      actions,
      checkRunId,
      detailsUrl,
    }) => {
      const repo = run.repo;

      if (!repo?.sha || checkRunId === undefined) {
        return;
      }

      const octokit = await clientFor(provider, repo);

      // `output.summary` is required on every update and replaces what's
      // there, so without a new one, send back what the check already shows.
      const current =
        summary === undefined
          ? await octokit.rest.checks.get({
              owner: repo.owner,
              repo: repo.name,
              check_run_id: checkRunId,
            })
          : undefined;

      await octokit.rest.checks.update({
        owner: repo.owner,
        repo: repo.name,
        check_run_id: checkRunId,
        ...(detailsUrl ? { details_url: detailsUrl } : {}),
        ...(actions ? { actions } : {}),
        output: {
          title: stripAnsi(title),
          summary: truncateSummary(
            stripAnsi(summary ?? current?.data.output?.summary ?? name),
          ),
          ...(text === undefined
            ? {}
            : { text: truncateSummary(stripAnsi(text)) }),
        },
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
 * Commit statuses, for token auth. There are no summaries or annotations, so
 * the description carries the failure's reason.
 */
export const statusesSink = (provider: GitHubProvider): CheckSink => {
  const post = async (
    run: Pick<CiRunScope, "repo">,
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
      description: stripAnsi(description),
    });
  };

  return {
    start: async ({ run, state, name, detailsUrl }) => {
      await post(
        run,
        name,
        detailsUrl,
        "pending",
        state === "queued" ? "Queued" : "Running",
      );

      return {};
    },
    update: async ({ run, name, title }) => {
      // The status links to the run that owns it, which is how a run that ends
      // finds it again, even when a job's own run is the one updating it.
      await post(
        run,
        name,
        run.ci.runUrl({ runId: run.runId, functionId: run.functionId }),
        "pending",
        truncateLabel(title, maxStatusDescription),
      );
    },
    complete: async ({ run, name, detailsUrl, conclusion, title }) => {
      await post(
        run,
        name,
        detailsUrl,
        statusFor(conclusion),
        truncateLabel(title, maxStatusDescription),
      );
    },
    closeOpen: async ({ run, title }) => {
      const repo = run.repo;

      if (!repo?.sha) {
        return;
      }

      const octokit = await clientFor(provider, repo);

      const { data } = await octokit.rest.repos.getCombinedStatusForRef({
        owner: repo.owner,
        repo: repo.name,
        ref: repo.sha,
        per_page: 100,
      });

      // Each status links to its run, which is the only thing tying it to one.
      for (const status of data.statuses) {
        if (
          status.state === "pending" &&
          status.context &&
          status.target_url?.includes(run.runId)
        ) {
          await post(
            { repo },
            status.context,
            status.target_url,
            statusFor("cancelled"),
            title,
          );
        }
      }
    },
  };
};

/**
 * The markdown summary on the pipeline check: a table of jobs, a trace link,
 * and any snapshots kept for debugging.
 */
/** How long the run saved by starting from snapshots it didn't have to build. */
export const savedFromCache = (run: CiRunScope): number => {
  return [...run.cacheSaved.values()].reduce((sum, ms) => {
    return sum + ms;
  }, 0);
};

/**
 * How long the run has taken by the clock, from its start. Read it inside the
 * step that completes the pipeline, so it is the time when the run ended.
 */
export const wallTime = (run: CiRunScope): number | undefined => {
  return run.startedAt === undefined ? undefined : Date.now() - run.startedAt;
};

export const pipelineSummary = (run: CiRunScope): string => {
  const wall = wallTime(run);

  const compute = run.summaries.reduce((sum, summary) => {
    return sum + summary.durationMs;
  }, 0);

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
    ...(wall === undefined
      ? []
      : [
          `**Took ${formatDuration(wall)}**${compute > 0 ? ` (${formatDuration(compute)} of compute across ${run.summaries.length} job${run.summaries.length === 1 ? "" : "s"})` : ""}`,
          "",
        ]),
    "| Job | Result | Detail | Duration |",
    "| --- | --- | --- | --- |",
    ...(rows.length > 0 ? rows : ["| _no jobs ran_ |  |  |  |"]),
    "",
    `[View the trace](${run.ci.runUrl({ runId: run.runId, functionId: run.functionId })})`,
    ...(run.cacheSaved.size > 0
      ? [
          "",
          "| Cached build | Time saved |",
          "| --- | --- |",
          ...[...run.cacheSaved].map(([job, ms]) => {
            return `| ${job} | ${formatDuration(ms)} |`;
          }),
          `| **Total** | **${formatDuration(savedFromCache(run))}** |`,
        ]
      : []),
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
