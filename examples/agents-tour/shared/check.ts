/**
 * @module
 * What an exercise's `check.ts` is given: one tiny API for sending events,
 * pressing a panel button, waiting for the runs to settle and reading what
 * came out (run outputs and posts). A check judges only what the outside
 * saw, never which tool a model picked.
 */

export interface SeenRun {
  id: string;
  // The function's name: the agent's id.
  fn: string;
  status: string;
  // What the run returned, parsed from JSON; null while it has not.
  output: unknown;
  // The error message of a failed run.
  error: string | null;
}

export interface SeenPost {
  channel: string;
  threadTs: string | undefined;
  text: string;
}

export interface CheckApi {
  /** Sends a message to an agent's thread, as the Messages panel does. */
  send: (agent: string, thread: string, text: string) => Promise<void>;
  /** Sends a plain event. */
  event: (name: string, data?: Record<string, unknown>) => Promise<void>;
  /** Presses a panel's button: a POST to the panel's own route. */
  press: (path: string, body?: Record<string, unknown>) => Promise<unknown>;
  /** Waits until the runs are finished or have stopped changing. */
  settle: () => Promise<void>;
  /** The runs since the check started, optionally of one function. */
  runs: (fn?: string) => Promise<SeenRun[]>;
  /** What the agents posted in the fake Slack. */
  posts: () => Promise<SeenPost[]>;
  /** Fails the check with one sentence saying why. */
  fail: (reason: string) => never;
}

export type Check = (t: CheckApi) => Promise<void>;
