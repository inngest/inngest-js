/**
 * @module
 * EXPERIMENTAL: the types of an agent: its config, the context its body gets,
 * the messages of its inbox and the agent function it makes.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { GetFunctionInput, Inngest } from "../../../components/Inngest.ts";
import type { InngestFunction } from "../../../components/InngestFunction.ts";
import { step } from "../../../components/InngestStepTools.ts";
import type {
  Inbox,
  InboxMessageOf,
  UntypedInboxMessage,
} from "../../../components/inbox/Inbox.ts";
import type { Middleware } from "../../../components/middleware/middleware.ts";
import type { SandboxTools } from "../../../components/sandbox/tools.ts";
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
import type {
  AgentAnswerData,
  AgentFinishedData,
  AgentMessageData,
  AgentQuestionData,
} from "../inbox/events.ts";
import type { AgentReportLine } from "../inbox/reports.ts";
import type { Sender } from "../inbox/sender.ts";
import type { Json } from "../json.ts";
import type { AgentPrice } from "../loop/cost.ts";
import type {
  AgentHandlerLoop,
  AgentLoop,
  AgentLoopOptions,
  AgentModel,
  AgentUserContent,
  ModelValue,
} from "../loop/loop.ts";
import type { AgentScoreFn } from "../loop/scores.ts";
import type {
  AgentSandbox,
  AgentSandboxWithRepo,
  SandboxesConfig,
  SandboxToolNames,
  SandboxToolsOf,
} from "../sandboxes/defs.ts";
import type { SkillSources } from "../skills/skills.ts";
import type { ThreadHandle, TriggerEvent } from "../threads/thread.ts";
import type {
  ThreadKeyConfig,
  ThreadTriggers,
} from "../threads/threadTrigger.ts";
import type { AgentToolSet } from "./agentTools.ts";
import type { LendOptions } from "./lending.ts";
import type { AgentBudget, AgentLimits } from "./limits.ts";
import type { AgentFunctionOptions } from "./options.ts";
import type { LastRun } from "./recovery.ts";
import type { RunField, RunFieldContext } from "./runField.ts";
import type { StartedThreadPromise } from "./startThread.ts";

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
   *
   * Deliberate unknown: this is the bag's "not named" slot; the bag an agent
   * names narrows it, and `AgentTypeDefaults` says what an unnamed field is.
   */
  event?: unknown;

  /**
   * What the body returns.
   *
   * Deliberate unknown: the slot is open until the body's return type fills
   * it.
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
  sources?: readonly InboxSourceInput[] | undefined;

  /**
   * The agent's `model`, if it has one, as a value or a function: only an
   * agent with a model gets a `loop` in its handler.
   */
  model?: ModelField | undefined;
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
   * Deliberate unknown: an agent whose body is not typed returns something
   * only the code that reads the result can check.
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

  /**
   * No model, so a handler written without naming the bag has no `loop`.
   */
  model: undefined;
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
    sources: infer V extends readonly InboxSourceInput[] | undefined;
  }
    ? V
    : AgentTypeDefaults["sources"];
  model: TTypes extends { model: infer V extends ModelField | undefined }
    ? V
    : AgentTypeDefaults["model"];
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
   * `tags`, `share` (`"private"` by default, only agents of its own app; `"team"`, the
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
   * host, in the run. `{ agents, tools }` filter what the model can see and
   * may start; agents it starts never see more than it was allowed.
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
   * The model the agent's loop calls: an adapter such as
   * `anthropic({ model })`, or a function of `{ event, thread }` returning one,
   * read once at the start of each run. A function of the model's own shape
   * (`(request) => response`) is a model, not a run field, only when wrapped
   * with `agentModel()`. With a `model` and no handler, the agent runs one the
   * SDK writes: each batch of messages goes to the model, the model's history
   * carries on across batches and the final answer is the run's output.
   */
  model?: AgentTypesOf<TTypes>["model"] extends ModelField
    ? AgentTypesOf<TTypes>["model"]
    : ModelFieldOf<AgentTypesOf<TTypes>["event"]>;

  /**
   * The model's system prompt: a value, or a function of `{ event, thread }`
   * read once at the start of each run.
   */
  system?: RunField<string, RunFieldContext<AgentTypesOf<TTypes>["event"]>>;

  /**
   * The tools the model can call, beside the ones the SDK adds (the inbox
   * tools, and the sandboxes', discovery and agent tools as they arrive): a
   * value, or a function of `{ event, thread }` read once at the start of each
   * run.
   */
  tools?: RunField<
    SandboxTools,
    RunFieldContext<AgentTypesOf<TTypes>["event"]>
  >;

  /**
   * Either options for the agent's own loop (`loop: { maxTurns: 10 }`, applied
   * to the loop the agent builds), or a whole different loop to use in its
   * place. The agent's triggers, inbox and thread stay as they are.
   */
  loop?:
    | (Omit<
        AgentLoopOptions,
        "id" | "model" | "system" | "tools" | "history" | "format" | "steer"
      > & {
        /**
         * What the model sees for a message: the agent's own messages, typed
         * from its triggers and `inbox`, with `is()`. Default: `formatEvent`.
         */
        format?: (message: AgentMessageOf<TTypes>) => AgentUserContent;

        /**
         * Chooses which drained messages are folded in, from the agent's own
         * messages. What it skips comes back as `result.unread`.
         */
        steer?: (
          drained: AgentMessageOf<TTypes>[],
        ) => AgentMessageOf<TTypes>[] | Promise<AgentMessageOf<TTypes>[]>;
      })
    | AgentLoop;

  /**
   * Whether the loop remembers the model's history across runs of a thread.
   * Default `true`; `false` starts each run clean. A value, or a function of
   * `{ event, thread }` read once at the start of each run. The history is
   * kept under this agent's own key on the thread, so two agents sharing a
   * thread key each remember their own. On the ledger KV store it counts
   * against the 128 KB the thread holds: a history past it is not kept (a
   * warning is logged and the run goes on).
   */
  remember?: RunField<boolean, RunFieldContext<AgentTypesOf<TTypes>["event"]>>;

  /**
   * Event sources that reach a live run of the thread they map to and never
   * start one, and read through the one `inbox`.
   * `triggers` still starts and wakes runs. Each source maps its own events to the
   * thread key with its `thread` expression. A source written as just an event
   * type or name (`inbox: [ciPassed]`) is placed by the agent's own `thread`;
   * an agent with no `thread` can't have one.
   */
  inbox?: AgentTypesOf<TTypes>["sources"] extends readonly InboxSourceInput[]
    ? AgentTypesOf<TTypes>["sources"]
    : readonly InboxSourceInput[];

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
   * The agent's skills: know-how the model reads, in the `SKILL.md` format.
   * A value such as `[skills.folder("./skills")]`, or a function of
   * `{ event, thread }` read once at the start of each run. The model sees
   * each skill's name and description, and opens a body with `open_skill`.
   * The files go to the first sandbox the model can use. Skills add no tools.
   */
  skills?: RunField<
    SkillSources,
    RunFieldContext<AgentTypesOf<TTypes>["event"]>
  >;

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
   * EXPERIMENTAL: how deep chains of started agents go: `depth` (default 1,
   * so it may start sub-agents and they may not). The lowest `depth` in the
   * chain wins. What the model may start is set by `discovery.agents`.
   */
  limits?: AgentLimits;

  /**
   * What a thread of this agent may spend: `usd`, `tokens`, `input` or
   * `output`. A value, or a function of `{ event, thread }` run once, when
   * the thread's first run starts. The loop always enforces it, ending with
   * `end: "budget"` before its next model call once it is spent. The budget
   * is kept on the thread and belongs to this agent's own definition: it is
   * never handed down by the agent that started the thread. The spend is
   * kept in this agent's record on the thread, written once per model turn: on
   * the ledger KV store that is one step for the run and two for the ledger
   * per write.
   */
  budget?: RunField<
    AgentBudget,
    RunFieldContext<AgentTypesOf<TTypes>["event"]>
  >;

  /**
   * What a model call costs, for `budget.usd`, in place of the model's own
   * prices: rates per million tokens by model name, or a function of the
   * call's tokens and model that returns US dollars. A value only.
   */
  price?: AgentPrice;

  /**
   * What the agent does about a run that fails for good. Off by default.
   * `true` resends the message the run was handling as an `agent/recover`
   * event, so a fresh run takes it up. The same error is never resent twice,
   * a `NonRetriableError` is never resent, and at most 3 kinds of error are
   * allowed per message. Only the message `inbox.next()` delivered last is
   * resent: messages that arrived during the failed turn and were not read
   * stay with the failed run. Nothing is posted about the failure: it shows
   * in the trace. A cancelled run (`thread.stop()`, a `cancelOn` event
   * or a `timeouts.finish` limit) is a choice, not a failure: it is neither
   * reported nor resumed, and a completed run is neither. How every run ended
   * is kept either way: see `previousRun`. The guard (the error
   * fingerprints of the turn) is kept in this agent's own `lastRun` record on
   * the thread, so two agents sharing a thread key never share a guard.
   */
  recovery?: boolean;
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
 * What an `inbox` takes for a source: an `InboxSource`, or just the event (a
 * name or an `eventType()`), which the agent's own `thread` places.
 */
export type InboxSourceInput =
  | InboxSource
  | string
  | EventTypeWithAnySchema<string>;

/**
 * An agent's `model`: a model marked with `agentModel()` (the adapters are), or
 * a function of `{ event, thread }` returning one. The marked side has no call
 * signature, so the function's `{ event, thread }` is typed from the agent's
 * triggers. `Function` here, since that event is only known per agent and a
 * call signature would hide it from the function's parameter.
 */
// biome-ignore lint/complexity/noBannedTypes: no call signature, so it adds no contextual type
export type ModelField = ModelValue | Function;

/**
 * The `model` of an agent whose triggers give `TEvent`: its function takes
 * the run's `{ event, thread }`.
 */
export type ModelFieldOf<TEvent> =
  | ModelValue
  | ((context: RunFieldContext<TEvent>) => AgentModel | Promise<AgentModel>);

/**
 * EXPERIMENTAL: the options of `agent.start()`.
 */
export interface StartOptions extends LendOptions {
  /**
   * The key of the thread to start the run on. Default: a new thread with a
   * generated key.
   */
  thread?: string;

  /**
   * The name of the group the new thread joins, together with every thread the
   * same starter put in a group of that name. Needs a generated key, so it
   * cannot be set with `thread`.
   */
  group?: string;

  /**
   * EXPERIMENTAL: what the started agent owes back, as typed reports. A line
   * is an ordinary `eventType()` (the report goes back to the thread that
   * started the agent) or `{ event, to, if, required }`: `to` is the thread or
   * threads it goes to (`me`, `agent.thread(key)`), `if` a CEL condition over
   * the report (`async.data`) and `required` that the report is owed: the
   * agent's loop reminds its model before it may finish. The lines of one
   * type merge. The routing travels in the signed grant of the start, so the
   * agent needs no prior knowledge of the types. `msg.is(milestone)` narrows
   * the report in the receiver's inbox, typed as the event type's data.
   */
  reports?: readonly AgentReportLine[];
}

/**
 * The handle to a run's own thread.
 */
export interface Me {
  /**
   * The thread's key.
   */
  readonly key: string;

  /**
   * Puts a message in the agent's own inbox. The run that takes it is the live
   * run itself, so there is no result to wait for. Sent from a step, so a
   * replay sends it once.
   */
  message(content: Json): Promise<void>;

  /**
   * EXPERIMENTAL: sends a typed report to the destinations the run's starter
   * listed for its type (every one whose `if` passes). The type is an
   * ordinary `eventType()`. The data is checked against its schema first and a
   * bad report throws, sending nothing. It throws when the run was not started
   * with this report type. Counts toward a required report. Sent from a step,
   * so a replay sends it once.
   */
  report<TSchema extends StandardSchemaV1<Record<string, unknown>> | undefined>(
    type: { readonly name: string; readonly schema: TSchema },
    data: TSchema extends StandardSchemaV1
      ? StandardSchemaV1.InferInput<TSchema>
      : Record<string, unknown>,
  ): Promise<void>;
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
    [K in keyof AgentTypesOf<TTypes>["sandboxes"] &
      string]: "~repo" extends keyof AgentTypesOf<TTypes>["sandboxes"][K]
      ? AgentSandboxWithRepo
      : AgentSandbox;
  };

  /**
   * Scores the run: `score("quality", 1)`, or a record of scores in one step:
   * `score({ a: 1, b: 0.5 })`. Written once wherever it is called. The value
   * is a finite number or a boolean. Inside a `group.experiment()` variant it
   * credits that variant; elsewhere, only `{ experiment }` from the options.
   */
  score: AgentScoreFn;

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
  ? TItem extends EventTypeWithAnySchema<string>
    ? InboxMessageOf<{ event: TItem }>
    : TItem extends { event: infer TEvent }
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
 * What `start()` takes: the data of the agent's `invoke()` trigger when it has
 * one, otherwise JSON content.
 */
export type StartInput<TEvent> = [
  Extract<TEvent, { name: "inngest/function.invoked" }>,
] extends [never]
  ? Json
  : Extract<TEvent, { name: "inngest/function.invoked" }> extends {
        data: infer TData;
      }
    ? TData
    : Json;

/**
 * A message of the thread's inbox. It is a plain event (`id`, `name`, `data`,
 * `ts`): narrow it by `name` or `is()`, and `data` is typed.
 *
 * - An event of `triggers` (a trigger, which also starts the run as message 1) has
 *   its own name and data, typed from `triggers`.
 * - `agent/message` (`thread.send()`),
 *   (none of them is a stop: `thread.stop()` cancels the run) carry the thread and agent beside their
 *   `text` or `when`.
 *
 * A message from an inbox source is its event too, under the event's own
 * `name`; it is not in the type of `triggers`, so narrow it with `is(type)`.
 */
type FromSender = {
  /**
   * Who sent the message: an agent is a handle you can message back, a plain
   * function is its ID and key. Anyone can send an event with `data.from`, so
   * a message from an agent is never an approval.
   */
  from?: Sender;
};

/**
 * A message the agent's handler and loop read: its triggers, its `inbox`
 * sources and the agent messages, with `is()`.
 */
export type AgentMessageOf<TTypes extends AgentTypes> = AgentMessage<
  AgentTypesOf<TTypes>["event"],
  AgentTypesOf<TTypes>["sources"]
>;

export type AgentMessage<TEvent = TriggerEvent, TSources = undefined> =
  | TriggerMessage<TEvent>
  | SourceMessages<TSources>
  | (MessageOf<AgentMessageData, "agent/message"> & FromSender)
  | (MessageOf<AgentQuestionData, "agent/question"> &
      FromSender & {
        /**
         * Answers the question: with text, or with `{ outcome: "refused" }`. Only
         * the first answer counts; a second or late one is dropped.
         */
        reply(answer: string | { outcome: "refused" }): Promise<void>;
      })
  | (MessageOf<AgentAnswerData, "agent/answer"> & FromSender)
  | (MessageOf<AgentFinishedData, "agent/finished"> & FromSender);

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
  AgentFunctionInput<TTypes> &
    AgentBodyFields<TTypes> &
    (AgentTypesOf<TTypes>["model"] extends ModelField
      ? {
          /**
           * The agent's own loop, made from its definition: `model`, `system`
           * and `tools`, plus the model's `inbox_listen` and `inbox_close`
           * when the agent has `listen`. `loop(batch)` folds the messages that
           * arrive meanwhile into the very next model call and posts nothing.
           * `loop.with(options)` derives another from it. Only an agent with a
           * `model` has one, as a value or a function. Its result's runs
           * know the sandboxes' tools by name (`work_finish`), with their types.
           */
          loop: AgentHandlerLoop<
            AgentToolSet & SandboxToolsOf<AgentTypesOf<TTypes>["sandboxes"]>
          >;
        }
      : Record<never, never>);

/**
 * The body of an agent. `TTypes` is the `AgentTypes` bag: the events of its
 * `triggers`, what it returns, and so on. Name only what you need.
 *
 * @example
 * ```ts
 * const body: AgentBody<{ event: ThreadCronEvent; output: null }> = async ({
 *   event,
 * }) => {
 *   console.log(event?.data.cron);
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
export interface AgentFunction<TOutput = unknown, TInput = Json> {
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
   * The agent's function ID.
   */
  id: string;

  /**
   * The agent's address, `"<appId>/<functionId>"` (the same as `ref`).
   */
  address: string;

  /**
   * Starts the agent and returns at once: on a new thread with a generated key,
   * or on `options.thread`, so a caller can keep one thread (and its sandboxes)
   * across runs with a typed input. A message to that thread while the run is
   * live lands in its inbox as usual.
   * The value is a promise of the thread's handle that also has its methods,
   * so `await agent.start(x).result()` needs one `await`. Needs a function's
   * step context. Called without `await`, the start is still sent when the
   * caller is an agent. A plain function that returns at once may return before
   * the engine reports the step (the default for plain functions is not to send
   * an op nothing awaited), so `await` it there.
   * @param input What the agent is asked to do.
   * @param options `thread`: the key of the thread to start the run on.
   * `group`: the name of a group the new thread joins. Threads that the same
   * thread started with the same group name can `message_agent` and
   * `ask_agent` each other, and the live ones hear of each join. A group needs
   * a generated key, so it cannot be set with `thread`.
   * `reports`: the typed reports the agent may send back, as event types or
   * `{ event, to, if, required }` lines: where each goes and which it owes.
   * The agent's model gets a `report` tool, and its handler `me.report()`.
   * `tools` and `sandboxes` lend the parent's sandbox tools and sandboxes to
   * the child, which runs them as steps of its own run (same app only), and
   * `attach` ties the child to this run: it is cancelled when this run ends
   * for good. A child that borrows is attached by default; `attach: false`
   * with lending is an error.
   */
  start(input: TInput, options?: StartOptions): StartedThreadPromise<TOutput>;

  /**
   * The handle of a thread of this agent.
   */
  thread(
    /**
     * Thread key.
     */
    key: string,
  ): ThreadHandle<TOutput>;
}
