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
  /** The job it started `from()`, when known. */
  parentId?: string;
  title?: string;
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
              startedAt: event.at,
            };
          },
          (run) => {
            return {
              ...run,
              status: event.status,
              startedAt: startedAt(run, event.status, event.at),
              reason: event.reason,
              url: event.url,
              endedAt: endedAt(event.status, event.at),
            };
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
              return {
                ...job,
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

    case "activity": {
      return updateRun(next, event.runId, (run) => {
        return {
          ...run,
          jobs: run.jobs.map((job) => {
            // A finished job's machine is still being paused.
            return job.jobId === event.jobId && !isTerminal(job.status)
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
