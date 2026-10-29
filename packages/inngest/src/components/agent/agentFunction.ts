/**
 * @module
 * EXPERIMENTAL: the agent function, an Inngest function whose body owns its
 * loop and reads a durable inbox. It adds what a plain function lacks for a
 * conversation that spans runs:
 *
 * - a singleton per thread, so there is never more than one live run per thread;
 * - `inbox`, a `step.subscribe()` of the thread's messages, whose first message
 *   is the event that started the run;
 * - `control`, which spreads into `agent.loop()` so a running turn takes
 *   steering messages and a stop request.
 *
 * The inbox closes when the body returns. Messages it saved but the body never
 * read are discarded, and a message that arrives after that, while the thread's
 * singleton is still in effect, is dropped: it neither starts a new run nor
 * reaches the finished one. The gap is small (the time between the body
 * returning and the run ending), and nothing is re-sent at run end.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { asyncDispose } from "../../helpers/asyncDispose.ts";
import { internalEvents } from "../../helpers/consts.ts";
import type { Logger } from "../../middleware/logger.ts";
import type {
  ApplyAllMiddlewareCtxExtensions,
  ApplyAllMiddlewareGroupExtensions,
  ApplyAllMiddlewareStepExtensions,
} from "../../types.ts";
import { createDefer } from "../DeferredFunction.ts";
import {
  type AgentBridge,
  getAsyncCtxSync,
  runWithAsyncCtx,
} from "../execution/als.ts";
import {
  type GetFunctionInput,
  type Inngest,
  internalLoggerSymbol,
} from "../Inngest.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import { step } from "../InngestStepTools.ts";
import type { Middleware } from "../middleware/middleware.ts";
import type { SandboxTool, SandboxTools } from "../sandbox/tools.ts";
import type { EventTypeWithAnySchema } from "../triggers/triggers.ts";
import { toAsync } from "./cel.ts";
import {
  type Channel,
  createReporter,
  parseWithAsync,
  type ReportConfigValue,
  type Reporter,
} from "./channels.ts";
import type { AgentPrice } from "./cost.ts";
import {
  type ConfigValue,
  type LazySandbox,
  openSandboxes,
  resolveConfigValue,
  resolveSandboxes,
  type SandboxesConfig,
  type SandboxToolNames,
  type SandboxToolsOf,
  sandboxTools,
  stepSandboxes,
} from "./defs.ts";
import { agentMessage } from "./events.ts";
import {
  createInboxTools,
  type InboxToolInbox,
  type InboxToolsConfig,
  type InboxToolsOf,
} from "./inboxTools.ts";
import { type Kv, type KvSource, kvFrom } from "./kv.ts";
import {
  type AgentLimits,
  budgetReason,
  narrowInherited,
  narrowLimits,
  readInheritedLimits,
  registerLimits,
} from "./limits.ts";
import type { AgentTurn } from "./loop.ts";
import {
  type AgentRecovery,
  failureText,
  fingerprint,
  finishedOf,
  type LastRun,
  type RunFailure,
  summarize,
  turnInFlight,
} from "./recovery.ts";
import { type AgentScores, createAgentScores } from "./scores.ts";
import type { SkillsRuntime } from "./skills.ts";
import {
  type EventMessage,
  eventNameOf,
  type InboxMessage,
  type NextOptions,
  type Subscription,
  type View,
  withIs,
} from "./subscribe.ts";
import {
  agentMessageEvent,
  getThread,
  type ThreadHandle,
  type ThreadMessage,
  type ThreadRequests,
  type TriggerEvent,
  threadSessions,
} from "./thread.ts";
import { listThreads, type ThreadList } from "./threadList.ts";
import {
  cleanupThreadSandbox,
  type ThreadSandboxCleanup,
  threadSandboxOwner,
} from "./threadSandboxes.ts";
import {
  markThreadIdle,
  readLastRun,
  recordEnd,
  runScore,
  threadBusyFor,
  threadRecorder,
} from "./threadState.ts";
import {
  type CompiledTrigger,
  compileTriggers,
  dataProblem,
  messageOf,
  schemaProblem,
  singletonKey,
  type ThreadKeyConfig,
  type ThreadTriggerEvent,
  type ThreadTriggers,
} from "./threadTrigger.ts";

/**
 * The options of a plain Inngest function that an agent takes as they are.
 * The agent owns `triggers` (see `on`) and `singleton` (one live run per
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
   * A longer description of the function, shown in the Inngest UI.
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
const functionOptions = (
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

/**
 * The config of an agent: its ID, what starts it, and what it may use.
 * `TOn` is the type of `on`, `TEvent` the events of its triggers, and
 * `TRequest` and `TReply` what other threads ask it and what it answers.
 */
export interface AgentFunctionConfig<
  TOn = ThreadTriggers,
  TEvent = TriggerEvent,
  TRequest = unknown,
  TReply = unknown,
  TSandboxes extends SandboxToolNames = SandboxToolNames,
  TMiddleware extends Middleware.Class[] | undefined =
    | Middleware.Class[]
    | undefined,
  TInboxTools extends InboxToolsConfig | undefined =
    | InboxToolsConfig
    | undefined,
