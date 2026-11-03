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
  // The thread key the run's first message named (an `agent/message`
  // event's `thread`); null when the trigger names none.
  thread: string | null;
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

export interface SeenThread {
  key: string;
  // The runs that share the thread, oldest first.
  runs: SeenRun[];
}

export interface SettleOptions {
  // Quiet for this long counts as settled. Default: 1.5 seconds.
  quietMs?: number;
  // Give up after the runs have kept changing this long. Default: 20 seconds.
  timeoutMs?: number;
}

export interface CheckApi {
  /** Sends a message to an agent's thread, as the Messages panel does. */
  send: (agent: string, thread: string, text: string) => Promise<void>;
  /** Sends a plain event. */
  event: (name: string, data?: Record<string, unknown>) => Promise<void>;
  /** Presses a panel's button: a POST to the panel's own route. */
  press: (path: string, body?: Record<string, unknown>) => Promise<unknown>;
  /**
   * Waits for a first run to start, then until the runs have stopped
   * changing. Fails with a sentence when no run starts.
   */
  settle: (options?: SettleOptions) => Promise<void>;
  /** The runs since the check started, optionally of one function. */
  runs: (fn?: string) => Promise<SeenRun[]>;
  /** The threads the runs belong to, each with the runs it holds. */
  threads: () => Promise<SeenThread[]>;
  /** What the agents posted in the fake Slack. */
  posts: () => Promise<SeenPost[]>;
  /** Fails the check with one sentence saying why. */
  fail: (reason: string) => never;
}

export type Check = (t: CheckApi) => Promise<void>;
