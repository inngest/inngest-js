/**
 * The plain renderer: one line per transition, for logs, CI and agents. Every
 * line reads `<kind> <name>: <status>`, in the order things happen. Colour only
 * appears on a terminal, and never when `NO_COLOR` is set.
 *
 * @module
 */

import { stripVTControlCharacters } from "node:util";
import type { LocalStatus } from "../../local/protocol.ts";
import type { Renderer, SessionEvent } from "../events.ts";
import {
  createPaint,
  describeTargets,
  formatElapsed,
  oneLine,
  type Paint,
  supportsColor,
} from "./format.ts";
import {
  acceptsActivity,
  displayActivity,
  initialModel,
  isTerminal,
  type Model,
  reduce,
  runsStartedAt,
  waitingFor,
} from "./model.ts";

type Transition = { key: string; state: string };

/**
 * The lines for the jobs of a run that wait on `parentId`, whose state just
 * changed, so a waiting child keeps saying what its parent is doing.
 */
const waitingLines = (
  model: Model,
  runId: string,
  parentId: string,
): string[] => {
  const run = model.runs.find((item) => {
    return item.runId === runId;
  });

  if (!run) {
    return [];
  }

  return run.jobs
    .filter((job) => {
      return !isTerminal(job.status) && waitingFor(job) === parentId;
    })
    .map((job) => {
      return `job ${job.jobId}: ${oneLine(displayActivity(run, job) ?? "")}`;
    });
};

/**
 * What identifies an event's row and which state it's in. A repeat of the
 * same state, like a retried message, prints nothing.
 */
const transitionOf = (event: SessionEvent): Transition | undefined => {
  switch (event.kind) {
    case "stage": {
      return {
        key: `stage:${event.stage}`,
        state: `${event.status}:${event.detail ?? ""}`,
      };
    }

    case "run": {
      return {
        key: `run:${event.runId}`,
        state: `${event.status}:${event.reason ?? ""}`,
      };
    }

    case "job": {
      return {
        key: `job:${event.runId}:${event.jobId}`,
        state: event.status,
      };
    }

    case "command": {
      return {
        key: `command:${event.runId}:${event.jobId}:${event.commandId}`,
        state: `${event.status}:${event.attempt}`,
      };
    }

    default: {
      return undefined;
    }
  }
};

const paintStatus = (paint: Paint, status: string): string => {
  switch (status) {
    case "passed":
    case "cached":
    case "done": {
      return paint("green", status);
    }

    case "failed": {
      return paint("red", status);
    }

    case "running":
    case "cancelled": {
      return paint("yellow", status);
    }

    default: {
      return paint("dim", status);
    }
  }
};

const indented = (text: string, indent = "    "): string[] => {
  return stripVTControlCharacters(text)
    .split("\n")
    .map((line) => {
      return line.trimEnd();
    })
    .filter(Boolean)
    .map((line) => {
      return `${indent}${line}`;
    });
};

/**
 * `<name>: <status> · <detail> (<duration>)`, without the parts that aren't
 * known. A reason for failing reads `<status> — <reason>` instead.
 */
const line = (
  paint: Paint,
  name: string,
  status: LocalStatus | "done",
  detail?: string,
  durationMs?: number,
  separator = " · ",
): string => {
  return [
    `${name}: ${paintStatus(paint, status)}`,
    detail ? `${separator}${oneLine(detail)}` : "",
    durationMs === undefined
      ? ""
      : paint("dim", ` (${formatElapsed(durationMs)})`),
  ].join("");
};

/**
 * The lines to print for an event. `model` is the model after the event, so
 * durations and the run's name are there to look up.
 */
