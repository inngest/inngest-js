/**
 * @module
 * EXPERIMENTAL: how an agent's runs end, kept on the thread.
 *
 * Every run of an agent ends as `completed`, `failed` or `cancelled` (a
 * cancelled run includes one that hit a `timeouts.finish` limit). The executor
 * reports each ending in an `inngest/function.finished` event that carries the
 * status and the error or result, so one function per agent listens for it and
 * writes the thread's `lastRun`. That is where the outcome is known: a
 * `defer` also runs after every ending, but its event carries only the data
 * it was given, and `onFailure` sees failures only. The next run is handed
 * `lastRun` as `previousRun`, and `thread.state()` shows it.
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
}

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
  error?: {
    name?: string;
    message: string;

    /**
     * The function declared the failure final (a `NonRetriableError`, by name,
     * or `noRetry` on the error). A plain error that ran out of retries is not.
     */
    nonRetriable: boolean;
  };
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

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * When a run started, from its ID: run IDs are ULIDs, whose first ten
 * characters are a millisecond timestamp. Anything else scores 0.
 */
export const runScore = (
  /**
   * The run ID.
   */
  runId: string,
): number => {
  let score = 0;

  for (const char of runId.slice(0, 10).toUpperCase()) {
    const digit = crockford.indexOf(char);

    if (digit < 0) {
      return 0;
    }

    score = score * 32 + digit;
  }

  return score;
};
