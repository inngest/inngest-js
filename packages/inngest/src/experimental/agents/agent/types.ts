/**
 * @module
 * EXPERIMENTAL: the types of an agent: its config, the context its body gets,
 * the messages of its inbox and the agent function it makes.
 */

import type { GetFunctionInput, Inngest } from "../../../components/Inngest.ts";
import type { InngestFunction } from "../../../components/InngestFunction.ts";
import { step } from "../../../components/InngestStepTools.ts";
import type {
  Inbox,
  InboxMessageOf,
  UntypedInboxMessage,
} from "../../../components/inbox/Inbox.ts";
import type { Middleware } from "../../../components/middleware/middleware.ts";
import type { EventTypeWithAnySchema } from "../../../components/triggers/triggers.ts";
import type {
  EventIs,
  EventShape,
} from "../../../components/triggers/typeHelpers.ts";
import type { DurationInput } from "../../../helpers/duration.ts";
import type {
  ApplyAllMiddlewareCtxExtensions,
  ApplyAllMiddlewareGroupExtensions,
  ApplyAllMiddlewareStepExtensions,
} from "../../../types.ts";
import type {
  AgentCard,
  AgentCardConfig,
  AgentDiscovery,
} from "../discovery/discovery.ts";
import type { AgentMessageData, AgentSteerData } from "../inbox/events.ts";
import type { AgentPrice } from "../loop/cost.ts";
import type {
  AgentEvent,
  AgentInput,
  AgentLoopOptions,
  AgentLoopResult,
  AgentTurn,
} from "../loop/loop.ts";
import type { AgentScores } from "../loop/scores.ts";
import {
  type LazySandbox,
  type SandboxesConfig,
  type SandboxToolNames,
  type SandboxToolsOf,
  sandboxTools,
} from "../sandboxes/defs.ts";
import type { ThreadHandle, TriggerEvent } from "../threads/thread.ts";
import type {
  ThreadKeyConfig,
  ThreadTriggers,
} from "../threads/threadTrigger.ts";
import type { AgentLimits } from "./limits.ts";
import type { AgentFunctionOptions } from "./options.ts";
import type { AgentRecovery, LastRun } from "./recovery.ts";
import type { RunField, RunFieldContext } from "./runField.ts";

/**
 * The types an agent carries, as one object type. Every field is optional:
 * what a bag leaves out takes the default of `AgentTypeDefaults`. Name only
 * what you need, such as `AgentBody<{ output: null; middleware: TMiddleware }>`.
 *
 * - `event`: the events of the agent's `triggers` (`TriggerEvent`).
 * - `output`: what the body returns. Only `AgentBody` reads it; `agents.agent`
 *   infers the output from the body's return type, so a config or context
 *   bag does not need it.
 * - `sandboxes`: for each sandbox name, the names of the tools it brings.
 * - `client`: the Inngest client, whose middleware types the body's context.
 * - `middleware`: the function-level middleware, which adds to the context.
 * - `sources`: the `inbox` sources of the config, whose event types type the
 *   messages they add to the inbox.
 */
export interface AgentTypes {
  /**
   * The events of the agent's `triggers`.
   */
  event?: unknown;

  /**
   * What the body returns.
   */
  output?: unknown;

  /**
   * For each sandbox name, the names of the tools it brings.
   */
  sandboxes?: SandboxToolNames;

  /**
   * The Inngest client of the agent.
   */
  client?: Inngest.Any;

  /**
   * The function-level middleware of the agent.
   */
  middleware?: Middleware.Class[] | undefined;

  /**
   * The `inbox` sources of the agent's config.
   */
  sources?: readonly InboxSource[] | undefined;
}

/**
 * What each field of `AgentTypes` is when the bag does not name it.
 */
export interface AgentTypeDefaults {
  /**
   * Any trigger event.
   */
  event: TriggerEvent;

  /**
   * Unknown.
   */
  output: unknown;

  /**
   * Any sandbox names.
   */
  sandboxes: SandboxToolNames;

