/**
 * The live view of a run: one spinner that says what is running right now,
 * and a line printed above it for each job that ends. Failed commands print
 * the end of their output. `@clack/prompts` falls back to plain lines when
 * there is no terminal, so this is the only renderer.
 *
 * @module
 */

import { log, spinner } from "@clack/prompts";

import type { LocalMessage, LocalStatus } from "../local/protocol.ts";

/** How many running jobs the spinner names before it says "and N more". */
const namedJobs = 3;

const seconds = (ms: number): string => {
  return `${Math.max(1, Math.round(ms / 1000))}s`;
};

/** Print a line for a job that ended. */
const jobLines: Partial<Record<LocalStatus, (text: string) => void>> = {
  passed: log.success,
  cached: log.info,
  failed: log.error,
  cancelled: log.warn,
  skipped: log.warn,
};

export interface LiveView {
  /** Show what the run is doing. Messages are those of the one run shown. */
  handle(message: LocalMessage): void;

  /** Change what the spinner says while nothing runs. */
  status(text: string): void;

  /** Print a line above the spinner. */
  print(show: () => void): void;

  /** Stop the spinner, leaving `text`. */
  stop(text?: string): void;
}

export const createLiveView = (): LiveView => {
  const bar = spinner();

  /** What each running job is doing, by job ID. */
  const running = new Map<string, string>();
  const startedAt = new Map<string, number>();
  let idle = "Waiting for the run to start";
  let active = false;

  const label = (): string => {
    const jobs = [...running].map(([id, doing]) => {
      return `${id}: ${doing}`;
    });

    if (jobs.length === 0) {
      return idle;
    }

    const more = jobs.length - namedJobs;

    return [
      ...jobs.slice(0, namedJobs),
      ...(more > 0 ? [`and ${more} more`] : []),
    ].join(", ");
  };

  const refresh = (): void => {
    if (active) {
      bar.message(label());
    } else {
      bar.start(label());

      active = true;
    }
  };

  const print = (show: () => void): void => {
    if (active) {
      bar.clear();
    }

    show();

    if (active) {
      bar.start(label());
    }
  };

  return {
    print,
    status: (text) => {
      idle = text;

      refresh();
    },
    stop: (text) => {
      if (active) {
        bar.stop(text);

        active = false;
      }
    },
    handle: (message) => {
      if (message.kind === "warning") {
        print(() => {
          log.warn(message.text);
        });

        return;
      }

      if (message.kind === "activity") {
        running.set(message.jobId, message.text);

        refresh();

        return;
      }

      if (message.kind === "command") {
        if (message.status === "running") {
          running.set(message.jobId, `$ ${message.name}`);

          refresh();
        } else if (message.status === "failed") {
          print(() => {
            log.error(
              [
                `${message.jobId}: $ ${message.name} exited with ${message.exitCode}`,
                message.outputTail ?? "",
              ].join("\n"),
            );
          });
        }

        return;
      }

      if (message.kind !== "job") {
        return;
      }

      if (message.status === "running" || message.status === "queued") {
        startedAt.set(
          message.jobId,
          startedAt.get(message.jobId) ?? message.at,
        );

        running.set(
          message.jobId,
          running.get(message.jobId) ?? message.status,
        );

        refresh();

        return;
      }

      running.delete(message.jobId);

      const took = seconds(
        message.at - (startedAt.get(message.jobId) ?? message.at),
      );
      const detail = message.title ? `: ${message.title}` : "";

      print(() => {
        jobLines[message.status]?.(`${message.jobId} (${took})${detail}`);
      });

      refresh();
    },
  };
};
