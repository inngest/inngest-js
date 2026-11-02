/**
 * @module
 * EXPERIMENTAL: thread handles. A thread is one agent conversation with an
 * address: its key. It spans many runs.
 *
 * Everything sent to a thread is a plain event (`agent/message`,
 * `agent/steer`), so messages show up in the
 * event stream, can be inspected and shared like any other event, and start a
 * run when none is live: the agent function has a singleton
 * per thread, so a message sent while a run is live is skipped as a trigger and
 * reaches the run through its subscription instead.
 */

import type { InngestApi } from "../../../api/api.ts";
import { getAsyncCtxSync } from "../../../components/execution/als.ts";
import type { Inngest } from "../../../components/Inngest.ts";
import { step } from "../../../components/InngestStepTools.ts";
import type { EffectiveLimits } from "../agent/limits.ts";
import type { LastRun } from "../agent/recovery.ts";
import { parseWithAsync } from "../agent/validate.ts";
import {
  type AgentMessageData,
  type AgentSteerData,
  agentMessage,
  agentSteer,
} from "../inbox/events.ts";
import { type KvScopeInstance, type KvSource, kvFrom } from "../kv/kv.ts";

/**
 * The name of the event `thread.send()` sends.
 */
export const agentMessageEvent = agentMessage.name;

/**
 * The name of the other event a thread receives from the agent layer.
 */
export const agentSteerEvent = agentSteer.name;

/**
 * An event that started or reached an agent, as the agent sees it: the name
 * and data of the trigger.
 */
export type TriggerEvent<TName extends string = string, TData = unknown> = {
  id?: string;
  name: TName;
  data: TData;
};

export interface ThreadOptions {
  /**
   * KV store holding the thread state, or a function that returns one, called
   * at each use. Default: the store given to `createAgents`, else Redis at
   * `INNGEST_EXPERIMENTAL_KV_URL`.
   */
  kv?: KvSource;
}

/**
 * What a thread is doing.
 *
 * - `running`: a run is live and a turn is in flight.
 * - `waiting`: a run is live and waiting for its next message.
 * - `idle`: no run is live (never started, or the last run ended).
 */
export type ThreadStatus = "running" | "waiting" | "idle";

/**
 * What `handle.state()` returns.
 */
export interface ThreadState {
  status: ThreadStatus;

  /**
   * The loop turn of the latest model call (it starts again from 1 with each
   * `agent.loop()`), 0 before the first.
   */
  turn: number;

  /**
   * The latest non-empty model reply, cut to `summaryLength` characters.
   */
  summary: string | undefined;

  /**
   * Tokens used by every model call of the thread, across runs, and what they
   * cost in US dollars when the agent has a `limits.price`.
   */
  usage: { input: number; output: number; usd?: number };

  /**
   * The keys your code set in the thread's KV scope.
   */
  keys: Record<string, unknown>;

  /**
   * How the last run that ended, ended: `completed`, `failed` or
   * `cancelled`, with the error for a failure and what recovery did. Written
   * when the executor reports the ending, so it appears a moment after the
   * run stops. `undefined` before any run has ended.
   */
  lastRun: LastRun | undefined;
}

/**
 * What the agent function keeps in the thread KV (key `__state`) for
 * `state()`. Keys starting with `__` are hidden from `state().keys`.
 */
export interface ThreadRecord {
  status: ThreadStatus;
  turn: number;
  summary?: string;
  usage: { input: number; output: number; usd?: number };

  /**
   * The limits the agent that started this thread passed down, narrowed over
   * every start. Every later run of the thread applies them, so a sub-agent
   * woken by a plain message stays inside them.
   */
  inherited?: EffectiveLimits;

  /**
   * The run that wrote the record last, so a finished run never overwrites
   * the record of a newer one.
   */
  runId?: string;

  /**
   * The latest status changes with the time of each (milliseconds since the
   * epoch), so a message can be placed against what the thread was doing when
   * it arrived, not when it is looked at.
   */
  transitions?: { status: ThreadStatus; at: number }[];

  /**
   * The message the run is answering, from its delivery until the run waits
   * for the next one. A failed run resends it.
   */
  inflight?: Inflight;

  /**
   * The model call (run and step) whose turn the record last took in, so a
   * retried step does not count its usage twice.
   */
  turnStep?: string;

  /**
   * The process (boot) that wrote the record last.
   */
  host?: string;

  /**
   * How many times the run has continued in another process since it began.
   */
  restarts?: number;
}

/**
 * The message a turn answers, as a failed run resends it: the text of an
 * `agent/message`, or any other event as it came.
 */
export type Inflight =
  | { text: string; event?: undefined }
  | { event: { id?: string; name: string; data: unknown }; text?: undefined };

export const threadRecordKey = "__state";

/**
 * The KV key of how the thread's last run ended. It is a key of its own, not
 * a field of the record, because the record is rewritten whole by whichever
 * run writes it last.
 */