  /**
   * Any client.
   */
  client: Inngest.Any;

  /**
   * No function-level middleware.
   */
  middleware: undefined;

  /**
   * No typed sources.
   */
  sources: undefined;
}

/**
 * An `AgentTypes` bag with its gaps filled from `AgentTypeDefaults`: every
 * field is there, and the ones the bag names are the bag's own.
 */
export type AgentTypesOf<TTypes extends AgentTypes> = {
  event: TTypes extends { event: infer V } ? V : AgentTypeDefaults["event"];
  output: TTypes extends { output: infer V } ? V : AgentTypeDefaults["output"];
  sandboxes: TTypes extends { sandboxes: infer V extends SandboxToolNames }
    ? V
    : AgentTypeDefaults["sandboxes"];
  client: TTypes extends { client: infer V extends Inngest.Any }
    ? V
    : AgentTypeDefaults["client"];
  middleware: TTypes extends {
    middleware: infer V extends Middleware.Class[] | undefined;
  }
    ? V
    : AgentTypeDefaults["middleware"];
  sources: TTypes extends {
    sources: infer V extends readonly InboxSource[] | undefined;
  }
    ? V
    : AgentTypeDefaults["sources"];
};

/**
 * The config of an agent: its ID, what starts it, and what it may use.
 * `TOn` is the type of `triggers`; `TTypes` is the `AgentTypes` bag (the events of
 * its triggers, what other threads ask it and what it answers, and so on).
 * Without one, the middleware is `Middleware.Class[] | undefined`, so any
 * config fits.
 */
export interface AgentFunctionConfig<
  TOn = ThreadTriggers,
  TTypes extends AgentTypes = { middleware: Middleware.Class[] | undefined },
> extends ThreadKeyConfig<TOn>,
    AgentFunctionOptions<AgentTypesOf<TTypes>["middleware"]> {
  /**
   * The function ID. The agent is addressed as `"<appId>/<id>"`.
   */
  id: string;

  /**
   * What the agent publishes about itself for discovery: `description`,
   * `share` (`"private"` by default, only agents of its own app; `"team"`, the
   * whole environment), `owner`, `effects` (`"read"` or `"write"`, default
   * `"write"`) and `speed`. An agent without a `card` still publishes its
   * address, private.
   */
  card?: AgentCardConfig;

  /**
   * Discovery for the agent's model: on by default (`list_agents`,
   * `describe_agent` and the tools that start or reach other agents).
   * `false` removes them, and the agent's own card is still published.
   * `{ prepare }` fills part of the input of a call to another agent from the
   * host, in the run.
   */
  discovery?: AgentDiscovery;

  /**
   * How long a run waits in quiet before it ends: a number of milliseconds, a
   * string such as `"7d"` or a Temporal duration, or a function of
   * `{ event, thread }` returning one. Default: 10 minutes. It ends the run of
   * a handler that loops over its inbox, with `for await (const batch of
   * inbox.batches())` or `for await (const m of inbox)`: the loop returns after
   * that much quiet. A later message starts a new run on the same thread. A
   * long `idle` keeps a run live across deploys, and every step it takes counts
   * toward the step limit.
   */
  idle?: RunField<
    DurationInput,
    RunFieldContext<AgentTypesOf<TTypes>["event"]>
  >;

  /**
   * Event sources that reach a live run of the thread they map to and never
   * start one, and read through the one `inbox`.
   * `triggers` still starts and wakes runs. Each source maps its own events to the
   * thread key with its `thread` expression.
   */
  inbox?: AgentTypesOf<TTypes>["sources"] extends readonly InboxSource[]
    ? AgentTypesOf<TTypes>["sources"]
    : readonly InboxSource[];

  /**
   * The event types the model may start watching while it works, with its
   * `inbox_listen({ source, match, as })` tool and `inbox_close({ as })` to
   * stop. Both tools exist only when this list is not empty, and `source`
   * must name a type listed here: anything else is refused with a message the
   * model can read. `match` narrows what the model hears to events whose
   * `data` has given values at given paths. Event types only, no plain names.
   */
  listen?: readonly EventTypeWithAnySchema<string>[];

  /**
   * Which messages that arrive during a turn `control.steer()` (and so
   * `agent.loop()` inside this agent) folds into the turn at the next model
   * call. `"steer"` (default): only `agent/steer` events; the rest wait
   * for their own turn. `"all"`: every event that would start a turn too (an
   * `agent/message`, a trigger event, an inbox source's event), as steering
   * messages. A folded message is consumed: `next()` does
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
  sandboxes?: SandboxesConfig<
    RunFieldContext<AgentTypesOf<TTypes>["event"]>,
    AgentTypesOf<TTypes>["sandboxes"]
  >;

  /**
   * What this agent may start and spend: `depth` (default 1, so it may start
   * sub-agents and they may not), `mayCall` and `budget`. Sub-agents
   * inherit the limits narrowed. `budget` is not automatic:
   * spread `control` into `agent.loop()`, or that loop runs unbudgeted.
   */
  limits?: AgentLimits;

  /**
   * Whether the agent scores itself. Default: `true`. The loop scores each
   * model and tool step (see `agent.loop()`). Every score rides on a
   * step that already runs, so none adds a step. `false` turns those off;
   * `scores.score()` in the body still works.
   */
  scores?: boolean;

  /**
   * What the agent does about a run that fails unexpectedly. Off by default.
   * `true` or an object resends the turn that was in flight, so a fresh run
   * takes it up; a turn that fails twice with the same error is not resent.
   * Only the message `inbox.next()` delivered last is
   * resent: messages that arrived during the failed turn and were not read
   * stay with the failed run. A cancelled run (`thread.stop()`, a `cancelOn` event
   * or a `timeouts.finish` limit) is a choice, not a failure: it is neither
   * reported nor resumed, and a completed run is neither. How every run ended
   * is kept either way: see `previousRun` and `thread.state().lastRun`.
   */
  recovery?: boolean | AgentRecovery;
}