> extends ThreadKeyConfig<TOn>,
    AgentFunctionOptions<TMiddleware> {
  /**
   * The function ID. The agent is addressed as `"<appId>/<id>"`.
   */
  id: string;

  /**
   * KV store for thread state, or a function that returns one, called at each
   * use (so a Worker can build it from the bindings of the current request).
   * Default: the `store` option of
   * `createAgents(client, { store })`, else Redis at `INNGEST_EXPERIMENTAL_KV_URL`.
   */
  kv?: KvSource;

  /**
   * The types of the requests other threads send this agent with
   * `handle.request()`: schemas for what they ask and what you reply. They
   * type `payload` of a `"request"` message, `message.reply()`, and
   * `request()` on the handle from `agent.thread()`, which also checks its
   * payload against `request`. `reply()` checks its data against `reply`.
   */
  requests?: ThreadRequests<TRequest, TReply>;

  /**
   * Runs once for every message that reaches this thread while a run of it is
   * busy (a turn is in flight), as soon as the message is saved, so the agent
   * can acknowledge it on its channel (a reaction, a line saying it will be
   * folded in). It runs in a function of its own, `<id>-arrival`, served with
   * the agent by `agents.functions()`, so it does not wait for the turn and
   * does not touch the run. It does not run for the message that started the
   * run, or for a thread that is waiting for its next message (the run reads
   * that message at once). What counts is what the thread was doing when the
   * message arrived. The edges are not exact: a message in the instant before a
   * run records its first turn is not acknowledged, and one that arrives after
   * the body returned but before the run is cleaned up may be. A `step` is
   * given: use it for the posts.
   */
  onArrival?: (context: AgentArrivalContext<TEvent>) => Promise<void> | void;

  /**
   * Event sources that reach a live run of the thread they map to and never
   * start one, as if the run had called `inbox.listen()` for each when it began.
   * `on` still starts and wakes runs. Each source maps its own events to the
   * thread key with its `thread` expression.
   */
  inbox?: readonly InboxSource[];

  /**
   * Lets the model listen for events while it works: the body gets
   * `inboxTools` (`inbox_listen`, `inbox_wait`, `inbox_read`, `inbox_stop`) to
   * pass to `agent.loop()`, and to `sandbox.tools.code({ tools })` so `run_code`
   * scripts use the same inbox. Off unless set. The model can only listen to the
   * sources listed here, each tied to this thread by its own `thread`; its
   * `if` can only narrow. A message that arrives while the model works is
   * folded into its next turn by `control.steer()` when `foldMessages` allows.
   */
  inboxTools?: TInboxTools;

  /**
   * Which messages that arrive during a turn `control.steer()` (and so
   * `agent.loop()` inside this agent) folds into the turn at the next model
   * call. `"steer"` (default): only messages of kind `"steer"`; the rest wait
   * for their own turn. `"all"`: user messages too, as steering lines; requests
   * and stops keep their meaning. A folded message is consumed: `next()` does
   * not return it again.
   */
  foldMessages?: "steer" | "all";

  /**
   * The sandboxes this agent may use, by name: definitions made with
   * `sandbox()`, or `{ sandbox, start }`. A sandbox is created by the first
   * tool call that needs it (`start: "lazy"`, the default), or as soon as the
   * run begins (`"eager"`). Either the object or a `start` may be a function
   * of `{ event }`; it re-runs on every replay, so it must be pure. A sandbox
   * belongs to the thread: it is restored from the thread's newest snapshot
   * when first used and snapshotted when the run ends, whichever way, then
   * destroyed. Only files survive between runs.
   */
  sandboxes?: SandboxesConfig<AgentConfigContext<TEvent>, TSandboxes>;

  /**
   * The destinations of progress and asks, by name: channels made with
   * `defineChannel()` or a helper such as `slack.channel(event)`. The object
   * may be a function of `{ event }`, so a channel can be chosen from the
   * trigger; it re-runs on every replay, so it must be pure.
   */
  channels?: ConfigValue<Record<string, Channel>, AgentConfigContext>;

  /**
   * Where `report()` posts when it is not told: a channel name, a channel,
   * or a list of them. Default: the channel named `main`, if there is one.
   * May be a function of `{ event }`.
   */
  report?: ReportConfigValue<AgentConfigContext>;

  /**
   * What this agent may start and spend: `depth` (default 1, so it may start
   * sub-agents and they may not), `spawn`, `mayCall` and `budget`. Sub-agents
   * inherit the limits narrowed. `agent.invoke()` refuses a call the limits
   * do not allow, but only `agent.invoke()`: a raw `step.invoke` or
   * `sendEvent` to another agent bypasses them. `budget` is not automatic:
   * spread `control` into `agent.loop()`, or that loop runs unbudgeted.
   */
  limits?: AgentLimits;

  /**
   * Whether the agent scores itself. Default: `true`. The loop scores each
   * model and tool step (see `agent.loop()`), `report()` scores how long
   * the first post and each gap between posts took, and a stop request sets
   * `agent.stopped` on the step that records it. Every score rides on a
   * step that already runs, so none adds a step. `false` turns those off;
   * `scores.score()` in the body still works.
   */
  scores?: boolean;

  /**
   * What the agent does about a run that fails unexpectedly. Off by default.
   * `true` or an object posts the failure to the agent's channels (`report`)
   * and resends the turn that was in flight, so a fresh run takes it up; a
   * turn that fails twice with the same error is not resent, and the failure
   * is reported as stuck. Only the message `inbox.next()` delivered last is
   * resent: messages that arrived during the failed turn and were not read
   * stay with the failed run. A cancelled run (a stop now, a `cancelOn` event
   * or a `timeouts.finish` limit) is a choice, not a failure: it is neither
   * reported nor resumed, and a completed run is neither. How every run ended
   * is kept either way: see `previousRun` and `thread.state().lastRun`.
   */
  recovery?: boolean | AgentRecovery;
}

/**
 * What a config function receives.
 */
export interface AgentConfigContext<TEvent = TriggerEvent> {
  event: { name: string; data: ThreadMessage<TEvent> };
}

/**
 * An event source for an agent's inbox. Its events reach the run of the thread
 * they map to while it is live, and never start one. `thread` is an expression
 * over `event` that gives the thread key; `if` is an expression over
 * `event`. At least one is required.
 */
export type InboxSource = {
  /**
   * The event: a name or an `eventType()`.
   */
  event: string | EventTypeWithAnySchema<string>;

  /**
   * The text the message carries for the model when it is folded into a turn.
   * Default: the event's name and data as JSON.
   */
  message?: (event: { name: string; data: unknown }) => string;
} & ({ thread: string; if?: string } | { if: string; thread?: string });

/**
 * What `listen()` takes beside a bare event: the filter that ties it to the
 * thread.
 */
export type InboxListenOptions =
  | { thread: string; if?: string }
  | { if: string; thread?: string };

/**
 * A source added to the inbox mid-run.
 */
export interface ThreadListener extends AsyncDisposable {
  /**
   * Stops listening. Messages already saved stay in the inbox.
   */
  stop(): Promise<void>;
}

/**
 * What `onArrival` is given.
 */
export interface AgentArrivalContext<TEvent = TriggerEvent> {
  /**
   * The message that arrived.
   */
  message: ThreadMessage<TEvent>;

  /**
   * The thread it reached.
   */
  thread: string;

  /**
   * The agent's address.
   */
  ref: string;

  /**
   * The event that carried the message.
   */
  event: { id?: string; name: string; data: unknown };

  /**
   * The function's step tools, so each post is a durable step.
   */
  step: typeof step;

  /**
   * The function's logger.
   */
  logger: Logger;
}

/**
 * The fields the agent adds to the function context in its body. See
 * `AgentBodyContext`.
 */
export interface AgentBodyFields<
  TEvent = TriggerEvent,
  TRequest = unknown,
  TReply = unknown,
  TSandboxes extends SandboxToolNames = SandboxToolNames,
  TInboxTools extends InboxToolsConfig | undefined =
    | InboxToolsConfig
    | undefined,
