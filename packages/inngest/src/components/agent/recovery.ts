/**
 * @module
 * EXPERIMENTAL: how an agent's runs end, kept on the thread, and what an agent
 * may do about a run that failed unexpectedly.
 *
 * Every run of an agent ends as `completed`, `failed` or `cancelled` (a
 * cancelled run includes one that hit a `timeouts.finish` limit). The executor
 * reports each ending in an `inngest/function.finished` event that carries the
 * status and the error or result, so one function per agent listens for it and
 * writes the thread's `lastRun`. That is where the outcome is known: a
 * `defer` also runs after every ending, but its event carries only the data
 * it was given, and `onFailure` sees failures only. The next run is handed
 * `lastRun` as `previousRun`, and `thread.state()` shows it.
 *
 * Recovery is opt-in (`recovery` in the agent's config). For a run that failed
 * it says so on the agent's channels and resends the turn that was in flight,
 * so a fresh run takes it up. The guard against a loop is the error's
 * fingerprint, not a count: a turn that fails with the same error twice is
 * not resent, and the failure is reported as stuck. A run that failed with a
 * `NonRetriableError` is reported but never resent: its failure was declared
 * final, and a fresh run would only repeat it.
 */
import hashjs from "hash.js";

/**
 * How a run ended.
 */
export type RunOutcome = "completed" | "failed" | "cancelled";

/**
 * The last run of a thread that ended, as `thread.state().lastRun` shows it
 * and the next run's `previousRun` hands it over.
 */
export interface LastRun {
  /**
   * The run that ended.
   */
  runId: string;

  /**
   * How it ended.
   */
  status: RunOutcome;

  /**
   * When it ended, in milliseconds since the epoch.
   */
  at: number;

  /**
   * For a failed run: one line of the error, with no stack and no request ID.
   */
  error?: string;

  /**
   * For a failed run: the error without ids and numbers, hashed. The same
   * failure has the same fingerprint however often it happens.
   */
  fingerprint?: string;

  /**
   * For a failed run with `recovery` on: what was done. `"resumed"` sent the
   * turn that was in flight to a fresh run; `"stuck"` did not, because the
   * same error had already failed that turn, or because it could not be
   * checked.
   */
  recovery?: "resumed" | "stuck";

  /**
   * The turn that failed (a hash of the message in flight), and every
   * fingerprint that has failed it. This is the loop guard.
   */
  guard?: { turn: string; fingerprints: string[] };
}

/**
 * A run that failed unexpectedly, as `recovery.message` receives it.
 */
export interface RunFailure {
  /**
   * The run that failed.
   */
  runId: string;

  /**
   * The thread key.
   */
  thread: string;

  /**
   * One line of the error.
   */
  error: string;

  /**
   * The same failure has the same fingerprint.
   */
  fingerprint: string;

  /**
   * Whether the turn is resent to a fresh run. It is not when the same error
   * had already failed that turn, or when `resume` is off.
   */
  resuming: boolean;

  /**
   * Whether the same error had already failed this turn.
   */
  repeated: boolean;

  /**
   * Whether a newer run has taken the thread over, so the failed turn is not
   * resent.
   */
  superseded: boolean;
}

/**
 * What an agent does about a run that failed unexpectedly.
 */
export interface AgentRecovery {
  /**
   * Resends the turn that was in flight, so a fresh run takes it up. A turn
   * that has failed with the same error before is not resent, and neither is
   * one whose run failed with a `NonRetriableError`. Default `true`.
   */
  resume?: boolean;

  /**
   * The text posted to the agent's channels (the `report` config) about the
   * failure. Return `false` to post nothing. Default: one line with the error,
   * saying whether a fresh run takes the turn up.
   */
  message?: (failure: RunFailure) => string | false;
}

/**
 * The most different errors one turn may fail with before it stops being
 * resent, so an error with a changing token cannot loop.
 */
const maxKinds = 3;

/**
 * One line of an error for people: no stack, no request ID, short.
 */
export const summarize = (
  /**
   * The error's message, or the error.
   */
  error: unknown,
): string => {
  const text =
    typeof error === "string"
      ? error
      : ((error as { message?: unknown } | null)?.message ?? String(error));
  const line =
    String(text)
      .split("\n")
      .map((part) => {
        return part.trim();
      })
      .find(Boolean) ?? "unknown error";
  const message = line.match(/"message":\s*"((?:[^"\\]|\\.)*)"/)?.[1] ?? line;

  return message
    .replace(/\\"/g, '"')
    .replace(/\s*\(?request_id:?\s*\S+\)?/gi, "")
    .slice(0, 160);
};

/**
 * The same failure gives the same fingerprint however many times it happens:
 * ids and numbers are dropped.
 */
export const fingerprint = (
  /**
   * The error's name, if it has one.
   */
  name: string | undefined,

  /**
   * The error's message.
   */
  message: string,
): string => {
  const shape = summarize(message)
    .toLowerCase()
    .replace(/\b[a-z0-9_-]*[0-9][a-z0-9_-]{5,}\b/g, "#")
    .replace(/[0-9]+/g, "#");

  return hashjs
    .sha1()
    .update(`${name ?? ""}|${shape}`)
    .digest("hex")
    .slice(0, 12);
};

