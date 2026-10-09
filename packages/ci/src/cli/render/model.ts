/**
 * The view model both renderers draw from, and the pure reducer that builds it
 * from a session's events. The latest message per key wins, so a message that
 * arrives again (a step retried) updates its row rather than adding one.
 *
 * @module
 */

import type { LocalStatus } from "../../local/protocol.ts";
import type { SessionConclusion, SessionEvent } from "../events.ts";

export type StageName = Extract<SessionEvent, { kind: "stage" }>["stage"];

export interface StageView {
  stage: StageName;
  status: "running" | "done" | "failed";
  detail?: string;
  startedAt: number;
  endedAt?: number;
}

export interface CommandView {
  commandId: string;
  name: string;
  attempt: number;
  status: "running" | "passed" | "failed";
  exitCode?: number;
  outputTail?: string;
}

export interface JobView {
  jobId: string;
  status: LocalStatus;
  /** The job it started `from`, when known. */
  parentId?: string;
  title?: string;
  /** Where the job's own run is, when another run builds it. */
  url?: string;
  /** What it's doing while no command runs. A command message clears it. */
  activity?: string;
  /** In order of first appearance. */
  commands: CommandView[];
  startedAt: number;
  endedAt?: number;
}

export interface RunView {
  runId: string;
  /** What to call the run: its pipeline, or the target for a single job. */
  name: string;
  status: LocalStatus;
  reason?: string;
  url: string;
  /** In order of first appearance. */
  jobs: JobView[];
  /** Notes the run ended with, each once. */
  warnings: string[];
  startedAt: number;
  endedAt?: number;
}

export interface Model {
  header?: Extract<SessionEvent, { kind: "ready" }>;
  /** What's being run, once chosen. */
  targets?: Extract<SessionEvent, { kind: "targets" }>;
  /** In order of first appearance. */
  stages: StageView[];
  /** In order of first appearance. */
  runs: RunView[];
  /** The project's root directory, once found. */
  projectRoot?: string;
  setupError?: Extract<SessionEvent, { kind: "setup-error" }>;
  conclusion?: SessionConclusion;
  /** The first event's time, for the total duration. */
  startedAt?: number;
  /** Set by `done`. */
  endedAt?: number;
}

/**
 * Statuses that will not change again. Kept out of `local/protocol.ts`, which
 * the app's build shares: the CLI build only keeps what the app's uses.
 */
export const isTerminal = (status: LocalStatus): boolean => {
  return status !== "queued" && status !== "running";
};

export const initialModel: Model = { stages: [], runs: [] };

/**
 * Whether a job's activity is still news. A job that has ended, or whose run
 * has, has nothing more to say: a replay of the pipeline re-sends the start
 * notes of jobs that already finished.
 */
export const acceptsActivity = (run: RunView, job?: JobView): boolean => {
  if (isTerminal(run.status)) {
    return false;
  }

  return !job || !isTerminal(job.status);
};

/** The parent a job's activity says it is waiting for, if it does. */
export const waitingFor = (job: JobView): string | undefined => {
  return /^waiting for (.+?)…?$/.exec(job.activity ?? "")?.[1];
};

/** What a job is doing, in the words of the person looking at it. */
const stateOf = (job: JobView): string | undefined => {
  if (isTerminal(job.status) || job.status === "queued") {
    return undefined;
  }

  const running = job.commands.filter((command) => {
    return command.status === "running";
  });
  const command = running[running.length - 1];

  if (command) {
    return `$ ${command.name.replace(/\s+/g, " ").trim()}`;
  }

  // A parent that is itself waiting adds nothing the child can use.
  return job.activity && !waitingFor(job)
    ? job.activity.replace(/…$/, "")
    : undefined;
};

/**
 * A job's activity as it's shown. A job waiting for its parent says what the
 * parent is doing, like `waiting for base · pnpm install`, and just
 * `waiting for base` while the parent is idle or unknown.
 */
export const displayActivity = (
  run: RunView,
  job: JobView,
): string | undefined => {
  const parentId = waitingFor(job);

  if (parentId === undefined) {
    return job.activity;
  }

  const parent = run.jobs.find((candidate) => {
    return candidate.jobId === parentId;
  });
  const state = parent ? stateOf(parent) : undefined;

  return state
    ? `waiting for ${parentId} · ${state}`
    : `waiting for ${parentId}`;
};

/** When the current runs began: the session's start, until they're chosen. */
export const runsStartedAt = (model: Model): number => {
  return model.targets?.at ?? model.startedAt ?? 0;
};

/**
 * Replace the item matching `match`, or append the item `create` makes. The
 * item `update` returns replaces it, so the original is never mutated.
 */
const upsert = <T>(
  items: T[],
  match: (item: T) => boolean,
  create: () => T,
  update: (item: T) => T,
): T[] => {
  const index = items.findIndex(match);

  if (index === -1) {
    return [...items, update(create())];
  }

  return items.map((item, i) => {
    return i === index ? update(item) : item;
  });
};

/** The time a status ended at, or undefined while it's still going. */
const endedAt = (status: LocalStatus, at: number): number | undefined => {
  return isTerminal(status) ? at : undefined;
};

/** A run or job's clock starts when it leaves the queue, not when it's seen. */
const startedAt = (
  item: { status: LocalStatus; startedAt: number },
  status: LocalStatus,
  at: number,
): number => {
  return item.status === "queued" && status !== "queued" ? at : item.startedAt;
};

