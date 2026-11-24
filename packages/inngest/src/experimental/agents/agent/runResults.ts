/**
 * @module
 * EXPERIMENTAL: how a result is waited for and what a wait can throw: shared
 * by `start()` and `message()`.
 */

import { NonRetriableError } from "../../../components/NonRetriableError.ts";

/**
 * Thrown by `result()` when the run it waits for was stopped (a `stop()`, a
 * `cancelOn` event, or the cancellation of the caller's own parent), so the
 * caller never takes a cancelled run's non-answer for a result.
 */
export class AgentStoppedError extends NonRetriableError {
  /**
   * The ID of the stopped run, when the executor says.
   */
  public readonly runId: string | undefined;

  constructor(
    /**
     * The agent's address.
     */
    address: string,
    runId?: string,
  ) {
    super(
      `${address} was stopped${runId ? ` (run ${runId})` : ""}, so it returned no result.`,
    );
    this.name = "AgentStoppedError";
    this.runId = runId;
  }
}

/**
 * Thrown by `result({ timeout })` when the run did not finish in time. The run
 * keeps going: ask for its `result()` again to keep waiting.
 */
export class AgentTimeoutError extends NonRetriableError {
  constructor(
    /**
     * The agent's address.
     */
    address: string,
  ) {
    super(`${address} did not finish in time; its run is still going.`);
    this.name = "AgentTimeoutError";
  }
}

/**
 * Options of `result()`.
 */
export interface ResultOptions {
  /**
   * How long to wait, as a duration string (`"5m"`) or milliseconds.
   */
  timeout?: string | number;
}

export const noop = () => {};
