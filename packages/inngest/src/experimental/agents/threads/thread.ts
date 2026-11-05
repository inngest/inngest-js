/**
 * @module
 * EXPERIMENTAL: thread handles. A thread is one agent conversation with an
 * address: its key. It spans many runs.
 *
 * Everything sent to a thread is a plain event (`agent/message`,
 * `agent/recover`), so messages show up in the
 * event stream, can be inspected and shared like any other event, and start a
 * run when none is live: the agent function has a singleton
 * per thread, so a message sent while a run is live is skipped as a trigger and
 * reaches the run through its subscription instead.
 */

import type { InngestApi } from "../../../api/api.ts";
import { getAsyncCtxSync } from "../../../components/execution/als.ts";
import type { Inngest } from "../../../components/Inngest.ts";
import { step } from "../../../components/InngestStepTools.ts";
import { inboxOpenedPromise } from "../../../components/inbox/Inbox.ts";
import { nextCount } from "../agent/executionCounter.ts";
import {
  hasStarted,
  renewalFor,
  unattachedGrantSeconds,
} from "../agent/grant.ts";
import type { LentRecord } from "../agent/lending.ts";
import type { AgentBudget, EffectiveLimits } from "../agent/limits.ts";
import type { LastRun } from "../agent/recovery.ts";
import { relationOf } from "../agent/relations.ts";
import {
  AgentStoppedError,
  AgentTimeoutError,
  noop,
  type ResultOptions,
} from "../agent/runResults.ts";
import { senderOf } from "../agent/sender.ts";
import { parseWithAsync } from "../agent/validate.ts";
import {
  type AgentAnswerData,
  type AgentMessageData,
  type AgentMessageResultData,
  agentAnswer,
  agentFinished,
  agentMessage,
  agentMessageResult,
  agentQuestion,
  agentRecover,
} from "../inbox/events.ts";
import { handleAddressKey } from "../inbox/handleAddressKey.ts";
import type { Json } from "../json.ts";
import { type KvScopeInstance, kv } from "../kv/kv.ts";

/**
 * The name of the event `thread.message()` sends.
 */
export const agentMessageEvent = agentMessage.name;

/**
 * The name of the event that sends a failed run's message again.
 */
export const agentRecoverEvent = agentRecover.name;

/**
 * The names of the question, answer and finished events.
 */
export const agentQuestionEvent = agentQuestion.name;
export const agentAnswerEvent = agentAnswer.name;
export const agentFinishedEvent = agentFinished.name;
export const agentMessageResultEvent = agentMessageResult.name;

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
 * What a thread is doing.
 *
 * - `running`: a run is live and a turn is in flight.
 * - `waiting`: a run is live and waiting for its next message.
 * - `idle`: no run is live (never started, or the last run ended).
 */
export type ThreadStatus = "running" | "waiting" | "idle";

/**
 * What the agent function keeps about a thread's state.
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
   * cost in US dollars when the agent has a the agent's `price`.
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
 * What the agent function keeps in the thread KV (key `__state:<agent>`, see
 * `threadRecordKey`) for the thread state. Keys starting with `__` are hidden
 * from `keys`.
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
   * What the thread may spend, from the definition of the agent that owns it.
   * Set by the first run and kept, so every later run enforces the same
   * budget and it is never handed down to another agent's thread.
   */
  budget?: AgentBudget;

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
   * The IDs of the `agent/message` events the run took after the one that
   * started it, so the finished function can tell each sender how the run
   * ended. Only the run named in `run` counts.
   */
  folded?: { run: string; ids: string[] };

  /**
   * The lend the first run took: the parent run that lent, the names of the
   * tools lent and the run that took it. Kept so a copy of the start message
   * cannot take the lend again and a later message can be told the tools are
   * gone.
   */
  lent?: LentRecord;

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
  | {
      content: Json;
      event?: undefined;

      /**
       * The message's ID, whose sender waits for its result, and who sent it.
       */
      id?: string;
      from?: unknown;
    }
  | { event: { id?: string; name: string; data: unknown }; text?: undefined };

/**
 * The thread KV key of an agent's run record. Run records belong to an agent
 * (its address, `"appId/functionId"`) as well as a thread key, because two
 * agents may share a thread key: each keeps its own record, while the keys your
 * code sets in `kv.thread` stay shared by the key.
 * @param agent The agent, as `"appId/functionId"`.
 */
export const threadRecordKey = (agent: string): string => {
  return `__state:${agent}`;
};

/**
 * The thread KV key of how the agent's last run on the thread ended. It is a
 * key of its own, not a field of the record, because the record is rewritten
 * whole by whichever run writes it last.
 * @param agent The agent, as `"appId/functionId"`.
 */
export const lastRunRecordKey = (agent: string): string => {
  return `__lastRun:${agent}`;
};

/**
 * The thread KV key of the agent's remembered history.
 * @param agent The agent, as `"appId/functionId"`.
 */