export const lastRunRecordKey = "__lastRun";

/**
 * The longest `summary` kept.
 */
export const summaryLength = 500;

export interface ThreadHandle {
  /**
   * The agent, as `"appId/functionId"`.
   */
  agent: string;
  key: string;

  /**
   * Sends a message that starts the next turn (and a run, if none is live).
   * Inside a function it is a step, so a replay sends it once.
   */
  send(message: string): Promise<void>;

  /**
   * Sends a message to fold into the turn that is running.
   */
  steer(message: string): Promise<void>;

  /**
   * Stops the thread by cancelling its live run by its run ID through the
   * Inngest API, so it needs the API reachable from where you call it (the
   * signing key, or the Dev Server), and works for any thread key.
   *
   * It returns `{ stopped: false }` when there was nothing to stop: a thread
   * with no record or no live run. A KV store that is not configured throws.
   */
  stop(): Promise<{ stopped: boolean }>;

  /**
   * What the thread is doing and has used. It reads the thread's KV scope, so
   * it works when no run is live.
   */
  state(): Promise<ThreadState>;
}

/**
 * The session metadata of a thread's events. The KV `session` scope reads it.
 * @param key Thread key.
 */
export function threadSessions(key: string): Record<string, string> {
  return { agent_session: key, agent_thread: key };
}

/**
 * The thread KV scope of a client, readable outside a function.
 * @param client Inngest client.
 * @param key Thread key.
 * @param kv KV store, or a function that returns one. Default: the store given
 * to `createAgents`, else Redis at `INNGEST_EXPERIMENTAL_KV_URL`.
 */
export function threadKv(
  client: Inngest.Any,
  key: string,
  kv?: KvSource,
): KvScopeInstance {
  return kvFrom(kv).with(client).scope("thread", key);
}

/**
 * The current function execution, when the caller can use steps: inside a
 * function but not inside a step's callback (which is already memoized).
 */
function stepContext() {
  const execution = getAsyncCtxSync()?.execution;

  return execution && !execution.executingStep ? execution : undefined;
}

/**
 * The thread state record as the handle shows it. A thread with no record has
 * never run.
 * @param record What the agent function kept, if anything.
 * @param all The thread's whole KV scope.
 */
export function threadStateOf(
  record: ThreadRecord | undefined,
  all: Record<string, unknown>,
): ThreadState {
  return {
    status: record?.status ?? "idle",
    turn: record?.turn ?? 0,
    summary: record?.summary,
    usage: record?.usage ?? { input: 0, output: 0 },
    lastRun: all[lastRunRecordKey] as LastRun | undefined,
    keys: Object.fromEntries(
      Object.entries(all).filter(([name]) => {
        return !name.startsWith("__");
      }),
    ),
  };
}

/**
 * EXPERIMENTAL: Gets the handle of a thread.
 * @param client Inngest client.
 * @param agent The agent, as `"appId/functionId"`.
 * @param key Thread key, the thread's address.
 * @param options KV override.
 */
export function getThread(
  client: Inngest.Any,
  agent: string,
  key: string,
  options: ThreadOptions = {},
): ThreadHandle {
  // Inside a function the send is a step, so a replay does not send it again.
  async function sendEvent(
    id: string,
    event: ReturnType<typeof agentMessage.create | typeof agentSteer.create>,
  ) {
    if (stepContext()) {
      await step.sendEvent(id, event);

      return;
    }

    await client.send(event);
  }

  const meta = { sessions: threadSessions(key) };

  return {
    agent,
    key,
    async send(message) {
      await sendEvent(
        `thread:${key}:message`,
        agentMessage.create(
          { agent, thread: key, text: message } satisfies AgentMessageData,
          { meta },
        ),
      );
    },
    async steer(message) {
      await sendEvent(
        `thread:${key}:steer`,
        agentSteer.create(
          { agent, thread: key, text: message } satisfies AgentSteerData,
          { meta },
        ),
      );
    },
    async stop() {
      // The live run is the one the thread record names. A thread with no
      // record, or whose record says no run is live, has nothing to cancel,
      // and the answer says so. A KV store that is not configured throws.
      const record = (await threadKv(client, key, options.kv).get(
        threadRecordKey,
      )) as ThreadRecord | undefined;

      if (
        !record?.runId ||
        (record.status !== "running" && record.status !== "waiting")
      ) {
        return { stopped: false };
      }

      const res = await (
        client as unknown as { inngestApi: InngestApi }
      ).inngestApi.cancelRun(record.runId);

      // The record said the run was live: a run that has just ended is a 404,
      // and it is stopped.
      if (!res.ok && res.error?.status !== 404) {
        throw new Error(res.error?.error ?? "Could not cancel the run.");
      }

      return { stopped: true };
    },
    async state() {
      const all = await threadKv(client, key, options.kv).all();

      return threadStateOf(
        all[threadRecordKey] as ThreadRecord | undefined,
        all,
      );
    },
  };
}