> {
  /**
   * The event that started the run. Its `data` is the thread message, and
   * `data.event` is the trigger event, typed from `on`.
   */
  event: { name: string; data: ThreadMessage<TEvent, TRequest> };

  /**
   * The event of `on` that started this run, as it came (`id`, `name`,
   * `data`), typed from `on`: narrow it by `name`. It is `undefined` when a
   * plain thread message started the run (`thread.send()`, a reply in a
   * thread), because there is no trigger event then. A run that recovery
   * resumed keeps the trigger event of the run that failed. For a cron it is
   * the tick (`{ cron }`), for `invoke()` the invoke event with the caller's
   * input as `data`, without what the SDK adds for the invoked agent.
   */
  trigger: TEvent | undefined;

  /**
   * The handle of the thread this run belongs to.
   */
  thread: ThreadHandle<TRequest, TReply>;

  /**
   * The agent's sandboxes, by name. Nothing is created until a call needs it,
   * except `start: "eager"` ones, which are already being created.
   */
  sandboxes: { [K in keyof TSandboxes & string]: LazySandbox };

  /**
   * Every sandbox's tools, named `<sandbox>_<tool>` (`work_run`). Spread into
   * the `tools` of `agent.loop()`.
   */
  sandboxTools: SandboxToolsOf<TSandboxes>;

  /**
   * The model's inbox tools: `inbox_listen`, `inbox_wait`, `inbox_read` and
   * `inbox_stop`, all of them when the config has `inboxTools` and none
   * without it.
   */
  inboxTools: InboxToolsOf<TInboxTools>;

  /**
   * The agent's channels, by name, as the config resolved them for this run.
   */
  channels: Record<string, Channel>;

  /**
   * Posts progress to the agent's channels. See `Reporter`.
   */
  report: Reporter;

  /**
   * Your own scores, next to the ones the framework writes. See
   * `AgentScores`.
   */
  scores: AgentScores;

  /**
   * Messages sent to the thread, one per delivery, in order. The first is the
   * event that started the run (`seq` 0).
   */
  inbox: ThreadInbox<TEvent, TRequest, TReply>;

  /**
   * How the last run of this thread that ended, ended: `completed`,
   * `failed` (with the error and what recovery did) or `cancelled`. Use it
   * to tell the person what happened to the run before this one. It is
   * `undefined` for a thread that no run has ended on yet, and it stays the
   * same until this run ends, so decide for yourself when it has been said.
   */
  previousRun: LastRun | undefined;

  /**
   * How many times this run has continued in another process since it began:
   * a restart, a deploy, or another instance picking the run up. It counts
   * at the run's state writes, which happen as messages arrive and turns
   * end, and is the same on every replay at the same point of the body.
   * Show a line when it grows: `if (restarts > shown) { ... }`.
   */
  readonly restarts: number;

  /**
   * Spread into `agent.loop()`: `steer` folds steering messages that arrived
   * during a turn into the next model call, and `stop` ends the loop when a
   * stop message arrived. Messages that start the next turn stay in the inbox.
   * `onTurn` records the turn, the usage and a summary for
   * `thread.state()`: if you pass your own `onTurn`, put `...control` first
   * and call `control.onTurn(turn)` from yours.
   */
  control: {
    steer: () => Promise<string[]>;
    stop: () => Promise<boolean>;
    onTurn: (turn: AgentTurn) => Promise<void>;
    budget: () => string | undefined;
    scores: boolean;

    /**
     * The agent's `limits.price`, if it has one, so that the loop prices each
     * model call for `limits.budget.usd`.
     */
    price?: AgentPrice;
  };
}

/**
 * Omit over a union, keeping its members apart.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * What a thread message adds to the event it was made from: its kind and what
 * goes with the kind (`content` for the model, a request's `payload` and
 * `replyTo`).
 */
export type ThreadMessageFields<TRequest = unknown> = DistributiveOmit<
  ThreadMessage<never, TRequest>,
  "event" | keyof InboxMessage | "reply"
>;

/**
 * The event a message is, flat like the `trigger` of the body: `name`, `data`
 * and the rest of the event, typed from `on` when the event is one of its
 * triggers.
 */
type ThreadMessageEvent<TEvent, TRequest> =
  | (TEvent extends { name: infer TName extends string; data: infer TData }
      ? InboxMessage<TData, TName>
      : never)
  | InboxMessage<ThreadMessage<TEvent, TRequest>, "agent/message">;

/**
 * A message of the thread's inbox. It is the event it was made from, flat like
 * `trigger` (`id`, `name`, `data`, `ts` and its place `seq`), with the fields
 * of a thread message beside it (`kind`, `content`, ...). The event is the
 * trigger event for a message made from a trigger (narrow it by `name`), and
 * `agent/message` for a plain thread message (`thread.send()`, a reply, a
 * request), whose `data` is the message itself. A message from an inbox source
 * is its event too, under the event's own `name`; it is not in the type of
 * `on`, so read it typed through `inbox.of(type)`. A `"request"` message from another thread's
 * `handle.request()` is answered with `reply()`.
 */
export type ThreadInboxMessage<
  TEvent = TriggerEvent,
  TRequest = unknown,
  TReply = unknown,
> = ThreadMessageEvent<TEvent, TRequest> &
  ThreadMessageFields<TRequest> & {
    /**
     * Answers a request: sends `data` to the thread that asked. It is a step,
     * and it throws for a message that is not a `"request"`.
     */
    reply(
      /**
       * The reply.
       */
      data: TReply,
    ): Promise<void>;
  };

/**
 * The thread's inbox: a subscription whose messages can reply.
 */
export interface ThreadInbox<
  TEvent = TriggerEvent,
  TRequest = unknown,
  TReply = unknown,
> extends Omit<
      Subscription<ThreadMessage<TEvent, TRequest>>,
      | "next"
      | "current"
      | "unread"
      | "of"
      | "listen"
      | "putBack"
      | "close"
      | typeof Symbol.asyncIterator
    >,
    AsyncIterable<ThreadInboxMessage<TEvent, TRequest, TReply>> {
  /**
   * Waits for the next message, or returns `null` once the inbox is closed
   * and every saved message has been read.
   */
  next(): Promise<ThreadInboxMessage<TEvent, TRequest, TReply> | null>;

  /**
   * Waits for the next message for at most `timeout`. The wait is durable,
   * like `step.waitForEvent()`'s: it does not hold the run's process, and a
   * message that arrives after the timeout is read by the next call. Messages
   * the inbox skips (a stop, or one that breaks its schema) start a new wait
   * with the same timeout.
   *
   * It resolves to `undefined` when the timeout expires, and to `null` when
   * the inbox is closed and every saved message has been read, so check
   * `=== undefined` to tell an idle wait from the end.
   *
   * @example
   * ```ts
   * const message = await inbox.next({ timeout: "10m" });
   *
   * if (message === undefined) {
   *   // Nothing arrived in ten minutes: do periodic work, then wait again.
   * } else if (message === null) {
   *   // The inbox is closed and drained.
   * }
   * ```
   */
  next(
    options: NextOptions,
  ): Promise<ThreadInboxMessage<TEvent, TRequest, TReply> | null | undefined>;

  /**
   * Every message the inbox has saved so far, read or not, stops included (not
   * the event that started the run, which is only the first `next()`), in
   * order. It moves no cursor and has no read state, and never waits. One step
   * records how many there were, so a replay returns the same ones. To take what
   * arrived since you last looked, read with `next({ timeout: 0 })` until it
   * returns `undefined`.
   */
  current(): Promise<ThreadInboxMessage<TEvent, TRequest, TReply>[]>;

  /**
   * Takes every message after this reader's cursor, in order, without waiting,
   * and advances the cursor past them: `next()` does not return them again. Stops
   * are included, so a loop of your own can honor them. Each message is a step,
   * so a replay takes the same messages. This is what `control.steer()` is made
   * of; use it to fold in what arrived at the safe point of a loop that is not
   * `agent.loop()`.
   */
  unread(): Promise<ThreadInboxMessage<TEvent, TRequest, TReply>[]>;

  /**
   * A view of the messages of one event: it reads them with a cursor of its
   * own and hides nothing from the inbox or other views. Messages are typed by
   * the event type, and ones that break its schema are dropped, as in the
   * inbox.
   * @param type The event name or event type.
   */
  of<TType extends InboxSource["event"]>(
    type: TType,
  ): View<EventMessage<TType>>;

  /**
   * Adds an event source to the inbox mid-run: its events reach this thread's
   * run from now on, never start a run, and join the inbox in order. It is one
   * step. A source needs a `thread` or an `if` that ties it to this thread.
   * @param source The event and how it maps to the thread.
   */
  listen(source: InboxSource): Promise<ThreadListener>;
  listen(
    source: InboxSource["event"],
    options: InboxListenOptions,
  ): Promise<ThreadListener>;

  /**
   * Puts messages back, in order, so the next reads return them before
   * anything newer. Use it for messages you took with `unread()` that are not
   * yours to handle yet.
   * @param messages Messages that came from this inbox.
   */
  putBack(messages: ThreadInboxMessage<TEvent, TRequest, TReply>[]): void;

  /**
   * Ends the subscription. See `Subscription.close()`: it only ends the
   * subscription, and a message that arrives afterwards is dropped.
   * @returns The messages that were saved but not read.
   */
  close(): Promise<ThreadInboxMessage<TEvent, TRequest, TReply>[]>;
}

