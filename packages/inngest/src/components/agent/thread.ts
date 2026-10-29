/**
 * @module
 * EXPERIMENTAL: thread handles. A thread is one agent conversation with an
 * address: its key. It spans many runs.
 *
 * Everything sent to a thread is a plain event (`agent/message`,
 * `agent/steer`, `agent/stop`, `agent/request`), so messages show up in the
 * event stream, can be inspected and shared like any other event, and start a
 * run when none is live (all but a stop): the agent function has a singleton
 * per thread, so a message sent while a run is live is skipped as a trigger and
 * reaches the run through its subscription instead.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { InngestApi } from "../../api/api.ts";
import { getAsyncCtxSync } from "../execution/als.ts";
import type { Inngest } from "../Inngest.ts";
import { step } from "../InngestStepTools.ts";
import { parseWithAsync } from "./channels.ts";
import {
  type AgentMessageData,
  type AgentRequestData,
  type AgentSteerData,
  type AgentStopData,
  agentMessage,
  agentRequest,
  agentSteer,
  agentStop,
} from "./events.ts";
import { nextCount } from "./executionCounter.ts";
import { type KvScopeInstance, type KvSource, kvFrom } from "./kv.ts";
import type { EffectiveLimits } from "./limits.ts";
import type { LastRun } from "./recovery.ts";

/**
 * The name of the event every thread message is sent as.
 */
export const agentMessageEvent = agentMessage.name;

/**
 * The names of the other events a thread receives from the agent layer.
 */
export const agentSteerEvent = agentSteer.name;
export const agentStopEvent = agentStop.name;
export const agentRequestEvent = agentRequest.name;

/**
 * An event that started or reached an agent, as the agent sees it: the name
 * and data of the trigger.
 */
export type TriggerEvent<TName extends string = string, TData = unknown> = {
  id?: string;
  name: TName;
  data: TData;
};

/**
 * The types of the requests an agent takes: what other threads ask and what
 * the agent replies. The schemas give the types (`staticSchema()` for types
 * only). A request is checked against `request` when it is sent through the
 * agent's own `agent.thread()` handle, and a reply against `reply` when the
 * agent sends it. A schema must accept the value it outputs, so one that
 * transforms its input is a type error.
 */
export interface ThreadRequests<TRequest = unknown, TReply = unknown> {
  request: StandardSchemaV1<TRequest, TRequest>;
  reply: StandardSchemaV1<TReply, TReply>;
}

export interface ThreadOptions<TRequest = unknown, TReply = unknown> {
  /**
   * Session the thread belongs to. Default: the thread key.
   */
  session?: string;

  /**
   * KV store holding the thread state, or a function that returns one, called
   * at each use. Default: the store given to `createAgents`, else Redis at
   * `INNGEST_EXPERIMENTAL_KV_URL`.
   */
  kv?: KvSource;

  /**
   * The agent's request and reply schemas: `request()` checks its payload
   * against `request` before sending it.
   */
  requests?: ThreadRequests<TRequest, TReply>;
}

/**
 * What a thread is doing.
 *
 * - `running`: a run is live and a turn is in flight.
 * - `waiting`: a run is live and waiting for its next message.
 * - `stopped`: the thread honored a stop request and has not run since.
 * - `idle`: no run is live (never started, or the last run ended).
 */
export type ThreadStatus = "running" | "waiting" | "stopped" | "idle";

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

export interface RequestOptions {
  /**
   * How long to wait for the reply. Default `"1h"`.
   */
  timeout?: string | number;
}

export interface ThreadHandle<TRequest = unknown, TReply = unknown> {
  /**
   * The agent, as `"appId/functionId"`.
   */
  agent: string;
  key: string;
  session: string;

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
   * Stops the thread. `"nextTurn"` lets the running model call finish and
   * stops before the next; `"now"` cancels the live run by its run ID through the
   * Inngest API, so it needs the API reachable from where you call it (the
   * signing key, or the Dev Server), and works for any thread key.
   *
   * It returns `{ stopped: false }` when there was nothing to stop: with `"now"`,
   * a thread with no record or no live run. A message for `"nextTurn"` is always
   * sent. A KV store that is not configured throws.
   */
  stop(options: { when: "now" | "nextTurn" }): Promise<{ stopped: boolean }>;

