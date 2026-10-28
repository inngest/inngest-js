/**
 * @module
 * EXPERIMENTAL: thread handles. A thread is one agent conversation with an
 * address: its key. It spans many runs.
 *
 * Everything sent to a thread is an event (`agent/message`), so messages show
 * up in the event stream, can be inspected and shared like any other event, and
 * start a run when none is live: the agent function has a singleton per
 * thread, so a message sent while a run is live is skipped as a trigger and
 * reaches the run through its subscription instead.
 */

import type { InngestApi } from "../../api/api.ts";
import { getAsyncCtxSync } from "../execution/als.ts";
import type { Inngest } from "../Inngest.ts";
import { step } from "../InngestStepTools.ts";
import { nextCount } from "./executionCounter.ts";
import { kv as defaultKv, type Kv, type KvScopeInstance } from "./kv.ts";
import type { EffectiveLimits } from "./limits.ts";

/**
 * The event every thread message is sent as.
 */
export const agentMessageEvent = "agent/message";

/**
 * What a thread message event carries in `data`.
 */
export interface ThreadMessage {
  /**
   * The agent, as `"appId/functionId"`.
   */
  agent: string;

  /**
   * The thread key.
   */
  thread: string;

  /**
   * `"user"` messages start the next turn; `"steer"` messages are folded into
   * the turn that is running; `"stop"` asks the thread to stop; `"request"`
   * is a question from another thread, answered with `message.reply()`. A
   * stop never starts a run, so stopping an idle thread does nothing.
   */
  kind: "user" | "steer" | "stop" | "request";
  content?: string;

  /**
   * For `"request"`: what the other thread asks.
   */
  payload?: unknown;

  /**
   * For `"request"`: the signal the reply is sent to.
   */
  replyTo?: string;

  /**
   * For `"request"`: the key of the thread that asked, when it is a thread.
   */
  from?: string;

  /**
   * For `"stop"`: `"nextTurn"` lets the running model call finish.
   */
  when?: "nextTurn";

  /**
   * For a message made from a trigger event: that event.
   */
  event?: { id?: string; name: string; data: unknown };
}

export interface ThreadOptions {
  /**
   * Session the thread belongs to. Default: the thread key.
   */
  session?: string;

  /**
   * KV store holding the thread state. Default: Redis at
   * `INNGEST_EXPERIMENTAL_KV_URL`.
   */
  kv?: Kv;
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
   * Tokens used by every model call of the thread, across runs.
   */
  usage: { input: number; output: number };

  /**
   * The keys your code set in the thread's KV scope.
   */
  keys: Record<string, unknown>;
}

/**
 * What the agent function keeps in the thread KV (key `__state`) for
 * `state()`. Keys starting with `__` are hidden from `state().keys`.
 */
export interface ThreadRecord {
  status: ThreadStatus;
  turn: number;
  summary?: string;
  usage: { input: number; output: number };

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
}

export const threadRecordKey = "__state";

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

export interface ThreadHandle {
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
   * stops before the next; `"now"` cancels the live run. It does nothing when
   * no run is live. `"now"` cancels the run by its run ID through the
   * Inngest API, so it needs the API reachable from where you call it (the
   * signing key, or the Dev Server), and works for any thread key.
   */
  stop(options: { when: "now" | "nextTurn" }): Promise<void>;

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
   * @param payload What to ask.
   * @param options Timeout.
   */
  request<TReply = unknown>(
    payload: unknown,
    options?: RequestOptions,
  ): Promise<TReply | null>;
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
 * @param kv KV store. Default: Redis at `INNGEST_EXPERIMENTAL_KV_URL`.
 */
export function threadKv(
  client: Inngest.Any,
  key: string,
  kv: Kv = defaultKv,
): KvScopeInstance {
  return kv.with(client).scope("thread", key);
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
export function getThread(
  client: Inngest.Any,
  agent: string,
  key: string,
  options: ThreadOptions = {},
): ThreadHandle {
  const session = options.session ?? key;

  // Inside a function the send is a step, so a replay does not send it again.
  async function sendEvent(
    id: string,
    event: { name: string; data: unknown; meta?: unknown },
  ) {
    if (stepContext()) {
      await step.sendEvent(id, event as never);

      return;
    }

    await client.send(event as never);
  }

  async function post(message: ThreadMessage) {
    await sendEvent(`thread:${key}:${message.kind}`, {
      name: agentMessageEvent,
      data: message,
      meta: { sessions: threadSessions(key, session) },
    });
  }

  return {
    agent,
    key,
    session,
    async send(message) {
      await post({ agent, thread: key, kind: "user", content: message });
    },
    async steer(message) {
      await post({ agent, thread: key, kind: "steer", content: message });
    },
    async stop({ when }) {
      if (when === "now") {
        // The live run is the one the thread record names. A thread with no
        // live run has nothing to cancel.
        const record = (await threadKv(client, key, options.kv).get(
          threadRecordKey,
        )) as ThreadRecord | undefined;

        if (
          record?.runId &&
          (record.status === "running" || record.status === "waiting")
        ) {
          const res = await (
            client as unknown as { inngestApi: InngestApi }
          ).inngestApi.cancelRun(record.runId);

          if (!res.ok) {
            throw new Error(res.error?.error ?? "Could not cancel the run.");
          }
        }

        return;
      }

      await post({ agent, thread: key, kind: "stop", when });
    },
    async state() {
      const all = await threadKv(client, key, options.kv).all();

      return threadStateOf(
        all[threadRecordKey] as ThreadRecord | undefined,
        all,
      );
    },
    async request<TReply>(
      payload: unknown,
      requestOptions: RequestOptions = {},
    ) {
      const execution = stepContext();
      if (!execution) {
        throw new Error(
          "thread.request() waits for a reply with a signal, so it must be called inside a function.",
        );
      }

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
        post({
          agent,
          thread: key,
          kind: "request",
          payload,
          replyTo: signal,
          from:
            execution.agent?.thread ??
            (event.name === agentMessageEvent ? event.data?.thread : undefined),
        }),
      ]);

      return (reply?.data ?? null) as TReply | null;
    },
  };
}