/**
 * What the inbox tools need of the thread's inbox. They read through views of
 * the events they listen to, which have cursors of their own, so a stop, a
 * user message or a request is never taken from the loop.
 */
const toolInbox = (inbox: ThreadInbox): InboxToolInbox => {
  return {
    listen: (event, options) => {
      return inbox.listen(event, options);
    },
    of: (event) => {
      return inbox.of(event);
    },
  };
};

/**
 * The function context an agent's body shares with a plain function, typed
 * from the client's middleware: `step`, `group`, `defer`, `runId`, `logger`,
 * `attempt` and the rest, without `event` and `events`, which the agent
 * replaces.
 */
export type AgentFunctionInput<
  TClient extends Inngest.Any = Inngest.Any,
  TMiddleware extends Middleware.Class[] | undefined = undefined,
> = Omit<GetFunctionInput<TClient>, "event" | "events" | "step" | "group"> &
  ApplyAllMiddlewareCtxExtensions<TMiddleware> & {
    step: GetFunctionInput<TClient>["step"] &
      ApplyAllMiddlewareStepExtensions<TMiddleware>;
    group: GetFunctionInput<TClient>["group"] &
      ApplyAllMiddlewareGroupExtensions<TMiddleware>;
  };

/**
 * What the body gets: the function context the client's middleware gives a
 * plain function (`step` with `step.sandbox` when the client has the sandbox
 * middleware, `group`, `defer`, `runId`, `logger`, `attempt` and the rest)
 * with the agent's own fields beside it. `event` is the agent's, not the
 * function's: its `data` is the thread message, and `data.event` is the
 * trigger event. There is no `events`, because an agent never runs on a
 * batch.
 */
export type AgentBodyContext<
  TEvent = TriggerEvent,
  TRequest = unknown,
  TReply = unknown,
  TSandboxes extends SandboxToolNames = SandboxToolNames,
  TClient extends Inngest.Any = Inngest.Any,
  TMiddleware extends Middleware.Class[] | undefined = undefined,
  TInboxTools extends InboxToolsConfig | undefined =
    | InboxToolsConfig
    | undefined,
> = AgentFunctionInput<TClient, TMiddleware> &
  AgentBodyFields<TEvent, TRequest, TReply, TSandboxes, TInboxTools>;

/**
 * The body of an agent. `TEvent` is the events of its `on` triggers and
 * `TOutput` what it returns.
 */
export type AgentBody<
  TEvent = TriggerEvent,
  TOutput = unknown,
  TRequest = unknown,
  TReply = unknown,
  TSandboxes extends SandboxToolNames = SandboxToolNames,
  TClient extends Inngest.Any = Inngest.Any,
  TMiddleware extends Middleware.Class[] | undefined = undefined,
  TInboxTools extends InboxToolsConfig | undefined =
    | InboxToolsConfig
    | undefined,
> = (
  context: AgentBodyContext<
    TEvent,
    TRequest,
    TReply,
    TSandboxes,
    TClient,
    TMiddleware,
    TInboxTools
  >,
) => Promise<TOutput>;

/**
 * An agent made by `createAgents().agent()`: the functions to serve, its
 * address, and handles to its threads. `TInput` and `TOutput` type
 * `agent.invoke(thisAgent, input)`.
 */
export interface AgentFunction<
  TInput = Record<string, unknown>,
  TOutput = unknown,
  TRequest = unknown,
  TReply = unknown,
> {
  /**
   * Types only: what `agent.invoke(thisAgent, input)` takes and returns. The
   * input is the data of the agent's `invoke()` trigger; the output is what
   * its body returns.
   */
  readonly "~types"?: { input: TInput; output: TOutput };

  /**
   * The function that runs the body.
   */
  fn: InngestFunction.Any;

  /**
   * Runs after every run of `fn` ends, whichever way, and removes the run's
   * run-scoped KV keys.
   */
  cleanup: InngestFunction.Any;

  /**
   * The function that runs `onArrival` for every message that reaches a busy
   * thread. Present only when the config has an `onArrival`.
   */
  arrival?: InngestFunction.Any;

  /**
   * Runs when the executor reports that a run of `fn` ended, whichever way,
   * and writes the thread's `lastRun`. With `recovery` on, it also reports a
   * failure and resends the turn.
   */
  finished: InngestFunction.Any;

  /**
   * The agent's address, `"<appId>/<functionId>"`.
   */
  ref: string;

  /**
   * The handle of a thread of this agent.
   */
  thread(
    /**
     * Thread key.
     */
    key: string,
    /**
     * Session the thread belongs to. Default: the thread key.
     */
    session?: string,
  ): ThreadHandle<TRequest, TReply>;

  /**
   * The agent's threads.
   */
  threads: ThreadList;
}

/**
 * The messages whose drop was already logged, so a replay does not log it
 * again.
 */
const warned = new Set<string>();

/**
 * The trigger event as the body sees it. An invoke event carries what the SDK
 * tells the invoked agent in `data._agent`; that is not the caller's input.
 */
const triggerOf = (event: TriggerEvent | undefined) => {
  const data = event?.data as Record<string, unknown> | undefined;

  if (!event || !data || !("_agent" in data)) {
    return event;
  }

  const { _agent: _told, ...input } = data;

  return { ...event, data: input };
};