  /**
   * What the thread is doing and has used. It reads the thread's KV scope, so
   * it works when no run is live.
   */
  state(): Promise<ThreadState>;

  /**
   * Asks the thread something and waits for its reply: an inbox message plus a
   * signal the thread answers with `message.reply()`. It is not an invoke; a
   * live run reads it from its inbox, and an idle thread is woken for it like
   * by any message. Only inside a function, because the wait is a step.
   * Resolves to the reply, or `null` when the timeout passes.
   *
   * `payload` and the reply are typed by the agent's `requests` config when
   * the handle comes from `agent.thread()`. Otherwise both are `unknown`, and
   * `TAnswer` names the reply you expect (not checked).
   * @param payload What to ask.
   * @param options Timeout.
   */
  request<TAnswer extends TReply = TReply>(
    payload: TRequest,
    options?: RequestOptions,
  ): Promise<TAnswer | null>;
}

/**
 * The session metadata of a thread's events.
 * @param key Thread key.
 * @param session Session the thread belongs to. Default: the thread key.
 */
export function threadSessions(
  key: string,
  session: string = key,
): Record<string, string> {
  return { agent_session: session, agent_thread: key };
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
 * @param options Session and KV overrides.
 */
export function getThread<TRequest = unknown, TReply = unknown>(
  client: Inngest.Any,
  agent: string,
  key: string,
  options: ThreadOptions<TRequest, TReply> = {},
): ThreadHandle<TRequest, TReply> {
  const session = options.session ?? key;

  // Inside a function the send is a step, so a replay does not send it again.
  async function sendEvent(
    id: string,
    event: ReturnType<
      | typeof agentMessage.create
      | typeof agentSteer.create
      | typeof agentStop.create
      | typeof agentRequest.create
    >,
  ) {
    if (stepContext()) {
      await step.sendEvent(id, event);

      return;
    }

    await client.send(event);
  }

  const meta = { sessions: threadSessions(key, session) };

  return {
    agent,
    key,
    session,
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
    async stop({ when }) {
      if (when === "now") {
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
      }

      await sendEvent(
        `thread:${key}:stop`,
        agentStop.create({ agent, thread: key, when } satisfies AgentStopData, {
          meta,
        }),
      );

      return { stopped: true };
    },
    async state() {
      const all = await threadKv(client, key, options.kv).all();

      return threadStateOf(
        all[threadRecordKey] as ThreadRecord | undefined,
        all,
      );
    },
    async request<TAnswer extends TReply>(
      payload: TRequest,
      requestOptions: RequestOptions = {},
    ) {
      const execution = stepContext();
      if (!execution) {
        throw new Error(
          "thread.request() waits for a reply with a signal, so it must be called inside a function.",
        );
      }

      const asked = options.requests
        ? await parseWithAsync(
            options.requests.request,
            payload,
            "thread.request() payload",
          )
        : payload;

      const count = nextCount(execution.instance, "request") + 1;

      const signal = `thread-request:${execution.ctx.runId}:${count}`;
      const event = execution.ctx.event as {
        name: string;
        data?: { thread?: string };
      };

      // The wait is first, so it is open before the other thread can answer.
      const [reply] = await Promise.all([
        step.waitForSignal(`request:${key}:${count}:reply`, {
          signal,
          timeout: requestOptions.timeout ?? "1h",
          onConflict: "replace",
        }),
        sendEvent(
          `thread:${key}:request`,
          agentRequest.create(
            {
              agent,
              thread: key,
              payload: asked,
              replyTo: signal,
              from:
                execution.agent?.thread ??
                (event.name.startsWith("agent/")
                  ? event.data?.thread
                  : undefined),
            } satisfies AgentRequestData,
            { meta },
          ),
        ),
      ]);

      return (reply?.data ?? null) as TAnswer | null;
    },
  };
}