export const historyRecordKey = (agent: string): string => {
  return `__history:${agent}`;
};

/**
 * The longest `summary` kept.
 */
export const summaryLength = 500;

/**
 * Options of `ask()`.
 */
export interface AskOptions {
  /**
   * How long to wait for the answer, as a duration string (`"5m"`) or
   * milliseconds. Default: one hour.
   */
  timeout?: string | number;
}

/**
 * The run that took a message, to wait for.
 */
export interface RunHandle<TOutput = unknown> {
  /**
   * Waits for the output of the run that took the message: the live run it
   * folded into (which, for a trigger-started run, ends after its `idle`), or
   * a new run it started on an idle thread. It throws when the run failed or
   * was stopped. With a `timeout` it throws an `AgentTimeoutError` when the run
   * is not done in time, and the run keeps going. It works whenever it is called.
   */
  result(options?: ResultOptions): Promise<TOutput>;
}

/**
 * What `message()` returns: a promise of the run handle that also has its
 * methods, so `await thread.message(x).result()` needs one `await`. Without an
 * `await` the message is still sent when the caller is an agent; a plain
 * function that returns at once may return before the engine reports the step,
 * so `await` it there.
 */
export type MessageCall<TOutput = unknown> = Promise<RunHandle<TOutput>> &
  RunHandle<TOutput>;

export interface ThreadHandle<TOutput = unknown> {
  /**
   * The thread's key.
   */
  key: string;

  /**
   * Sends a message to the thread: into the live run's inbox, or as the
   * start of a run when the thread is idle. It is a step, so a replay sends
   * it once. Needs a function's step context and throws outside one: a route
   * or an API handler sends the agent's trigger event instead.
   */
  message(content: Json): MessageCall<TOutput>;

  /**
   * Asks the thread a question and waits for the answer, which is a string.
   * It is `null` when the thread refuses, or does not answer in time (default
   * timeout: one hour). The answer goes only to this call and never to an
   * inbox. A question to an idle thread starts a run there. Needs a function's
   * step context.
   */
  ask(question: string, options?: AskOptions): Promise<string | null>;

  /**
   * Stops the thread by cancelling its live run by its run ID through the
   * Inngest API, so it needs the API reachable from where you call it (the
   * signing key, or the Dev Server), and works for any thread key. A thread
   * with no live run has nothing to stop, and the call does nothing. A KV
   * store that is not configured throws. It reads the thread's record, so
   * with the ledger KV store it works inside a function only.
   */
  stop(): Promise<void>;
}

/**
 * The session metadata of a thread's events.
 * @param key Thread key.
 */
export function threadSessions(key: string): Record<string, string> {
  return { agent_session: key, agent_thread: key };
}

/**
 * The thread KV scope of a client, readable outside a function.
 * @param client Inngest client.
 * @param key Thread key.
 */
export function threadKv(client: Inngest.Any, key: string): KvScopeInstance {
  return kv.with(client).scope("thread", key);
}

/**
 * The current function execution, when the caller can use steps: inside a
 * function but not inside a step's callback (which is already memoized).
 */
export function stepContext() {
  const execution = getAsyncCtxSync()?.execution;

  return execution && !execution.executingStep ? execution : undefined;
}

/**
 * The thread state record as the handle shows it. A thread with no record has
 * never run.
 * @param agent The agent, as `"appId/functionId"`.
 * @param record What the agent function kept, if anything.
 * @param all The thread's whole KV scope.
 */
export function threadStateOf(
  agent: string,
  record: ThreadRecord | undefined,
  all: Record<string, unknown>,
): ThreadState {
  return {
    status: record?.status ?? "idle",
    turn: record?.turn ?? 0,
    summary: record?.summary,
    usage: record?.usage ?? { input: 0, output: 0 },
    lastRun: all[lastRunRecordKey(agent)] as LastRun | undefined,
    keys: Object.fromEntries(
      Object.entries(all).filter(([name]) => {
        return !name.startsWith("__");
      }),
    ),
  };
}

/**
 * Sends a message to a thread and gives the call to wait on its result. It
 * throws outside a function. It opens a private inbox on the result before the send, both in
 * one tick, so a message nobody awaits is still sent. `extra` is what `start()`
 * adds: fields of `from` for the receiver, and the sessions of the thread.
 * @param client Inngest client.
 * @param agent The agent, as `"appId/functionId"`.
 * @param key Thread key.
 * @param content What to say.
 * @param extra Fields of `from`, the sessions, and what the message carries
 * under `"::agents"` (made for the message's ID), a `start()` adds.
 */