export const plainLines = (
  event: SessionEvent,
  model: Model,
  paint: Paint,
): string[] => {
  switch (event.kind) {
    case "manifest":
    case "project":
    case "restart":
    case "ready":
    case "warning": {
      // Warnings are printed once, with the outcome, when the run is over.
      return [];
    }

    case "targets": {
      const { header } = model;

      return header
        ? [
            `inngest-ci ${event.targets.map((target) => target.id).join(", ")} · ${describeTargets(header.repo, event.targets)}`,
            `Dev Server: ${header.devServerUrl}`,
          ]
        : [];
    }

    case "activity": {
      const run = model.runs.find((item) => {
        return item.runId === event.runId;
      });
      const job = run?.jobs.find((item) => {
        return item.jobId === event.jobId;
      });

      if (run && !acceptsActivity(run, job)) {
        return [];
      }

      const text = (run && job && displayActivity(run, job)) ?? event.text;

      return [
        `job ${event.jobId}: ${oneLine(text)}`,
        ...waitingLines(model, event.runId, event.jobId),
      ];
    }

    case "stage": {
      const stage = model.stages.find((item) => {
        return item.stage === event.stage;
      });
      const durationMs =
        stage?.endedAt === undefined
          ? undefined
          : stage.endedAt - stage.startedAt;

      return [
        line(
          paint,
          `stage ${event.stage}`,
          event.status === "done" ? "done" : event.status,
          event.detail,
          durationMs,
        ),
      ];
    }

    case "setup-error": {
      return [
        `${paint("red", "error")}: ${oneLine(event.message)}`,
        ...(event.fix ? ["  fix:", ...indented(event.fix)] : []),
        ...(event.logTail ? ["  log:", ...indented(event.logTail)] : []),
      ];
    }

    case "run": {
      const run = model.runs.find((item) => {
        return item.runId === event.runId;
      });
      const durationMs =
        run?.endedAt === undefined ? undefined : run.endedAt - run.startedAt;

      return [
        line(
          paint,
          `run ${run?.name ?? event.pipelineId}`,
          event.status,
          event.reason,
          durationMs,
          " — ",
        ),
      ];
    }

    case "job": {
      const job = model.runs
        .find((run) => {
          return run.runId === event.runId;
        })
        ?.jobs.find((item) => {
          return item.jobId === event.jobId;
        });
      const durationMs =
        job?.endedAt === undefined ? undefined : job.endedAt - job.startedAt;

      return [
        line(
          paint,
          `job ${event.jobId}`,
          event.status,
          event.title,
          durationMs,
          " — ",
        ),
      ];
    }

    case "command": {
      const attempt =
        event.attempt > 1 ? `attempt ${event.attempt}` : undefined;
      const exit =
        event.exitCode === undefined ? undefined : `exit ${event.exitCode}`;
      const detail = [attempt, event.status === "failed" ? exit : undefined]
        .filter(Boolean)
        .join(", ");

      return [
        line(
          paint,
          `command ${event.jobId} › $ ${event.name}`,
          event.status,
          detail,
          event.durationMs,
        ),
        ...(event.status === "failed" && event.outputTail
          ? indented(event.outputTail)
          : []),
        ...(event.status === "running"
          ? waitingLines(model, event.runId, event.jobId)
          : []),
      ];
    }

    case "done": {
      const elapsed = formatElapsed(event.at - runsStartedAt(model));

      const failure = model.runs.find((run) => {
        return run.status === "failed" && run.reason;
      });
      const why =
        failure?.reason &&
        ` — ${model.runs.length > 1 ? `${failure.name}: ` : ""}${oneLine(failure.reason)}`;

      return [
        `${paintStatus(paint, event.conclusion)} in ${elapsed}${
          event.conclusion === "failed" && why ? why : ""
        }`,
        ...model.runs.flatMap((run) => {
          return run.warnings.map((text) => {
            return `${paint("yellow", "warning")} ${run.name}: ${oneLine(text)}`;
          });
        }),
        ...model.runs.map((run) => {
          return `open ${run.name}: inngest-ci open ${run.runId}`;
        }),
      ];
    }
  }
};

/**
 * The jobs a run's end closed without a message of their own, as the `job`
 * events that say so.
 */
const jobsClosedBy = (
  event: SessionEvent,
  before: Model,
  after: Model,
): SessionEvent[] => {
  if (event.kind !== "run") {
    return [];
  }

  const previous = before.runs.find((run) => {
    return run.runId === event.runId;
  });

  return (
    after.runs
      .find((run) => {
        return run.runId === event.runId;
      })
      ?.jobs.filter((job) => {
        return (
          isTerminal(job.status) &&
          previous?.jobs.some((old) => {
            return old.jobId === job.jobId && !isTerminal(old.status);
          })
        );
      })
      .map((job): SessionEvent => {
        return {
          kind: "job",
          runId: event.runId,
          jobId: job.jobId,
          status: job.status,
          ...(job.title ? { title: job.title } : {}),
          at: event.at,
        };
      }) ?? []
  );
};

export const createPlainRenderer = (): Renderer => {
  const paint = createPaint(supportsColor(process.stdout));
  const seen = new Map<string, string>();
  let model = initialModel;
  // The outcome is held back so it's the last thing printed, after cleanup.
  let outcome: string[] = [];

  return {
    handle(event) {
      const before = model;

      model = reduce(model, event);

      if (event.kind === "done") {
        outcome = plainLines(event, model, paint);

        return;
      }

      const transition = transitionOf(event);

      if (transition) {
        if (seen.get(transition.key) === transition.state) {
          return;
        }

        seen.set(transition.key, transition.state);
      }

      for (const text of plainLines(event, model, paint)) {
        process.stdout.write(`${text}\n`);
      }

      for (const closed of jobsClosedBy(event, before, model)) {
        for (const text of plainLines(closed, model, paint)) {
          process.stdout.write(`${text}\n`);
        }
      }
    },

    close() {
      const lines = outcome.map((text) => {
        return `${text}\n`;
      });

      return new Promise((resolve) => {
        process.stdout.write(lines.join(""), () => {
          resolve();
        });
      });
    },
  };
};
