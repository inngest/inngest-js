/**
 * What a Sandboxes error says about itself: whether a machine failed to
 * start, whether the platform says to try again, and the code and status it
 * carries, on the error or on the step error's cause.
 *
 * @module
 */

import { errorMessage } from "../util.ts";

/**
 * Whether a machine failed to start, as opposed to a request that was refused.
 * Only a snapshot restore falls back on it: a plain machine that won't start
 * fails the job with its reason.
 */
export const isStartFailure = (error: unknown): boolean => {
  const codes = ["sandbox_start_timed_out", "sandbox_start_failed"];

  // No capacity, or too many requests, says nothing about the snapshot.
  if (isRetryable(error)) {
    return false;
  }

  return (
    codes.some((code) => {
      return hasCode(error, code);
    }) || /did not reach RUNNING/i.test(errorMessage(error))
  );
};

/**
 * Whether the platform says to try again, as it does for no capacity
 * (`compute_unavailable`) and rate limits (429 and 503).
 */
const isRetryable = (error: unknown): boolean => {
  const seen = error as
    | { retryable?: boolean; cause?: { retryable?: boolean } }
    | undefined;
  const status = errorStatus(error);

  return (
    seen?.retryable === true ||
    seen?.cause?.retryable === true ||
    hasCode(error, "compute_unavailable") ||
    hasCode(error, "rate_limited") ||
    status === 429 ||
    status === 503
  );
};

/** Whether a Sandboxes error has a code, on the error or the step error's cause. */
export const hasCode = (error: unknown, code: string): boolean => {
  const seen = error as
    | { code?: string; cause?: { code?: string } }
    | undefined;

  return seen?.code === code || seen?.cause?.code === code;
};

/** A Sandboxes error's HTTP status, whether on the error or its cause. */
export const errorStatus = (error: unknown): number | undefined => {
  const seen = error as
    | { status?: number; cause?: { status?: number } }
    | undefined;

  return seen?.status ?? seen?.cause?.status;
};