/**
 * An event source for an agent's inbox. Its events reach the run of the thread
 * they map to while it is live, and never start one. `thread` is an expression
 * over `event` (the arriving event) that gives the thread key. `if` is written
 * like the `if` of `step.subscribe()`: `async` is the arriving event and
 * `event` is the event that started the run, so `async.data.pr == event.data.pr`
 * ties a source to the trigger. At least one is required.
 */
export type InboxSource = {
  /**
   * The event: a name or an `eventType()`.
   */
  event: string | EventTypeWithAnySchema<string>;
} & ({ thread: string; if?: string } | { if: string; thread?: string });

/**
 * The handle to a run's own thread.
 */
export interface Me {
  /**
   * The thread's key.
   */
  readonly key: string;
}

/**
 * The event that started a run, as the handler gets it: the received event
 * with its own name and data, and `is()` to narrow it per trigger. One member
 * for each trigger of the agent.
 */
export type AgentEventOf<TEvent> = TEvent extends {
  name: infer TName extends string;
  data: infer TData;
}
  ? Omit<EventShape<TName, Record<string, unknown>>, "data"> & {
      data: TData;
    } & EventIs
  : never;

/**
 * The fields the agent adds to the function context in its body. See
 * `AgentBodyContext`.
 */
export interface AgentBodyFields<TTypes extends AgentTypes = AgentTypes> {
  /**
   * The event that started the run, exactly as sent (an app event, the input
   * of `start()`, a cron tick), narrowed per trigger with `event.is()`. It is
   * also the inbox's first message. For `invoke()` the data is the caller's
   * input. A run that recovery resumed has the event of the run that failed.
   */
  event: AgentEventOf<AgentTypesOf<TTypes>["event"]>;

  /**
   * The handle to this run's own thread.
   */
  me: Me;