/**
 * The thread's view of its subscription: a message is the event it was made
 * from, flat, with the thread message's fields beside it, and stop messages are
 * skipped, because while the agent waits for its
 * next message there is nothing to stop.
 */
function threadInbox(
  /**
   * The subscription to the thread's events.
   */
  inbox: Subscription<unknown>,
  toMessage: (raw: RawEvent) => ThreadMessage,
  problemOf: (raw: RawEvent, started: boolean) => Promise<string | undefined>,

  /**
   * Inngest client, to send replies.
   */
  client: Inngest.Any,

  /**
   * Records the thread's status: `waiting()` before the agent waits for a message after the first, `running()` once one is delivered.
   */
  recorder: Pick<
    ReturnType<typeof threadRecorder>,
    "waiting" | "running" | "resumed"
  >,
  log: { warn: (message: string) => void },
  runId: string,
  listenTo: (
    source: InboxSource["event"] | InboxSource,
    options?: InboxListenOptions,
  ) => Promise<ThreadListener>,
  replySchema?: ThreadRequests["reply"],
): {
  inbox: ThreadInbox;
} {
  // The event each message was made from, to put it back as it came.
  const raws = new WeakMap<object, InboxMessage>();

  function unwrap(message: InboxMessage | null): ThreadInboxMessage | null {
    if (!message) {
      return null;
    }

    const data = toMessage(message);

    // The event stays as it came; the thread message adds its fields beside it.
    // A thread message that was made from a trigger event (one that recovery
    // sends again) is that event: it keeps its name, id and data.
    const { event: made, ...fields } = data as ThreadMessage & {
      event?: { id?: string; name: string; data: unknown };
    };
    // The event's own fields come last, so a field a thread message may one day
    // have can never overwrite them (the type tests fail if a thread message
    // field shares a name with one of the event's).
    const unwrapped = withIs({
      ...fields,
      ...message,
      ...(made
        ? { id: made.id ?? message.id, name: made.name, data: made.data }
        : {}),
      async reply(answer: unknown) {
        if (data.kind !== "request" || !data.replyTo) {
          throw new Error(
            "This message is not a request: only a request has a reply.",
          );
        }

        const checked = replySchema
          ? await parseWithAsync(replySchema, answer, "message.reply() data")
          : answer;

        await step.run(`reply:${message.seq}`, async () => {
          await client.sendSignal({
            signal: data.replyTo,
            data: checked,
          });
        });
      },
    });
    raws.set(unwrapped, message);

    // One cast: the spread above is a plain object, and `ThreadInboxMessage` is
    // a union that depends on the caller's `on` triggers, which the runtime
    // cannot derive.
    return unwrapped as unknown as ThreadInboxMessage;
  }

  function rawOf(message: ThreadInboxMessage): InboxMessage {
    // A message that did not come from `unwrap` is already an event; its type
    // cannot be derived from the `ThreadInboxMessage` union.
    return raws.get(message) ?? (message as unknown as InboxMessage);
  }

  let delivered = 0;

  // An event that breaks its trigger's schema never starts a run in core, so
  // it does not reach a live one either: it is dropped. The event that started
  // the run was checked by core, except for the payload of a request, which
  // core does not see.
  async function skipped(raw: InboxMessage) {
    const problem = await problemOf(raw, raw.seq < 1);
    if (!problem) {
      return false;
    }

    warnOnce(raw, problem);

    return true;
  }

  // The drop is decided again when the run replays, and the handler's logger
  // is quiet while a run replays, so the warning goes to the client's own
  // logger once per message and process.
  function warnOnce(raw: InboxMessage, problem: string) {
    const id = `${runId}:${raw.id || raw.seq}`;
    if (warned.has(id)) {
      return;
    }

    // Forget the oldest drop once there are many, so the set stays small.
    if (warned.size >= 1000) {
      warned.delete(warned.values().next().value as string);
    }

    warned.add(id);
    log.warn(
      `Dropped ${raw.name} from the inbox: it breaks its schema (${problem}).`,
    );
  }

  function next(): Promise<ThreadInboxMessage | null>;
  function next(
    options: NextOptions,
  ): Promise<ThreadInboxMessage | null | undefined>;
  async function next(
    options?: NextOptions,
  ): Promise<ThreadInboxMessage | null | undefined> {
    if (delivered > 0) {
      await recorder.waiting();
    }

    for (;;) {
      const raw = options ? await inbox.next(options) : await inbox.next();
      if (raw === undefined) {
        // The wait expired: the agent goes on working, so it is not waiting.
        if (delivered > 0) {
          await recorder.resumed();
        }

        return undefined;
      }

      if (!raw) {
        return null;
      }

      if (await skipped(raw)) {
        continue;
      }

      const message = unwrap(raw) as ThreadInboxMessage;

      delivered += 1;

      // While the agent waits for its next message there is nothing to stop.
      if (message.kind !== "stop") {
        if (delivered > 1) {
          await recorder.running(
            undefined,
            message.kind === "user" ? { content: message.content } : undefined,
          );
        }

        return message;
      }
    }
  }

  return {
    inbox: {
      next,
      async current() {
        const taken: ThreadInboxMessage[] = [];

        for (const raw of await inbox.current()) {
          if (!(await skipped(raw))) {
            taken.push(unwrap(raw) as ThreadInboxMessage);
          }
        }

        return taken;
      },
      async unread() {
        const taken: ThreadInboxMessage[] = [];

        for (const raw of await inbox.unread()) {
          if (!(await skipped(raw))) {
            taken.push(unwrap(raw) as ThreadInboxMessage);
          }
        }

        return taken;
      },
      of(type) {
        const view = inbox.of(type);
        const clean = async <T extends InboxMessage>(messages: T[]) => {
          const kept: T[] = [];

          for (const raw of messages) {
            if (!(await skipped(raw))) {
              kept.push(raw);
            }
          }

          return kept;
        };
        const mine: View<EventMessage<typeof type>> = {
          next: (async (options?: NextOptions) => {
            for (;;) {
              const raw = options
                ? await view.next(options)
                : await view.next();

              if (!raw) {
                return raw;
              }

              if (!(await skipped(raw))) {
                return raw;
              }
            }
          }) as View<EventMessage<typeof type>>["next"],
          async unread() {
            return clean(await view.unread()) as never;
          },
          async current() {
            return clean(await view.current()) as never;
          },
          [Symbol.asyncIterator]() {
            return {
              async next() {
                const message = await mine.next();

                return message
                  ? { done: false, value: message }
                  : { done: true, value: undefined };
              },
            };
          },
        };

        return mine;
      },
      listen: listenTo as ThreadInbox["listen"],
      putBack(messages) {
        inbox.putBack(messages.map(rawOf));
      },
      async close() {
        const unread = await inbox.close();
        const kept: ThreadInboxMessage[] = [];

        for (const message of unread) {
          if (!(await skipped(message))) {
            kept.push(unwrap(message) as ThreadInboxMessage);
          }
        }

        return kept;
      },
      async [asyncDispose]() {
        await inbox[asyncDispose]();
      },
      [Symbol.asyncIterator]() {
        return {
          async next() {
            const message = await next();
            if (!message) {
              return { done: true, value: undefined };
            }

            return { done: false, value: message };
          },
        };
      },
    },
  };
}

