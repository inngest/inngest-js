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
import { getThread } from "../threads/thread.ts";
import { nextCount } from "./executionCounter.ts";
import {
  checkInvoke,
  childLimits,
  limitStateOf,
  readInheritedLimits,
} from "./limits.ts";
import { currentSessions } from "./sessions.ts";

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

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

/**
 * What `step.invoke` gives back for a cancelled run: the whole
 * `inngest/function.finished` event, not an output.
 */
const stoppedRun = (result: unknown): { runId?: string } | undefined => {
  if (!isRecord(result) || result.name !== "inngest/function.finished") {
    return undefined;
  }

  const data = result.data;
  const info = isRecord(data) ? data._inngest : undefined;

  if (!isRecord(data) || !isRecord(info) || info.status !== "Cancelled") {
    return undefined;
  }

  return { runId: typeof data.run_id === "string" ? data.run_id : undefined };
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
   * run failed or was stopped.
   */
  result(): Promise<TOutput>;

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

const noop = () => {};

/**
 * The macrotask a `start()` yields after issuing its invoke, so the engine
 * reports the op before the handler can return without awaiting it.
 */
const flush = (): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
};

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

  const handle: StartedThread<TOutput> = {
    key,
    async result() {
      const output = await invoked;
      const stopped = stoppedRun(output);

      if (stopped) {
        throw new AgentStoppedError(target.address, stopped.runId);
      }

      return output as TOutput;
    },
    async stop() {
      await getThread(target.client, target.address, key).stop();
    },
  };

  // A replayed invoke is already answered, so the race ends without waiting
  // for the macrotask, which the engine would take for work it must wait for.
  const started = Promise.race([flush(), invoked.then(noop, noop)]).then(() => {
    return handle;
  });

  return Object.assign(started, {
    result: handle.result,
    stop: handle.stop,
  });
}