/**
 * Names a turn by the message in flight, so the same text that is resent is
 * the same turn.
 */
export const turnOf = (
  /**
   * The message that was being answered.
   */
  content: string | undefined,
): string => {
  return hashjs
    .sha1()
    .update(content ?? "")
    .digest("hex")
    .slice(0, 12);
};

/**
 * The turn a failed run left in flight, and whether it can be resent.
 */
export interface Turn {
  /**
   * The message the run was answering.
   */
  content?: string;

  /**
   * Whether there is a turn to resend: the run was answering a message when it
   * failed. It is not when the run had answered and was waiting for the next
   * message, or when a newer run has taken the thread over.
   */
  resendable: boolean;
}

/**
 * Finds the turn a failed run left in flight from the thread's record.
 */
export const turnInFlight = (
  /**
   * The thread's record.
   */
  record: {
    runId?: string;
    inflight?: { content?: string };
  },

  /**
   * The failed run.
   */
  runId: string,

  /**
   * The message that started the failed run, if it carried one, and whether
   * the run began with a turn at all.
   */
  start: { content?: string; turn: boolean },

  /**
   * Whether a run's ID is older than another's.
   */
  older: (a: string, b: string) => boolean,
): Turn => {
  // The run wrote the record: it kept the turn it was answering until it
  // waited for the next message.
  if (record.runId === runId) {
    return record.inflight
      ? { content: record.inflight.content, resendable: true }
      : { resendable: false };
  }

  // A newer run owns the record: the failed run's turn is not known.
  if (record.runId && !older(record.runId, runId)) {
    return { resendable: false };
  }

  // The run failed before it wrote anything: it was answering its first
  // message.
  return { content: start.content, resendable: start.turn };
};

/**
 * What a run's `inngest/function.finished` event says about how it ended.
 */
export interface Finished {
  /**
   * How the run ended.
   */
  status: RunOutcome;

  /**
   * For a failed run: the error's name and message.
   */
  error?: { name?: string; message: string; nonRetriable: boolean };
}

/**
 * Reads the outcome from the data of an `inngest/function.finished` event.
 * @param data The event's data.
 */
export const finishedOf = (data: Record<string, unknown>): Finished => {
  const status = String(
    (data._inngest as { status?: unknown } | undefined)?.status ?? "",
  ).toLowerCase();
  const error = data.error as
    | { name?: string; message?: string; noRetry?: boolean }
    | string
    | undefined;

  if (status === "cancelled") {
    return { status: "cancelled" };
  }

  if (status === "failed" || (status === "" && data.error !== undefined)) {
    return {
      status: "failed",
      error:
        typeof error === "string"
          ? { message: error, nonRetriable: false }
          : {
              name: error?.name,
              message: error?.message ?? "unknown error",
              // The SDK serializes the error's class name, and the executor
              // sets `noRetry` when the function declared the failure final.
              nonRetriable:
                error?.name === "NonRetriableError" || error?.noRetry === true,
            },
    };
  }

  return { status: "completed" };
};

/**
 * What to do about a failed run, given the guard of the run before it.
 */
export interface Decision {
  /**
   * The new record for the thread's `lastRun`.
   */
  last: LastRun;

  /**
   * The same error had already failed this turn (or three different ones
   * had).
   */
  repeated: boolean;

  /**
   * The turn is resent to a fresh run.
   */
  resuming: boolean;
}

/**
 * Decides whether a failed turn is resent, and builds the record. Deciding
 * the same run twice gives the answer it got the first time, so a retried
 * step never resends twice.
 */
export const decide = (
  /**
   * The thread's `lastRun` before this run's.
   */
  prior: LastRun | undefined,

  /**
   * The failed run.
   */
  failed: {
    runId: string;
    at: number;
    error: string;
    fingerprint: string;
    turn: string;
    resume: boolean;
  },
): Decision => {
  const same = prior?.runId === failed.runId;
  const sameTurn = prior?.guard?.turn === failed.turn;
  const seen = sameTurn ? (prior?.guard?.fingerprints ?? []) : [];
  const repeated = same
    ? prior?.recovery === "stuck" && failed.resume
    : seen.includes(failed.fingerprint) || seen.length >= maxKinds;
  const resuming = failed.resume && !repeated;
  const fingerprints =
    same && prior?.guard
      ? prior.guard.fingerprints
      : seen.includes(failed.fingerprint)
        ? seen
        : [...seen, failed.fingerprint];

  return {
    repeated,
    resuming,
    last: {
      runId: failed.runId,
      status: "failed",
      at: failed.at,
      error: failed.error,
      fingerprint: failed.fingerprint,
      recovery: failed.resume ? (resuming ? "resumed" : "stuck") : undefined,
      guard: { turn: failed.turn, fingerprints },
    },
  };
};

/**
 * The text posted about a failure when `recovery.message` is not given.
 */
export const failureText = (failure: RunFailure): string => {
  if (failure.resuming) {
    return `Hit an error: ${failure.error}. Resuming in a fresh run.`;
  }

  if (failure.superseded) {
    return `Hit an error: ${failure.error}. A newer run has the thread, so this turn is not retried.`;
  }

  return failure.repeated
    ? `Failed again the same way: ${failure.error}. Not retrying on its own.`
    : `Hit an error: ${failure.error}.`;
};
