/**
 * Pausing a sandbox as a step CI owns: request the pause, then watch the
 * sandbox's status, so a pause cut short because the run's cleanup destroyed
 * the sandbox ends quickly and successfully instead of failing after a timeout.
 *
 * @module
 */

import { NonRetriableError } from "inngest";
import { isSandboxNotFound } from "../util.ts";

/**
 * How long a pause may wait for the sandbox to report PAUSED. A healthy pause
 * takes 15-20 seconds, but some take over 30. The SDK's default is 5 minutes,
 * which is too long to hold a pipeline for what is only an optimisation. A
 * pause that runs out of time isn't retried: the sandbox stays running until
 * the run's cleanup destroys it.
 */
export const pauseTimeoutMs = 90_000;

/**
 * The pause's timing. Tests shorten it; nothing else changes it.
 */
export const pauseTiming = { timeoutMs: pauseTimeoutMs, pollMs: 1_000 };

/** The most statuses kept in a pause's output. */
const maxSeen = 20;

const cleanedUpReason = "sandbox was cleaned up";

/** Statuses that mean the sandbox is being, or has been, torn down. */
const goneStatuses = new Set(["TERMINATING", "TERMINATED", "STOPPED"]);

export interface PauseOutcome {
  paused: boolean;
  /** Why the sandbox isn't paused, when that isn't a failure. */
  reason?: string;
  /** The statuses the poll observed, without consecutive repeats. */
  seen: string[];
}

/** The slice of the direct sandbox client a pause needs. */
interface PauseClient {
  sandboxes: {
    get(id: string): Promise<{
      status: string;
      pause(options: {
        timeout: number;
        signal: AbortSignal;
      }): Promise<unknown>;
    } | null>;
  };
}

/**
 * Whether the pause request was refused because the sandbox is being torn
 * down.
 */
const isConflict = (error: unknown): boolean => {
  return (error as { status?: number } | undefined)?.status === 409;
};

/**
 * Whether the SDK gave up on the pause because the sandbox ended first.
 */
const isEnded = (error: unknown): boolean => {
  const message = (error as { message?: string } | undefined)?.message ?? "";

  return /entered (TERMINATING|TERMINATED|STOPPED) before/.test(message);
};

const errorText = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

/**
 * Pause a sandbox and report how it ended. A sandbox that is gone, or being
 * destroyed, is an outcome (`paused: false`); a sandbox that failed, or is
 * still running or pausing at the timeout, throws a `NonRetriableError`, so
 * the step warns once instead of starting the wait over.
 *
 * The SDK's `pause()` requests the pause and then polls, and only stops early
 * for FAILED and TERMINATED, so a sandbox destroyed while pausing would hold it
 * for the whole timeout. It runs here only as the request, aborted as soon as
 * this function's own poll knows the outcome.
 */
export const pauseSandbox = async (
  client: PauseClient,
  id: string,
): Promise<PauseOutcome> => {
  const { timeoutMs, pollMs } = pauseTiming;
  const seen: string[] = [];

  const record = (status: string): void => {
    if (seen.length < maxSeen && seen[seen.length - 1] !== status) {
      seen.push(status);
    }
  };

  const gone = (): PauseOutcome => {
    return { paused: false, reason: cleanedUpReason, seen };
  };

  const controller = new AbortController();

  try {
    const sandbox = await client.sandboxes.get(id);

    if (!sandbox) {
      record("NOT_FOUND");

      return gone();
    }

    record(sandbox.status);

    let settled: { error?: unknown } | undefined;

    const request = sandbox
      .pause({ timeout: timeoutMs, signal: controller.signal })
      .then(
        () => {
          settled = {};
        },
        (error: unknown) => {
          settled = { error };
        },
      );

    const deadline = Date.now() + timeoutMs;

    while (true) {
      await Promise.race([
        request,
        new Promise((resolve) => {
          setTimeout(resolve, pollMs);
        }),
      ]);

      if (settled) {
        if (!settled.error) {
          record("PAUSED");

          return { paused: true, seen };
        }

        if (
          isSandboxNotFound(settled.error) ||
          isConflict(settled.error) ||
          isEnded(settled.error)
        ) {
          record("NOT_FOUND");

          return gone();
        }

        throw new NonRetriableError(errorText(settled.error), {
          cause: settled.error,
        });
      }

      let status: string;

      try {
        status = (await client.sandboxes.get(id))?.status ?? "NOT_FOUND";
      } catch (error) {
        if (!isSandboxNotFound(error)) {
          throw error;
        }

        status = "NOT_FOUND";
      }

      record(status);

      if (status === "PAUSED") {
        return { paused: true, seen };
      }

      if (status === "NOT_FOUND" || goneStatuses.has(status)) {
        return gone();
      }

      if (status === "FAILED") {
        throw new NonRetriableError(
          `Sandbox entered FAILED before reaching PAUSED (saw ${seen.join(" > ")})`,
        );
      }

      if (Date.now() >= deadline) {
        throw new NonRetriableError(
          `Sandbox did not reach PAUSED within ${timeoutMs} milliseconds (saw ${seen.join(" > ")})`,
        );
      }
    }
  } finally {
    controller.abort();
  }
};
