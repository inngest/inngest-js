/**
 * @module
 * EXPERIMENTAL: how code starts an agent: `agent.start(input)`. It opens a new
 * thread with a generated key and sends the input to it as a message, then
 * returns at once. `result()` waits for the run that takes it, through an
 * inbox opened before the send.
 * The sender rides in `data.from` with the chain depth, the callee's thread
 * and the limits it inherits.
 */

import { getAsyncCtxSync } from "../../../components/execution/als.ts";
import type { Inngest } from "../../../components/Inngest.ts";
import type { SenderData } from "../inbox/events.ts";
import type { Json } from "../json.ts";
import {
  sendMessage,
  type ThreadHandle,
  threadHandle,
} from "../threads/thread.ts";
import { nextCount } from "./executionCounter.ts";
import {
  checkInvoke,
  childLimits,
  limitStateOf,
  readInheritedLimits,
} from "./limits.ts";
import type { ResultOptions } from "./runResults.ts";
import { currentSessions } from "./sessions.ts";

/**
 * How many agents deep a started run is: 1 for one started by a function that
 * is not an agent, 2 for the next, and so on. 0 for an event that did not come
 * from `start()`.
 */
export const invokeDepthOf = (
  /**
   * The event the function was started with.
   */
  event: { data?: Record<string, unknown> },
): number => {
  const from = event.data?.from as { depth?: unknown } | undefined;
  const depth = from?.depth;

  return typeof depth === "number" && depth > 0 ? depth : 0;
};

/**
 * The agent being started.
 */
export interface StartTarget {
  /**
   * The client of the app that defines the agent.
   */
  client: Inngest.Any;

  /**
   * The function ID.
   */
  id: string;

  /**
   * The address, `"appId/functionId"`.
   */
  address: string;

  /**
   * Whether the agent has an `invoke()` trigger: its input is then sent as that
   * trigger's data, not as the content of an `agent/message`.
   */
  typed: boolean;

  /**
   * Set for a run a model starts with `start_agent` (its end reaches the
   * model as an `agent/finished` message).
   */
  via?: "start_agent";

  /**
   * The thread to start the run on. Default: a new thread with a generated key.
   */
  thread?: string;
}

/**
 * The thread a `start()` opened.
 */
export interface StartedThread<TOutput = unknown>
  extends ThreadHandle<TOutput> {
  /**
   * Waits for the run `start()` began and gives its output. It throws when the
   * run failed or was stopped. With a `timeout` it throws an
   * `AgentTimeoutError` when the run is not done in time, and the run keeps
   * going; there is no default timeout. It works whenever it is called, and a
   * later `result()` keeps waiting for the same run.
   */
  result(options?: ResultOptions): Promise<TOutput>;
}

/**
 * What `start()` returns: a promise of the handle that also has its methods,
 * so `start(x).result()` needs one `await`.
 */
export type StartedThreadPromise<TOutput = unknown> = Promise<
  StartedThread<TOutput>
> &
  Pick<StartedThread<TOutput>, "result" | "stop" | "message" | "ask">;

/**
 * Starts the agent.
 * @param target The agent to start.
 * @param input Its input.
 */
export function startThread<TOutput>(
  target: StartTarget,
  input: unknown,
): StartedThreadPromise<TOutput> {
  const execution = getAsyncCtxSync()?.execution;

  if (!execution) {
    throw new Error("start() must be called inside an Inngest function");
  }

  const { ctx, instance } = execution;
  const inherited = readInheritedLimits(
    (ctx.event as { data?: { from?: unknown } }).data?.from,
  );
  const limits = limitStateOf(instance, inherited);

  if (limits) {
    checkInvoke(limits, target.address);
  }

  const n = nextCount(instance, "start");
  // The address leads a generated key, so a tool that is given only the key
  // can tell which agent the thread belongs to.
  const key = target.thread ?? `${target.address}:${ctx.runId}.${n}`;
  const sessions = {
    agent_session: currentSessions(ctx).agent_session ?? (ctx.runId as string),
    agent_thread: key,
  };

  // A start is a message to the new thread: the sender carries the key of the
  // thread it opens and what it passes down, and the result comes back to a
  // private inbox opened before the send, so no step waits for the child.
  const call = sendMessage<TOutput>(
    target.client,
    target.address,
    key,
    input as Json,
    {
      sessions,
      from: {
        thread: key,
        ...(limits && { limits: childLimits(limits) }),
        ...(target.typed && { typed: true }),
        ...(target.via && { via: target.via, target: target.address }),
      },
    },
  );
  const thread = threadHandle<TOutput>(target.client, target.address, key);
  const handle: StartedThread<TOutput> = {
    ...thread,
    result(options) {
      return call.result(options);
    },
  };
  const started = call.then(() => {
    return handle;
  });

  return Object.assign(started, {
    result: handle.result,
    stop: handle.stop,
    message: handle.message,
    ask: handle.ask,
  });
}
