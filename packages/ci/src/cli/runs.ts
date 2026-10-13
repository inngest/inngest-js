/**
 * Telling several runs apart. A session can send many events at once, and the
 * app's messages arrive interleaved, so each message is matched to the event
 * that started its run.
 *
 * @module
 */

import type { LocalMessage } from "../local/protocol.ts";
import type { SessionConclusion } from "./events.ts";

/** A run the session started by sending an event. */
export interface SentRun {
  eventId: string;
  /** The function the event runs: a pipeline, or the run-job function. */
  functionId: string;
}

/**
 * Match messages to the runs in `sent`. A `run` message names its event, which
 * also starts other pipelines the session doesn't show, so it must match the
 * function too. Every other message only names a run, and counts once its
 * `run` message has matched. Returns `undefined` for a message that isn't
 * about any of them.
 */
export const createRouter = <T extends SentRun>(
  sent: T[],
): ((message: LocalMessage) => T | undefined) => {
  const byRun = new Map<string, T>();

  return (message) => {
    if (message.kind === "manifest") {
      return undefined;
    }

    if (message.kind === "run") {
      const match = sent.find((candidate) => {
        return (
          candidate.eventId === message.eventId &&
          candidate.functionId === message.pipelineId
        );
      });

      if (match) {
        byRun.set(message.runId, match);
      }

      return match;
    }

    return byRun.get(message.runId);
  };
};

/** How a session that ran several things went: any failure fails it, then any cancel. */
export const combineConclusions = (
  conclusions: SessionConclusion[],
): SessionConclusion => {
  for (const worst of ["failed", "cancelled"] as const) {
    if (conclusions.includes(worst)) {
      return worst;
    }
  }

  return "passed";
};
