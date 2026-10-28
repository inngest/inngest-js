/**
 * @module
 * EXPERIMENTAL: starting a thread from a trigger. An agent's `on` lists the
 * events that talk to it (a Slack message, a pull request comment). The agent
 * function triggers on them directly:
 *
 * - the thread key is an expression over the trigger event, supplied by the
 *   trigger (a helper for a vendor event knows how to derive it) or by the
 *   agent's `thread` option, which wins;
 * - the function's singleton is keyed on that expression, so a trigger for a
 *   thread with a live run starts nothing;
 * - the live run's inbox subscribes to the same events, filtered by the same
 *   expression equalling its thread key, so that trigger is delivered to the
 *   run as a message.
 *
 * `on` takes the same shapes as the `triggers` of `createFunction`: an event
 * name, an `eventType()` (alone or as `event`), and `{ cron }`. The original
 * trigger goes to the function, so core types and validates the event as it
 * does for any function, so `on: invoke(schema)` makes the agent invokable
 * with typed input. A cron has no event data to key a thread on, so its
 * thread is one per agent (the agent's ID) unless the cron trigger sets
 * `thread`; a tick while a run is live starts nothing and is not delivered.
 * An invocation by `agent.invoke()` runs on the thread it names (its own, per
 * call); any other invocation is keyed by `thread` or, without one, is the
 * agent's one thread. Only one run is live per thread, so a second such
 * invocation while a run is live is skipped.
 *
 * The expression is CEL, in the subset of `cel.ts`, because the backend
 * evaluates it as written and the run evaluates it too. A JavaScript function
 * cannot be a thread key: the backend could not read it.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { internalEvents } from "../../helpers/consts.ts";
import {
  EventType,
  type EventTypeWithAnySchema,
} from "../triggers/triggers.ts";
import { compileKey, toAsync } from "./cel.ts";
import { skillsBakeEvent } from "./skills.ts";
import {
  agentMessageEvent,
  type ThreadMessage,
  type TriggerEvent,
} from "./thread.ts";

/**
 * The trigger event, as `message` sees it.
 */
export interface ThreadTriggerEvent<
  TData extends Record<string, unknown> = Record<string, unknown>,
> {
  id?: string;
  name: string;
  data: TData;
}

/**
 * What an agent can listen to by event: a name, or an `eventType()`.
 */
export type ThreadTriggerEventSource = string | EventTypeWithAnySchema<string>;

/**
 * The data of the events of a trigger source: the schema's for an
 * `eventType()`, any record for a name.
 */
export type ThreadTriggerData<T> = T extends EventType<string, infer TSchema>
  ? TSchema extends StandardSchemaV1<
      infer TData extends Record<string, unknown>
    >
    ? TData
    : // biome-ignore lint/suspicious/noExplicitAny: an event type without a schema
      Record<string, any>
  : // biome-ignore lint/suspicious/noExplicitAny: an event name carries no schema
    Record<string, any>;

/**
 * The fields every kind of trigger shares.
 */
export interface ThreadTriggerFields<TEvent extends ThreadTriggerEvent> {
  /**
   * The thread key, a CEL expression over `event` that gives a string, such
   * as `event.data.channel + "/" + event.data.thread_ts`.
   *
   * The key is the thread's address: a message sent through a thread handle
   * with the same string, or another `on` event whose key is the same string,
   * reaches the same thread. Prefix the expression (`"slack:" + ...`) to keep
   * events apart.
   */
  thread?: string;

  /**
   * The session the thread belongs to, an expression like `thread`. Default:
   * the thread key.
   */
  session?: string;

  /**
   * The text of the message the event carries. Default: none; the body reads
   * the event itself from `data.event`. Runs in the SDK, not in the backend.
   */
  message?(event: TEvent): string | undefined;
}

/**
 * An event that talks to an agent. A trigger helper returns one of these with
 * `thread` filled in.
 */
export interface ThreadEventTrigger<
  TSource extends ThreadTriggerEventSource = ThreadTriggerEventSource,