  /**
   * How many agents deep this run is when another agent started it: 1 for
   * an agent a function that is not an agent invoked, 2 for the next, and so
   * on. 0 when something else started the run (an event, a cron tick, a thread
   * message, including a later run of an invoked agent's thread).
   */
  depth: number;

  /**
   * The agent's sandboxes, by name. Nothing is created until a call needs it,
   * except `start: "eager"` ones, which are already being created.
   */
  sandboxes: {
    [K in keyof AgentTypesOf<TTypes>["sandboxes"] & string]: LazySandbox;
  };

  /**
   * Every sandbox's tools, named `<sandbox>_<tool>` (`work_run`). Spread into
   * the `tools` of `agent.loop()`.
   */
  sandboxTools: SandboxToolsOf<AgentTypesOf<TTypes>["sandboxes"]>;

  /**
   * Runs the loop on a prompt with the agent's own wiring: steering, the
   * budget and the turn record, and, when the agent has `listen`, the model's
   * `inbox_listen` and `inbox_close`. It takes `agent.loop()`'s options except
   * `prompt`; `tools` are added to the agent's.
   */
  loop: (
    prompt: AgentInput | readonly AgentEvent[],
    options: Omit<AgentLoopOptions, "prompt">,
  ) => Promise<AgentLoopResult>;

  /**
   * Your own scores, next to the ones the framework writes. See
   * `AgentScores`.
   */
  scores: AgentScores;

  /**
   * Scores the run: `score("quality", 1)`. Written once wherever it is
   * called. The value is a finite number or a boolean.
   */
  score: (name: string, value: number | boolean) => Promise<void>;