/**
 * An event as the subscription saves it.
 */
interface RawEvent {
  id?: string;
  name: string;
  data: unknown;
  stream?: number;
}

function quote(value: string) {
  return JSON.stringify(value);
}

/**
 * Whether a value is an inbox source object, not a bare event name or type.
 * @param value The first argument of `listen()`.
 */
function isInboxSource(
  value: InboxSource["event"] | InboxSource,
): value is InboxSource {
  return (
    typeof value === "object" &&
    "event" in value &&
    !("schema" in value) &&
    !("create" in value)
  );
}

/**
 * The subscription source of an inbox source: its `if` and `thread`
 * expressions (over `event`) turned into one filter over `async` that also
 * ties it to the thread.
 * @param source The inbox source.
 * @param thread The thread key of the run.
 */
function inboxFilter(source: { if?: string; thread?: string }, thread: string) {
  const conditions = [
    source.if && `(${toAsync(source.if)})`,
    source.thread && `(${toAsync(source.thread)}) == ${quote(thread)}`,
  ].filter((condition): condition is string => {
    return Boolean(condition);
  });

  if (conditions.length === 0) {
    throw new Error("An inbox source needs a `thread` or an `if`.");
  }

  return conditions.join(" && ");
}

/**
 * Defines an agent function. Use `createAgents(client).agent()`.
 */