> extends ThreadTriggerFields<ThreadTriggerEvent<ThreadTriggerData<TSource>>> {
  /**
   * The event: a plain name (no wildcard, and not `agent/message`) or an
   * `eventType()`, which also types and validates the event.
   */
  event: TSource;

  /**
   * An expression the event must match, like the `if` of a trigger.
   */
  if?: string;
}

/**
 * A schedule that starts the agent, like `{ cron }` of a function. Its thread
 * is the agent's ID unless `thread` is set.
 */
export interface ThreadCronTrigger
  extends ThreadTriggerFields<ThreadTriggerEvent<{ cron: string }>> {
  cron: string;
  event?: never;
  jitter?: string;
}

/**
 * One trigger of `on`: the shapes a function's `triggers` take.
 */
export type ThreadTrigger<
  TSource extends ThreadTriggerEventSource = ThreadTriggerEventSource,
> =
  | ThreadEventTrigger<TSource>
  | ThreadCronTrigger
  | EventTypeWithAnySchema<string>;

/**
 * The trigger event of one trigger source: its name and data.
 */
type SourceEvent<T> = T extends string
  ? TriggerEvent<T, ThreadTriggerData<T>>
  : T extends EventType<infer TName, infer _TSchema>
    ? TriggerEvent<TName, ThreadTriggerData<T>>
    : never;

/**
 * What a cron trigger's tick looks like to the agent.
 */
export type ThreadCronEvent = TriggerEvent<
  "inngest/scheduled.timer",
  { cron: string }
>;

/**
 * The event a trigger source gives the agent: the event's own name and data,
 * or a cron tick for what is not an event source (a cron).
 */
export type ThreadTriggerEventOf<T> = T extends ThreadTriggerEventSource
  ? SourceEvent<T>
  : ThreadCronEvent;

/**
 * The events of a list of triggers, as a union.
 */
export type ThreadTriggerListEvent<TMany extends readonly unknown[]> = {
  [K in keyof TMany]: ThreadTriggerEventOf<TMany[K]>;
}[number];

/**
 * A list of triggers in which each one types its own `message` from its own
 * event.
 */
export type ThreadTriggerList<TMany extends readonly unknown[]> = {
  [K in keyof TMany]: TMany[K] extends ThreadTriggerEventSource
    ? ThreadTrigger<TMany[K]>
    : ThreadCronTrigger | EventTypeWithAnySchema<string>;
};

/**
 * The `on` of an agent that is not typed: one trigger, or a list.
 */
export type ThreadTriggers = ThreadTrigger | readonly ThreadTrigger[];

/**
 * The thread options of an agent config.
 */
export interface ThreadKeyConfig<TOn = ThreadTriggers> {
  /**
   * What starts the agent besides messages: events, event types and crons.
   */
  on?: TOn;

  /**
   * The thread key expression for event triggers, overriding the one they
   * supply. It is needed for a trigger that supplies none. It is a CEL
   * expression, not a function. A cron trigger does not use it; it has its
   * own `thread`.
   */
  thread?: string;

  /**
   * The session expression for event triggers. Default: the thread key. A
   * cron has its own `session`.
   */
  session?: string;
}

export interface CompiledTrigger {
  /**
   * The name of the event that starts the agent: the event's own, or
   * `inngest/scheduled.timer` for a cron.
   */
  event: string;
  if?: string;
  asyncIf?: string;

  /**
   * Whether this is a cron.
   */
  cron: boolean;

  /**
   * Whether a live run listens for more of this event. A cron tick and an
   * invocation cannot be subscribed to.
   */
  listen: boolean;

  /**
   * What the function triggers on: the trigger as written (an event type
   * keeps its schema), without the agent's own fields.
   */
  fnTrigger:
    | { event: ThreadTriggerEventSource; if?: string }
    | { cron: string; jitter?: string };
  thread: ReturnType<typeof compileKey>;
  session?: ReturnType<typeof compileKey>;

  /**
   * The schema of the event's data, when the trigger is an event type that has
   * one. Core validates the event that starts a run; the agent checks the
   * events that reach a live run against the same schema.
   */
  schema?: StandardSchemaV1;
  message?: ThreadTriggerFields<ThreadTriggerEvent>["message"];
}