  /**
   * Messages sent to the thread, one per delivery, in order. The first is the
   * event that started the run.
   */
  inbox: Inbox<
    AgentMessage<AgentTypesOf<TTypes>["event"], AgentTypesOf<TTypes>["sources"]>
  >;

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
   * during a turn into the next model call. Messages that start the next turn stay in the inbox.
   * `onTurn` records the turn, the usage and a summary for
   * `thread.state()`: if you pass your own `onTurn`, put `...control` first
   * and call `control.onTurn(turn)` from yours with the turn unchanged: the
   * record of the turn is written inside the model call's step, and
   * `control.onTurn` reads it back.
   */
  control: {
    steer: () => Promise<AgentEvent[]>;

    /**
     * The inboxes the model has open, with the source each was opened on, for
     * a loop that reads them with the thread's own.
     */
    inboxes: () => OpenedInbox[];
    onTurn: (turn: AgentTurn) => Promise<void>;

    /**
     * Records the turn inside the model call's step, so it costs no step of
     * its own. `onTurn` then reads what it recorded.
     */
    recordTurn: (turn: AgentTurn) => Promise<unknown>;
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
 * A message made from an event: the core message with its `name` and `data`
 * fixed.
 */
type MessageOf<TData, TName extends string> = Omit<
  UntypedInboxMessage,
  "name" | "data"
> & {
  name: TName;
  data: TData;
};

/**
 * The messages of the typed sources of the config's `inbox`. A source written
 * as a name has no type to give, so it stays out of the union and `name` still
 * narrows the agent's own messages.
 */
type SourceMessages<TSources> = TSources extends readonly (infer TItem)[]
  ? TItem extends { event: infer TEvent }
    ? TEvent extends EventTypeWithAnySchema<string>
      ? InboxMessageOf<{ event: TEvent }>
      : never
    : never
  : never;

/**
 * The event of a trigger of `triggers`, as an inbox message: its own name and data.
 */
type TriggerMessage<TEvent> = TEvent extends {
  name: infer TName extends string;
  data: infer TData;
}
  ? // An agent whose `triggers` is not typed has events of any name; they stay out
    // of the union, so `name` still narrows the agent's own events.
    string extends TName
    ? never
    : MessageOf<TData, TName>
  : never;

/**
 * A message of the thread's inbox. It is a plain event (`id`, `name`, `data`,
 * `ts`): narrow it by `name` or `is()`, and `data` is typed.
 *
 * - An event of `triggers` (a trigger, which also starts the run as message 1) has
 *   its own name and data, typed from `triggers`.
 * - `agent/message` (`thread.send()`), `agent/steer` (`thread.steer()`) and
 *   (none of them is a stop: `thread.stop()` cancels the run) carry the thread and agent beside their
 *   `text` or `when`.
 *
 * A message from an inbox source is its event too, under the event's own
 * `name`; it is not in the type of `triggers`, so narrow it with `is(type)`.
 */
export type AgentMessage<TEvent = TriggerEvent, TSources = undefined> =
  | TriggerMessage<TEvent>
  | SourceMessages<TSources>
  | MessageOf<AgentMessageData, "agent/message">
  | MessageOf<AgentSteerData, "agent/steer">;

/**
 * An inbox the model opened with `inbox_listen`.
 */
export interface OpenedInbox {
  /**
   * The name the model gave it.
   */
  as: string;

  /**
   * The source it was opened on: the event, and the filter that ties it to the
   * thread.
   */
  source: { event: string; if: string };

  /**
   * The inbox. Messages that break their source's schema are dropped.
   */
  inbox: Inbox<UntypedInboxMessage>;
}

/**
 * The function context an agent's body shares with a plain function, typed
 * from the client's middleware: `step`, `group`, `defer`, `runId`, `logger`,
 * `attempt` and the rest, without `event` and `events`, which the agent
 * replaces.
 */
export type AgentFunctionInput<TTypes extends AgentTypes = AgentTypes> = Omit<
  GetFunctionInput<AgentTypesOf<TTypes>["client"]>,
  "event" | "events" | "step" | "group"
> &
  ApplyAllMiddlewareCtxExtensions<AgentTypesOf<TTypes>["middleware"]> & {
    step: GetFunctionInput<AgentTypesOf<TTypes>["client"]>["step"] &
      ApplyAllMiddlewareStepExtensions<AgentTypesOf<TTypes>["middleware"]>;
    group: GetFunctionInput<AgentTypesOf<TTypes>["client"]>["group"] &
      ApplyAllMiddlewareGroupExtensions<AgentTypesOf<TTypes>["middleware"]>;
  };

/**
 * What the body gets: the function context the client's middleware gives a
 * plain function (`step` with `step.sandbox` when the client has the sandbox
 * middleware, `group`, `defer`, `runId`, `logger`, `attempt` and the rest)
 * with the agent's own fields beside it. `event` is the agent's, not the
 * function's: its `data` has the agent and thread, and `data.event` is the
 * trigger event. There is no `events`, because an agent never runs on a
 * batch.
 */
export type AgentBodyContext<TTypes extends AgentTypes = AgentTypes> =
  AgentFunctionInput<TTypes> & AgentBodyFields<TTypes>;

/**
 * The body of an agent. `TTypes` is the `AgentTypes` bag: the events of its
 * `triggers`, what it returns, and so on. Name only what you need.
 *
 * @example
 * ```ts
 * const body: AgentBody<{ event: ThreadCronEvent; output: null }> = async ({
 *   trigger,
 * }) => {
 *   console.log(trigger?.data.cron);
 *
 *   return null;
 * };
 * ```
 */
export type AgentBody<TTypes extends AgentTypes = AgentTypes> = (
  context: AgentBodyContext<TTypes>,
) => Promise<AgentTypesOf<TTypes>["output"]>;

/**
 * An agent made by `createAgents().agent()`: the functions to serve, its
 * address, and handles to its threads. `TOutput` is what its body returns.
 */
export interface AgentFunction<TOutput = unknown> {
  /**
   * Types only: what the agent's body returns.
   */
  readonly "~types"?: { output: TOutput };

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
   * What the agent publishes for discovery.
   */
  card: AgentCard;

  /**
   * The handle of a thread of this agent.
   */
  thread(
    /**
     * Thread key.
     */
    key: string,
  ): ThreadHandle;
}