export function createAgentFunction(
  /**
   * Inngest client.
   */
  client: Inngest.Any,

  /**
   * Function ID and KV store.
   */
  config: AgentFunctionConfig,

  /**
   * Your loop. Read `inbox`, call `agent.loop()` with `control`.
   */
  body: AgentBody,
): AgentFunction {
  const ref = `${client.id}/${config.id}`;
  const triggers = compileTriggers(config.id, config);
  const threadExpression = singletonKey(triggers);

  const store = kvFrom(config.kv);
  const scoring = config.scores ?? true;

  // A dollar budget with no price would count every call as free and never stop.
  if (config.limits?.budget?.usd !== undefined && !config.limits.price) {
    throw new Error(
      `Agent "${config.id}" sets limits.budget.usd without limits.price: add the price of a model call, or the budget would never be spent.`,
    );
  }

  const cleanup = createDefer(
    client,
    { id: `${config.id}-cleanup` },
    async ({ event, step }) => {
      const { runId, thread, sandbox } = event.data as {
        runId: string;
        thread?: string;
        sandbox?: ThreadSandboxCleanup;
      };

      // A sandbox the run created and did not close: save it for the
      // thread's next run and destroy it.
      if (sandbox && thread) {
        await cleanupThreadSandbox({
          client: client as unknown as Parameters<
            typeof cleanupThreadSandbox
          >[0]["client"],
          ref,
          thread,
          runId,
          scope: store.scope("thread", thread),
          sandbox,
          run: (id, fn) => {
            return step.run(id, fn) as ReturnType<typeof fn>;
          },
        });

        return;
      }

      // Each KV call is its own step.
      await store.scope("run", runId).clear();

      if (thread) {
        await markThreadIdle(store, thread, runId);
      }
    },
  );

  const onArrival = config.onArrival;
  const arrival = onArrival
    ? client.createFunction(
        {
          id: `${config.id}-arrival`,
          triggers: [
            {
              event: agentMessageEvent,
              if: `event.data.agent == ${quote(ref)}`,
            },
            ...triggers
              .filter((trigger) => {
                return trigger.listen;
              })
              .map((trigger) => {
                return trigger.fnTrigger;
              }),
          ],
        },
        async ({ event, step: arrivalStep, logger }) => {
          const found = triggers.find((t) => {
            return t.event === event.name;
          });
          const message = found
            ? messageOf(ref, found, event as unknown as ThreadTriggerEvent)
            : (event.data as ThreadMessage);
          // An inbox drops a request that breaks its schema, so it is not
          // acknowledged either.
          if (
            message.kind === "request" &&
            config.requests &&
            (await dataProblem(config.requests.request, message.payload))
          ) {
            return;
          }

          // The KV read is a durable step of its own, so a replay sees the same
          // answer.
          const busy = await threadBusyFor(store, message.thread, event.ts);

          // A thread that is not working is not busy: its run, or the run this
          // message starts, reads the message at once.
          if (!busy) {
            return;
          }

          await onArrival({
            message,
            thread: message.thread,
            ref,
            event: event as unknown as AgentArrivalContext["event"],
            step: arrivalStep as unknown as typeof step,
            logger,
          });
        },
      )
    : undefined;

  const recovery: AgentRecovery | undefined =
    config.recovery === true ? {} : config.recovery || undefined;

  // The executor reports every ending of a run (completed, failed, cancelled)
  // in one `inngest/function.finished` event with the status and the error.
  // A `defer` runs after each ending too, but carries no outcome, and
  // `onFailure` sees failures only.
  const finished = client.createFunction(
    {
      id: `${config.id}-finished`,
      retries: 3,
      // A run reported twice (a batched or invoked run has several finished
      // events) is handled once.
      idempotency: "event.data.run_id",
      triggers: [
        {
          event: "inngest/function.finished",
          if: `event.data.function_id == ${quote(`${client.id}-${config.id}`)}`,
        },
      ],
    },
    async ({ event, step, logger }) => {
      const data = event.data as Record<string, unknown>;
      const start = ((data.events as RawEvent[] | undefined)?.[0] ??
        data.event) as RawEvent;
      const found = triggers.find((t) => {
        return t.event === start.name;
      });
      const message = found
        ? messageOf(ref, found, start as unknown as ThreadTriggerEvent)
        : (start.data as ThreadMessage);
      const ended = finishedOf(data);
      const runId = String(data.run_id);

      // How the run ended is written first and whatever else happens next.
      const { last, record } = await recordEnd(store, message.thread, {
        runId,
        at: event.ts ?? 0,
        finished: ended,
        content: message.kind === "user" ? message.content : undefined,
        turn:
          message.kind === "user" &&
          (message.content !== undefined || message.event !== undefined),
        resume:
          ended.status === "failed" && recovery
            ? recovery.resume !== false && !ended.error?.nonRetriable
            : undefined,
      });
      if (!recovery || ended.status !== "failed") {
        return last;
      }

      // A late report for an older run, after a newer one has ended, is still
      // said; it is not resumed.
      const mine = last?.runId === runId ? last : undefined;
      const reason = ended.error?.message ?? "unknown error";
      const failure: RunFailure = {
        runId,
        thread: message.thread,
        error: mine?.error ?? summarize(reason),
        fingerprint:
          mine?.fingerprint ?? fingerprint(ended.error?.name, reason),
        resuming: mine?.recovery === "resumed",
        repeated: mine?.recovery === "stuck" && recovery.resume !== false,
        superseded:
          record.runId !== undefined &&
          record.runId !== runId &&
          runScore(record.runId) > runScore(runId),
      };
      // A post that fails for good, or a `message` that throws, must not keep
      // the turn from being taken up again.
      try {
        const text = (recovery.message ?? failureText)(failure);

        if (text !== false) {
          const context = {
            event: start as unknown as AgentConfigContext["event"],
          };
          const channels = await resolveConfigValue(
            config.channels ?? {},
            context,
          );
          const report = createReporter(
            channels,
            config.report === undefined
              ? undefined
              : await resolveConfigValue(config.report, context),
            (id, run) => {
              return step.run(id, run);
            },
          );

          await report(text);
        }
      } catch (error) {
        logger.warn(
          { runId, error: String(error).slice(0, 160) },
          "The failure of a run could not be reported",
        );
      }

      if (!failure.resuming) {
        return last;
      }

      const { content } = turnInFlight(
        record,
        runId,
        {
          content: message.kind === "user" ? message.content : undefined,
          turn:
            message.kind === "user" &&
            (message.content !== undefined || message.event !== undefined),
        },
        (a, b) => {
          return runScore(a) < runScore(b);
        },
      );
      const session = found?.session?.key(start as never);

      await step.sendEvent(
        "recover-resend",
        agentMessage.create(
          {
            agent: ref,
            thread: message.thread,
            kind: "user",
            content,
            event: message.event,
          },
          {
            id: `recover-${runId}`,
            meta: { sessions: threadSessions(message.thread, session) },
          },
        ),
      );

      return last;
    },
  );

  const fn = client.createFunction(
    {
      ...functionOptions(config),
      id: config.id,
      triggers: [
        {
          event: agentMessageEvent,
          // A stop message never starts a run, so stopping an idle thread
          // does nothing.
          if: `event.data.agent == ${quote(ref)} && event.data.kind != "stop"`,
        },
        ...triggers.map((trigger) => {
          return trigger.fnTrigger;
        }),
      ],
      singleton: { key: threadExpression, mode: "skip" },
    },
    async (ctx) => {
      const { event, step, defer, runId, logger } = ctx;
      const { events: _events, ...functionContext } = ctx;

      // The thread a run belongs to comes from its trigger: a message names it,
      // any other trigger event gives it by the expression of its trigger.
      const found = triggers.find((t) => {
        return t.event === event.name;
      });
      const data = found
        ? messageOf(ref, found, event as unknown as ThreadTriggerEvent)
        : (event.data as ThreadMessage);
      const session = found?.session?.key(event);

      // Read by `agent.loop()` once the body's inbox exists.
      const bridge: AgentBridge = {};

      // Run-scoped KV keys end with the run, whichever way it ends.
      defer("kv-cleanup", {
        function: cleanup,
        data: { runId, thread: data.thread },
      });

      const thread = getThread(client, ref, data.thread, {
        session,
        kv: store,
        requests: config.requests,
      });

      // The KV scopes of the thread and session come from the trigger, which
      // for an event of `on` does not carry them: the whole run reads them
      // from here.
      async function main() {
        // Writes what `thread.state()` shows. One step per change.
        const recorder = threadRecorder(store, runId, scoring);

        // What a sub-agent inherited is kept on its thread, so a later run that
        // a plain message starts has the same limits.
        const started = await recorder.running(
          readInheritedLimits(
            // An invoked agent is told its limits in the event's own data.
            (
              (found?.event === internalEvents.FunctionInvoked
                ? event.data
                : data) as Record<string, unknown>
            )._agent,
          ),
          data.kind === "user" ? { content: data.content } : null,
        );

        // How the run before this one ended: a key of its own, so it is read
        // apart from the record.
        const previousRun = await readLastRun(store);

        // Limits apply to what `agent.invoke()` starts and to the loop's budget.
        // The usage is the thread's so far, and each turn adds to it.
        const instance = getAsyncCtxSync()?.execution?.instance;

        if (!instance) {
          throw new Error("An agent must run inside an Inngest function");
        }

        const limits = registerLimits(
          instance,
          narrowLimits(config.limits, started.inherited),
          { ...started.usage },
        );

        // Opened first, so the gap in which a message could be missed is the few
        // milliseconds between the run starting and this op.
        // Closed when the run's work is done, whichever way it ends. That only
        // ends the subscription.
        await using subscription = await step.subscribe("inbox", {
          events: [
            {
              event: agentMessageEvent,
              if: `async.data.agent == ${quote(ref)} && async.data.thread == ${quote(data.thread)}`,
            },
            ...triggers
              .filter((trigger) => {
                return trigger.listen;
              })
              .map((trigger) => {
                const own = `(${trigger.thread.asAsync}) == ${quote(data.thread)}`;

                return {
                  event: trigger.event,
                  if: trigger.asyncIf ? `(${trigger.asyncIf}) && ${own}` : own,
                };
              }),
            ...(config.inbox ?? []).map((source) => {
              return {
                event: source.event,
                if: inboxFilter(source, data.thread),
              };
            }),
          ],
        });

        // How each inbox source words its messages for the model and what it
        // checks them against, by the source's stream. The first streams are the
        // agent's own messages and the triggers that reach a live run.
        const sourceWords = new Map<number, InboxSource["message"]>();
        const sourceSchemas = new Map<number, StandardSchemaV1>();
        const firstSource =
          1 +
          triggers.filter((trigger) => {
            return trigger.listen;
          }).length;

        const noteSource = (stream: number, source: InboxSource) => {
          sourceWords.set(stream, source.message);

          const schema =
            typeof source.event === "object" ? source.event.schema : undefined;

          if (schema) {
            sourceSchemas.set(stream, schema as StandardSchemaV1);
          }
        };

        for (const [index, source] of (config.inbox ?? []).entries()) {
          noteSource(firstSource + index, source);
        }

        // Adds a source mid-run: a bare event takes its filter from the options.
        async function listenTo(
          source: InboxSource["event"] | InboxSource,
          options?: InboxListenOptions,
        ): Promise<ThreadListener> {
          const given: InboxSource = isInboxSource(source)
            ? source
            : ({ event: source, ...options } as InboxSource);
          const listener = await subscription.listen({
            event: given.event,
            if: inboxFilter(given, data.thread),
          });

          noteSource(listener.stream, given);

          return listener;
        }
        subscription.putBack([
          withIs({
            seq: 0,
            id: event.id ?? "",
            name: event.name,
            data: event.data,
            ts: event.ts ?? 0,
            user: {},
          }) as InboxMessage,
        ]);

        const bindings = await resolveSandboxes(config.sandboxes, {
          event: event as unknown as AgentConfigContext["event"],
        });
        const opened =
          Object.keys(bindings).length > 0
            ? openSandboxes(
                bindings,
                stepSandboxes(step),
                {
                  event: event as unknown as AgentConfigContext["event"],
                  client: client as unknown as SkillsRuntime["client"],
                  agent: ref,
                  run: (id, fn) => {
                    return step.run(id, fn) as ReturnType<typeof fn>;
                  },
                  sendEvent: (id, payload) => {
                    return step.sendEvent(id, payload);
                  },
                },
                threadSandboxOwner({
                  client: client as unknown as SkillsRuntime["client"],
                  ref,
                  thread: data.thread,
                  runId,
                  scope: store.thread,
                  warn: (data, message) => {
                    logger.warn(data, message);
                  },
                  run: (id, fn) => {
                    return step.run(id, fn) as ReturnType<typeof fn>;
                  },
                  defer: (id, sandbox) => {
                    return defer(id, {
                      function: cleanup,
                      data: { runId, thread: data.thread, sandbox },
                    });
                  },
                }),
              )
            : {};

        const configContext = {
          event: event as unknown as AgentConfigContext["event"],
        };
        const channels = await resolveConfigValue(
          config.channels ?? {},
          configContext,
        );
        const report = createReporter(
          channels,
          config.report === undefined
            ? undefined
            : await resolveConfigValue(config.report, configContext),
          (id, run) => {
            return step.run(id, run);
          },
          scoring ? { since: event.ts } : undefined,
          {
            restarts: () => {
              return recorder.restarts;
            },
            inStep: () => {
              return Boolean(getAsyncCtxSync()?.execution?.executingStep);
            },
            state: {
              get: async (key) => {
                return store.thread.get(key as never) as never;
              },
              set: async (key, value) => {
                await store.thread.set(key as never, value as never);
              },
            },
          },
        );
        const agentScores = createAgentScores(client);

        let stopRequested = false;
        const { inbox } = threadInbox(
          subscription,
          function toMessage(raw) {
            const trigger = triggers.find((t) => {
              return t.event === raw.name;
            });

            if (trigger) {
              return messageOf(
                ref,
                trigger,
                raw as unknown as ThreadTriggerEvent,
              );
            }

            if (raw.name === agentMessageEvent) {
              return raw.data as ThreadMessage;
            }

            // An event of an inbox source is a user message made from it.
            const word = sourceWords.get(raw.stream ?? -1);

            return {
              agent: ref,
              thread: data.thread,
              kind: "user",
              content: word
                ? word(raw)
                : JSON.stringify({ event: raw.name, data: raw.data }),
              event: { id: raw.id, name: raw.name, data: raw.data },
            } as ThreadMessage;
          },
          async function problemOf(raw, started) {
            // A request's payload is checked against `requests`, which core
            // does not know. The asker gets no reply, so it times out: the
            // same as for any event that breaks its schema.
            if (raw.name === agentMessageEvent) {
              const data = raw.data as ThreadMessage;

              return data.kind === "request" && config.requests
                ? dataProblem(config.requests.request, data.payload)
                : undefined;
            }

            // An event of an inbox source is checked against its event type.
            const sourceSchema = sourceSchemas.get(raw.stream ?? -1);

            if (sourceSchema) {
              return dataProblem(sourceSchema, raw.data ?? {});
            }

            if (started) {
              return undefined;
            }

            return schemaProblem(
              triggers.filter((t) => {
                return t.event === raw.name;
              }),
              raw,
            );
          },
          client,
          recorder,
          client[internalLoggerSymbol],
          runId,
          listenTo,
          config.requests?.reply,
        );

        const control = {
          async steer() {
            const lines: string[] = [];
            const waiting: ThreadInboxMessage[] = [];

            // Read everything that has arrived: steering messages and stops
            // apply to the turn that is running; messages for the next turn
            // keep their place in the inbox.
            for (const message of await inbox.unread()) {
              const kind = message.kind;
              if (
                kind === "steer" ||
                (kind === "user" && config.foldMessages === "all")
              ) {
                lines.push(message.content ?? "");
              } else if (kind === "stop") {
                stopRequested = true;
              } else {
                waiting.push(message);
              }
            }
            inbox.putBack(waiting);

            return lines;
          },
          async stop() {
            const requested = stopRequested;
            stopRequested = false;

            if (requested) {
              await recorder.stopped();
            }

            return requested;
          },
          budget() {
            return budgetReason(limits);
          },
          scores: scoring,
          ...(config.limits?.price && { price: config.limits.price }),
          async onTurn(turn: AgentTurn) {
            const next = await recorder.turn(turn);

            limits.used = { ...next.usage };
          },
        };

        // `agent.loop()` steers and stops through the inbox unless it is given
        // its own.
        bridge.control = control;

        // Closes every sandbox. Returns the first failure instead of throwing, so
        // a failed eager start nothing used never replaces the body's own error.
        const closeAll = async () => {
          const closed = await Promise.allSettled(
            Object.values(opened).map((handle) => {
              return handle.close();
            }),
          );

          return closed.find((outcome) => {
            return outcome.status === "rejected";
          });
        };
        let result: unknown;

        try {
          result = await body({
            ...functionContext,
            logger,
            event: { ...event, data } as AgentBodyContext["event"],
            trigger: triggerOf(data.event),
            thread,
            sandboxes: opened,
            sandboxTools: sandboxTools(opened),
            inboxTools: config.inboxTools
              ? createInboxTools(toolInbox(inbox), config.inboxTools)
              : {},
            channels,
            report,
            scores: agentScores,
            inbox,
            previousRun,
            get restarts() {
              return recorder.restarts;
            },
            control,
          });

          // The last thread work is done: end the subscription before the
          // sandboxes close. A second close, from the scope exit, does nothing.
          await inbox.close();
        } catch (error) {
          await closeAll();

          throw error;
        }

        const rejected = await closeAll();

        // The body succeeded, so an eager sandbox nothing used that failed to
        // create is a warning, not a failed run.
        if (rejected) {
          logger.warn(
            `An unused eager sandbox failed to create: ${
              rejected.reason instanceof Error
                ? rejected.reason.message
                : String(rejected.reason)
            }`,
          );
        }

        return result;
      }

      const als = getAsyncCtxSync();

      // A run started by a message keeps what its trigger carries.
      return als?.execution
        ? runWithAsyncCtx(
            {
              ...als,
              execution: {
                ...als.execution,
                ...(found
                  ? { agent: { thread: thread.key, session: thread.session } }
                  : {}),
                agentBridge: bridge,
              },
            },
            main,
          )
        : main();
    },
  );

  return {
    fn,
    cleanup,
    finished,
    ...(arrival && { arrival }),
    ref,
    thread(key, session) {
      return getThread(client, ref, key, {
        session,
        kv: store,
        requests: config.requests,
      });
    },
    threads: {
      list(options) {
        return listThreads(client, ref, options, (key, session) => {
          return getThread(client, ref, key, {
            session,
            kv: store,
            requests: config.requests,
          });
        });
      },
    },
  };
}