const cronEvent = internalEvents.ScheduledTimer;

/**
 * The events the agent layer owns, which cannot trigger an agent.
 */
const reservedEvents: string[] = [agentMessageEvent, skillsBakeEvent];

/**
 * Quotes a string as a CEL literal.
 * @param value The string.
 */
const literal = (value: string): string => {
  return JSON.stringify(value);
};

/**
 * Why an event cannot trigger an agent, if it cannot.
 * @param name The event's name.
 * @param cron Whether the trigger is a cron.
 * @param plain Whether the event was given as a plain name.
 */
function refusalOf(
  name: string,
  cron: boolean,
  plain: boolean,
): string | undefined {
  if (name.includes("*")) {
    return "is a wildcard, which an agent cannot listen to; name each event.";
  }

  if (reservedEvents.includes(name)) {
    return "is an event the agent layer owns; use another event name.";
  }

  if (!cron && name === cronEvent) {
    return "is the event of a cron; use { cron } to trigger on a schedule.";
  }

  if (plain && name === internalEvents.FunctionInvoked) {
    return 'is the event of an invocation; use invoke(schema) from "inngest".';
  }

  return undefined;
}

/**
 * Validates and compiles the triggers of a config.
 * @param id The agent's function ID.
 * @param config The thread options.
 */