const reduceCommand = (
  job: JobView,
  event: Extract<SessionEvent, { kind: "command" }>,
): JobView => {
  return {
    ...job,
    commands: upsert(
      job.commands,
      (command) => {
        return command.commandId === event.commandId;
      },
      () => {
        return {
          commandId: event.commandId,
          name: event.name,
          attempt: event.attempt,
          status: event.status,
        };
      },
      (command) => {
        return {
          ...command,
          name: event.name,
          attempt: event.attempt,
          status: event.status,
          exitCode: event.exitCode,
          outputTail: event.outputTail,
        };
      },
    ),
  };
};

/** The title a job that never got to finish is closed with. */
const cancelledTitle = "Cancelled: the run ended first";

/**
 * Close the jobs a failed or cancelled run left running or queued, so none
 * hangs. When a failed run left one job open, that job was the one active
 * when it failed: it fails with the run's reason. Otherwise they're cancelled.
 */
const closeOpenJobs = (run: RunView, at: number): RunView => {
  if (run.status !== "failed" && run.status !== "cancelled") {
    return run;
  }

  const open = run.jobs.filter((job) => {
    return !isTerminal(job.status);
  });

  if (open.length === 0) {
    return run;
  }

  const culprit = run.status === "failed" && open.length === 1;

  return {
    ...run,
    jobs: run.jobs.map((job): JobView => {
      if (isTerminal(job.status)) {
        return job;
      }

      return {
        ...job,
        status: culprit ? "failed" : "cancelled",
        title: job.title ?? (culprit ? run.reason : cancelledTitle),
        activity: undefined,
        endedAt: at,
      };
    }),
  };
};

const updateRun = (
  model: Model,
  runId: string,
  update: (run: RunView) => RunView,
): Model => {
  return {
    ...model,
    runs: model.runs.map((run) => {
      return run.runId === runId ? update(run) : run;
    }),
  };
};

/**
 * Fold one event into the model. A job or command for a run that hasn't been
 * announced yet is dropped, because nothing can be drawn without its run.
 */
export const reduce = (model: Model, event: SessionEvent): Model => {
  if (event.kind === "manifest") {
    return model;
  }

  const next: Model = { ...model, startedAt: model.startedAt ?? event.at };

  switch (event.kind) {
    case "stage": {
      return {
        ...next,
        stages: upsert(
          next.stages,
          (stage) => {
            return stage.stage === event.stage;
          },
          (): StageView => {
            return {
              stage: event.stage,
              status: event.status,
              startedAt: event.at,
            };
          },
          (stage) => {
            return {
              ...stage,
              status: event.status,
              detail: event.detail ?? stage.detail,
              endedAt: event.status === "running" ? undefined : event.at,
            };
          },
        ),
      };
    }

    case "restart": {
      return { ...initialModel, startedAt: event.at };
    }

    case "project": {
      return { ...next, projectRoot: event.root };
    }

    case "setup-error": {
      return { ...next, setupError: event };
    }

    case "ready": {
      return { ...next, header: event };
    }

    case "targets": {
      return {
        ...next,
        targets: event,
        runs: [],
        conclusion: undefined,
        endedAt: undefined,
      };
    }

    case "done": {
      return { ...next, conclusion: event.conclusion, endedAt: event.at };
    }

    case "run": {
      return {
        ...next,
        runs: upsert(
          next.runs,
          (run) => {
            return run.runId === event.runId;
          },
          () => {
            return {
              runId: event.runId,
              name: event.pipelineId,
              status: event.status,
              url: event.url,
              jobs: [],
              warnings: [],
              startedAt: event.at,
            };
          },
          (run) => {
            return closeOpenJobs(
              {
                ...run,
                status: event.status,
                startedAt: startedAt(run, event.status, event.at),
                reason: event.reason,
                url: event.url,
                endedAt: endedAt(event.status, event.at),
              },
              event.at,
            );
          },
        ),
      };
    }

    case "job": {
      return updateRun(next, event.runId, (run) => {
        return {
          ...run,
          jobs: upsert(
            run.jobs,
            (job) => {
              return job.jobId === event.jobId;
            },
            () => {
              return {
                jobId: event.jobId,
                status: event.status,
                commands: [],
                startedAt: event.at,
              };
            },
            (job) => {
              // A build run reports where it is while the job is running. A
              // replay of that after the job ended must not reopen it.
              if (event.url && isTerminal(job.status)) {
                return { ...job, url: event.url };
              }

              return {
                ...job,
                url: event.url ?? job.url,
                status: event.status,
                startedAt: startedAt(job, event.status, event.at),
                parentId: event.parentId ?? job.parentId,
                title: event.title ?? job.title,
                activity: isTerminal(event.status) ? undefined : job.activity,
                endedAt: endedAt(event.status, event.at),
              };
            },
          ),
        };
      });
    }

    case "warning": {
      return updateRun(next, event.runId, (run) => {
        return run.warnings.includes(event.text)
          ? run
          : { ...run, warnings: [...run.warnings, event.text] };
      });
    }

    case "activity": {
      return updateRun(next, event.runId, (run) => {
        return {
          ...run,
          jobs: run.jobs.map((job) => {
            return job.jobId === event.jobId && acceptsActivity(run, job)
              ? { ...job, activity: event.text }
              : job;
          }),
        };
      });
    }

    case "command": {
      return updateRun(next, event.runId, (run) => {
        return {
          ...run,
          jobs: run.jobs.map((job) => {
            return job.jobId === event.jobId
              ? { ...reduceCommand(job, event), activity: undefined }
              : job;
          }),
        };
      });
    }
  }
};
