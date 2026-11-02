/**
 * @module
 * EXPERIMENTAL: the function options an agent takes from its config as they
 * are, and the ones it refuses.
 */

import type { Inngest } from "../../../components/Inngest.ts";
import type { InngestFunction } from "../../../components/InngestFunction.ts";
import { step } from "../../../components/InngestStepTools.ts";
import type { Middleware } from "../../../components/middleware/middleware.ts";

/**
 * The options of a plain Inngest function that an agent takes as they are.
 * The agent owns `triggers` (see `triggers`) and `singleton` (one live run per
 * thread), and rejects `debounce`, `batchEvents` and `checkpointing`,
 * which would break what a thread's run is.
 */
export interface AgentFunctionOptions<
  TMiddleware extends Middleware.Class[] | undefined =
    | Middleware.Class[]
    | undefined,
> {
  /**
   * The name the function shows in the Inngest UI. Default: its `id`.
   */
  name?: InngestFunction.Options["name"];
  /**
   * A longer description of the function, shown in the Inngest UI. It is also
   * what the model reads when the agent is one of the `tools` of another.
   */
  description?: InngestFunction.Options["description"];

  /**
   * Limits the steps that run at once, across threads or per key (per tenant,
   * say). It never lets two runs of one thread live at once: the singleton
   * does that. A run waiting for its next message holds no concurrency.
   */
  concurrency?: InngestFunction.Options["concurrency"];

  /**
   * How often a failing run is retried. A retry replays the body, so the
   * thread's steps are memoized as for any function.
   */
  retries?: InngestFunction.Options["retries"];

  /**
   * How long a run may wait to start (`start`) and take (`finish`). A thread
   * lives across many messages, so a `finish` timeout ends the whole run, not
   * one turn: the thread's sandboxes are saved and its next message starts a
   * new run.
   */
  timeouts?: InngestFunction.Options["timeouts"];

  /**
   * Events that cancel a live run, as for any function. The run's cleanup
   * (sandboxes, run-scoped KV) happens as for `handle.stop()`.
   */
  cancelOn?: InngestFunction.Options["cancelOn"];

  /**
   * Called when a run fails for good. It is a function of its own, started
   * with the failure event, and gets that event's context, not the agent's.
   */
  onFailure?: InngestFunction.Options["onFailure"];

  /**
   * Drops a trigger event whose key was seen in the last 24 hours. It applies
   * to the events that start a run, not to messages a live run reads from its
   * inbox. A key that repeats across a thread's messages, such as the thread
   * key, would stop its later messages from starting a run once the first has
   * ended: key it by something unique to the event, such as its ID.
   */
  idempotency?: InngestFunction.Options["idempotency"];

  /**
   * Skips trigger events beyond the limit. The skipped event does not start a
   * run; a live run still reads it from its inbox.
   */
  rateLimit?: InngestFunction.Options["rateLimit"];

  /**
   * Delays trigger events beyond the limit instead of skipping them.
   */
  throttle?: InngestFunction.Options["throttle"];

  /**
   * Runs of this function ahead of or behind others.
   */
  priority?: InngestFunction.Options["priority"];

  /**
   * Middleware for this function's runs. What it adds to `step`, `group` and
   * the rest of the context is typed in the body, with the client's.
   */
  middleware?: TMiddleware;

  /**
   * Not allowed. A debounce keeps only the last of a burst of events, so the
   * messages before it would never reach the thread.
   */
  debounce?: never;

  /**
   * Not allowed. The agent reads one event at a time from its inbox.
   */
  batchEvents?: never;

  /**
   * Not allowed. The agent has a singleton per thread of its own.
   */
  singleton?: never;

  /**
   * Not allowed. Checkpointing changes how steps run in a way the inbox's
   * waiting and wake-ups do not support.
   */
  checkpointing?: never;
}

/**
 * The options of `AgentFunctionOptions` an agent passes on to its function. The
 * type test `agentFunctionOptions.test.ts` checks that every option is in this
 * list or in `refusedOptions`, so a new option cannot be dropped silently.
 */
export const takenOptions = [
  "name",
  "description",
  "concurrency",
  "retries",
  "timeouts",
  "cancelOn",
  "onFailure",
  "idempotency",
  "rateLimit",
  "throttle",
  "priority",
  "middleware",
] as const;

/**
 * The options of `AgentFunctionOptions` that are `never`: an agent refuses them.
 */
export const refusedOptions = [
  "debounce",
  "batchEvents",
  "singleton",
  "checkpointing",
] as const;

/**
 * The function options an agent's config passes on. A refused option throws,
 * for the callers the types do not stop.
 * @param config The agent's config.
 */
export const functionOptions = (
  config: AgentFunctionOptions & { id: string },
): Partial<InngestFunction.Options> => {
  for (const key of refusedOptions) {
    if (config[key] !== undefined) {
      throw new Error(
        `Agent "${config.id}" does not take the \`${key}\` option: see AgentFunctionOptions`,
      );
    }
  }

  return Object.fromEntries(
    takenOptions
      .filter((key) => {
        return config[key] !== undefined;
      })
      .map((key) => {
        return [key, config[key]];
      }),
  );
};
