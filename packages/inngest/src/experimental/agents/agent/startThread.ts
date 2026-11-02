/**
 * @module
 * EXPERIMENTAL: how code starts an agent: `agent.start(input)`. It opens a new
 * thread with a generated key, starts a run on it through a `step.invoke` to
 * the agent's function and returns at once. `result()` waits for that run.
 * The sender rides in `data.from` with the chain depth, the callee's thread
 * and the limits it inherits.
 */

import { getAsyncCtxSync } from "../../../components/execution/als.ts";
import type { Inngest } from "../../../components/Inngest.ts";
import { referenceFunction } from "../../../components/InngestFunctionReference.ts";
import { step } from "../../../components/InngestStepTools.ts";
import { NonRetriableError } from "../../../components/NonRetriableError.ts";
import type { SenderData } from "../inbox/events.ts";
import type { Json } from "../json.ts";
import { threadHandle } from "../threads/thread.ts";
import { nextCount } from "./executionCounter.ts";
import {
  checkInvoke,
  childLimits,
  limitStateOf,
  readInheritedLimits,
} from "./limits.ts";
import {
  AgentStoppedError,
  AgentTimeoutError,
  flush,
  isRecord,
  noop,
  type ResultOptions,
  stoppedRun,
  timedOut,
} from "./runResults.ts";
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
  const from = event.data?.from;
  const depth = isRecord(from) ? from.depth : undefined;

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
   * model as an `agent/finished` message) or sandbox code starts (its end
   * reaches `agent_result`).
   */
  via?: "start_agent" | "sandbox";
}

/**
 * The thread a `start()` opened.
 */
export interface StartedThread<TOutput = unknown> {
  /**
   * The thread's key.
   */
  key: string;

  /**
   * Waits for the run `start()` began and gives its output. It throws when the
   * run failed or was stopped. With a `timeout` it throws an
   * `AgentTimeoutError` when the run is not done in time, and the run keeps
   * going; there is no default timeout. A timeout works only when `result()`
   * is chained onto the start in the same tick (`await agent.start(x).result({
   * timeout })`): a pending step holds back the code after it, so once
   * `start()` has been awaited the timeout would never fire. Asking for one
   * then throws an error that names the chained form.
   */
  result(options?: ResultOptions): Promise<TOutput>;

  /**
   * Stops the thread's live run.
   */
  stop(): Promise<void>;
}

/**
 * What `start()` returns: a promise of the handle that also has its methods,
 * so `start(x).result()` needs one `await`.
 */
export type StartedThreadPromise<TOutput = unknown> = Promise<
  StartedThread<TOutput>
> &
  Pick<StartedThread<TOutput>, "result" | "stop">;

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
  const key = `${target.id}:${ctx.runId}.${n}`;
  const sessions = {
    agent_session: currentSessions(ctx).agent_session ?? (ctx.runId as string),
    agent_thread: key,
  };
  const parent = (ctx.event as { data?: { from?: { depth?: unknown } } }).data
    ?.from;
  const depth = typeof parent?.depth === "number" ? parent.depth : 0;
  const self = execution.agent;
  const from: SenderData & { thread: string; limits?: unknown } = self?.ref
    ? {
        kind: "agent",
        address: self.ref,
        key: self.thread,
        depth: depth + 1,
        thread: key,
        ...(target.via && { via: target.via, target: target.address }),
      }
    : {
        kind: "function",
        id: ctx.runId as string,
        key: ctx.runId as string,
        depth: depth + 1,
        thread: key,
      };

  if (limits) {
    from.limits = childLimits(limits);
  }

  const data = target.typed
    ? { ...(input as Record<string, unknown>), from }
    : { agent: target.address, thread: key, content: input as Json, from };
  const slash = target.address.indexOf("/");
  const invoked = step.invoke(
    { id: `start:${target.address}:${n}`, name: `start ${target.address}` },
    {
      function: referenceFunction({
        appId: target.address.slice(0, slash),
        functionId: target.address.slice(slash + 1),
      }),
      data,
      meta: { sessions },
    },
  );

  // An unread result must not become an unhandled rejection.
  invoked.catch(() => {});

  let waits = 0;

  // Set once the start has been planned: from then on the code after it has
  // waited for the run's step, so a timeout has nothing left to race.
  let planned = false;
  const handle: StartedThread<TOutput> = {
    key,
    async result(options) {
      if (planned && options?.timeout !== undefined) {
        throw new Error(
          "result({ timeout }) must be chained onto the start: write `await agent.start(input).result({ timeout })`. After `await agent.start(input)` the run is already planned, so a timeout would never fire.",
        );
      }

      waits += 1;

      const wait = waits;
      const output =
        options?.timeout === undefined
          ? await invoked
          : await Promise.race([
              invoked,
              step
                .waitForEvent(`start:${target.address}:${n}:timeout:${wait}`, {
                  event: "agent/result.timeout",
                  timeout: options.timeout,
                })
                .then(() => {
                  return timedOut;
                }),
            ]);

      if (output === timedOut) {
        throw new AgentTimeoutError(target.address);
      }

      const stopped = stoppedRun(output);

      if (stopped) {
        throw new AgentStoppedError(target.address, stopped.runId);
      }

      return output as TOutput;
    },
    async stop() {
      await threadHandle(target.client, target.address, key).stop();
    },
  };

  // A replayed invoke is already answered, so the race ends without waiting
  // for the macrotask, which the engine would take for work it must wait for.
  const started = Promise.race([flush(), invoked.then(noop, noop)]).then(() => {
    planned = true;

    return handle;
  });

  return Object.assign(started, {
    result: handle.result,
    stop: handle.stop,
  });
}