export function compileTriggers(
  id: string,
  config: ThreadKeyConfig,
): CompiledTrigger[] {
  const given = (config.on ? [config.on].flat() : []) as ThreadTrigger[];
  const compiled: CompiledTrigger[] = [];

  for (const trigger of given) {
    if (typeof trigger !== "object" || trigger === null) {
      throw new Error(
        `Agent "${id}": \`on\` takes triggers such as { event }, { cron } or an event type, not ${JSON.stringify(trigger)}.`,
      );
    }

    const bare = trigger instanceof EventType;
    const cron = !bare && "cron" in trigger && typeof trigger.cron === "string";

    if (cron && (trigger as { event?: unknown }).event !== undefined) {
      throw new Error(
        `Agent "${id}": a trigger is an event or a cron, not both.`,
      );
    }

    const source = bare
      ? trigger
      : cron
        ? undefined
        : (trigger as ThreadEventTrigger).event;
    const name = cron
      ? cronEvent
      : typeof source === "string"
        ? source
        : (source as EventTypeWithAnySchema<string>).name;
    const own = bare
      ? undefined
      : (trigger as ThreadEventTrigger | ThreadCronTrigger);

    const refused = refusalOf(name, cron, typeof source === "string");
    if (refused) {
      throw new Error(`Agent "${id}": the trigger "${name}" ${refused}`);
    }

    // Every cron tick is one event, so crons share one thread key.
    const same = compiled.find((other) => {
      return other.event === name;
    });
    if (same && !cron) {
      throw new Error(
        `Agent "${id}": two triggers on "${name}"; use one trigger per event name.`,
      );
    }

    // A cron tick has no event data to key a thread on, and the agent's
    // `thread` is written for the data of events: a cron is one thread per
    // agent unless it says otherwise.
    const invoked = name === internalEvents.FunctionInvoked;

    const supplied = config.thread ?? own?.thread;
    const thread = cron
      ? (own?.thread ?? literal(id))
      : invoked
        ? // `agent.invoke()` names the callee's thread in `_agent`; any other
          // invocation is keyed by `thread`, or is the agent's own thread.
          `has(event.data._agent) && has(event.data._agent.thread) ? event.data._agent.thread : (${supplied ?? literal(id)})`
        : supplied;
    if (!thread) {
      throw new Error(
        `Agent "${id}": the trigger "${name}" supplies no thread key; set \`thread\` on the agent.`,
      );
    }

    if (same && same.thread.source !== thread) {
      throw new Error(
        `Agent "${id}": cron triggers share one thread key; set the same \`thread\` on each.`,
      );
    }

    // The first cron's `session` and `message` apply to every tick.
    if (same && (own?.session || own?.message)) {
      throw new Error(
        `Agent "${id}": set \`session\` and \`message\` on the first cron trigger only; they apply to every tick.`,
      );
    }

    const session = cron ? own?.session : (config.session ?? own?.session);

    const condition = cron
      ? undefined
      : (own as ThreadEventTrigger | undefined)?.if;
    const cronOwn = cron ? (own as ThreadCronTrigger) : undefined;

    try {
      compiled.push({
        event: name,
        if: condition,
        asyncIf: condition ? toAsync(condition) : undefined,
        cron,
        listen: !cron && !invoked,
        fnTrigger: cronOwn
          ? {
              cron: cronOwn.cron,
              ...(cronOwn.jitter ? { jitter: cronOwn.jitter } : {}),
            }
          : {
              event: source as ThreadTriggerEventSource,
              ...(condition ? { if: condition } : {}),
            },
        schema: source instanceof EventType ? source.schema : undefined,
        thread: compileKey(thread),
        session: session ? compileKey(session) : undefined,
        message: own?.message as CompiledTrigger["message"],
      });
    } catch (err) {
      throw new Error(
        `Agent "${id}": the trigger "${name}": ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  return compiled;
}

/**
 * What is wrong with data against one schema, or `undefined` when it is fine.
 * A schema that throws counts as rejecting the data, so one bad schema or
 * event cannot fail the run on every replay.
 * @param schema The schema.
 * @param data The event's data.
 */
async function problemOf(
  schema: StandardSchemaV1,
  data: unknown,
): Promise<string | undefined> {
  try {
    const result = await schema["~standard"].validate(data ?? {});
    if (!result.issues) {
      return undefined;
    }

    return result.issues
      .map((issue) => {
        return issue.path && issue.path.length > 0
          ? `${issue.path.map(String).join(".")}: ${issue.message}`
          : issue.message;
      })
      .join(", ");
  } catch (error) {
    return `the schema threw: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Checks an event that reached a live run against the schemas of the triggers
 * it matched (an agent has one trigger per event name today, so this is one
 * schema; a list keeps the check right if that changes), the way core checks the event that starts a run: it is fine
 * when any matching trigger has no schema or accepts it. Resolves to what is
 * wrong with it, or `undefined` when it is fine.
 *
 * The check runs again when the run replays, with the schemas of the code
 * that is replaying. A schema changed while a run is live applies to the
 * messages that run reads after the change; deploy schema changes for new
 * runs.
 * @param triggers The compiled triggers whose event name the event has.
 * @param event The event.
 */
export async function schemaProblem(
  triggers: CompiledTrigger[],
  event: { data?: unknown },
): Promise<string | undefined> {
  if (triggers.length === 0 || triggers.some((trigger) => !trigger.schema)) {
    return undefined;
  }

  const problems: string[] = [];

  for (const trigger of triggers) {
    const problem = await problemOf(
      trigger.schema as StandardSchemaV1,
      event.data,
    );
    if (!problem) {
      return undefined;
    }

    problems.push(problem);
  }

  return problems.join("; ");
}

/**
 * The singleton key of an agent function: a message uses its `thread`, and
 * each trigger event its own expression.
 * @param triggers The compiled triggers.
 */
export function singletonKey(triggers: CompiledTrigger[]): string {
  return triggers.reduceRight((rest, trigger) => {
    return `event.name == ${literal(trigger.event)} ? (${trigger.thread.source}) : ${rest}`;
  }, "event.data.thread");
}

/**
 * The message a trigger event is, for the thread it belongs to.
 * @param ref The agent, as `"appId/functionId"`.
 * @param trigger The compiled trigger the event matched.
 * @param event The trigger event.
 */
export function messageOf(
  ref: string,
  trigger: CompiledTrigger,
  event: ThreadTriggerEvent,
): ThreadMessage {
  return {
    agent: ref,
    thread: trigger.thread.key(event),
    kind: "user",
    content: trigger.message?.({ ...event, data: event.data ?? {} }),
    event: { id: event.id, name: event.name, data: event.data },
  };
}