export function sendMessage<TOutput = unknown>(
  client: Inngest.Any,
  agent: string,
  key: string,
  content: Json,
  extra: {
    from?: object;
    sessions?: Record<string, string>;
    agents?: (id: string) => object;
  } = {},
): MessageCall<TOutput> {
  const meta = { sessions: extra.sessions ?? threadSessions(key) };
  const execution = stepContext();

  if (!execution) {
    throw new Error(
      "message() must be called inside an Inngest function. From a route or an API handler, send the agent's trigger event instead.",
    );
  }

  const n = nextCount(execution.instance, "message");
  const id = `msg:${execution.ctx.runId}.${n}`;
  // A message from the thread that started an unattached child keeps the
  // child's grant alive for another 7 days.
  const self = execution.agent;
  const renew =
    extra.agents === undefined &&
    self?.ref &&
    (relationOf(client, self.thread, key)?.relation === "child" ||
      hasStarted(execution.instance, key))
      ? renewalFor(
          client,
          key,
          self.thread,
          Math.floor(Date.now() / 1000) + unattachedGrantSeconds,
        )
      : undefined;
  const event = agentMessage.create(
    {
      agent,
      thread: key,
      content,
      from: { ...senderOf(execution), ...extra.from },
      ...(extra.agents && { "::agents": extra.agents(id) }),
      ...(renew && { "::agents": { renew } }),
    } satisfies AgentMessageData,
    { meta, id },
  );

  // Opened before the message is sent, so a result that comes quickly is
  // not missed. It ends with the sender's run.
  const answers = step.subscribe(id, {
    event: agentMessageResultEvent,
    if: `async.data.id == ${JSON.stringify(id)}`,
  });
  // Both ops are issued in this tick, the open first, so a message that
  // is never awaited is still sent.
  const opened = inboxOpenedPromise(answers);
  const sent = step.sendEvent(`${id}:send`, event);
  const ready = Promise.all([opened, sent]);
  const handle: RunHandle<TOutput> = {
    async result(options) {
      await ready;

      const got =
        options?.timeout === undefined
          ? await answers.next()
          : await answers.next({ timeout: options.timeout });

      if (got === null || got === undefined) {
        throw new AgentTimeoutError(`${agent} (thread ${key})`);
      }

      const data = got.data as AgentMessageResultData;

      if (data.status === "failed") {
        throw new Error(data.error);
      }

      if (data.status === "stopped") {
        throw new AgentStoppedError(agent, data.run_id);
      }

      return data.output as TOutput;
    },
  };
  // The call is done when the message is sent: the open and the send are both
  // issued above, so one that is never awaited is still sent, and one that is
  // awaited does not run in parallel with the steps after it. A failure to send
  // reaches whoever awaits it.
  const called = ready.then(() => {
    return handle;
  });

  called.catch(noop);

  return Object.assign(called, { result: handle.result });
}

/**
 * The handle of a thread.
 * @param client Inngest client.
 * @param agent The agent, as `"appId/functionId"`.
 * @param key Thread key, the thread's address.
 */
export function threadHandle<TOutput = unknown>(
  client: Inngest.Any,
  agent: string,
  key: string,
): ThreadHandle<TOutput> {
  const meta = { sessions: threadSessions(key) };

  const handle: ThreadHandle<TOutput> = {
    key,
    message(content) {
      return sendMessage<TOutput>(client, agent, key, content);
    },
    async ask(question, options) {
      const execution = stepContext();

      if (!execution) {
        throw new Error("ask() must be called inside an Inngest function");
      }

      const n = nextCount(execution.instance, "ask");
      const id = `ask:${execution.ctx.runId}.${n}`;

      // Opened before the question is sent, so an answer that comes quickly is
      // not missed. It ends with this call, whichever way it ends.
      await using answers = step.subscribe(id, {
        event: agentAnswerEvent,
        if: `async.data.re == ${JSON.stringify(id)}`,
      });

      await inboxOpenedPromise(answers);
      await step.sendEvent(
        `${id}:send`,
        agentQuestion.create(
          {
            agent,
            thread: key,
            id,
            text: question,
            from: senderOf(execution),
          },
          { meta },
        ),
      );

      const answer = await answers.next({ timeout: options?.timeout ?? "1h" });

      // The first answer is the one: this inbox closes with the call, so a
      // second or late answer never reaches anyone.
      const data = answer?.data as AgentAnswerData | undefined;

      return data?.outcome === "answered" ? data.text : null;
    },
    async stop() {
      // The live run is the one the thread record names. A thread with no
      // record, or whose record says no run is live, has nothing to cancel.
      const record = (await threadKv(client, key).get(
        threadRecordKey(agent),
      )) as ThreadRecord | undefined;

      if (
        !record?.runId ||
        (record.status !== "running" && record.status !== "waiting")
      ) {
        return;
      }

      const res = await (
        client as unknown as { inngestApi: InngestApi }
      ).inngestApi.cancelRun(record.runId);

      // The record said the run was live: a run that has just ended is a 404,
      // and it is stopped.
      if (!res.ok && res.error?.status !== 404) {
        throw new Error(res.error?.error ?? "Could not cancel the run.");
      }
    },
  };

  // The agent's address rides on the handle, so a report can be routed to it.
  return Object.assign(handle, {
    [handleAddressKey]: { agent, thread: key },
  });
}
