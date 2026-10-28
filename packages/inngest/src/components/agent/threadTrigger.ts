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
 * The expression is CEL, in the subset of `cel.ts`, because the backend
 * evaluates it as written and the run evaluates it too. A JavaScript function
 * cannot be a thread key: the backend could not read it.
 */
import { compileKey, toAsync } from "./cel.ts";
import { agentMessageEvent, type ThreadMessage } from "./thread.ts";

/**
 * The trigger event, as `message` sees it.
 */
export interface ThreadTriggerEvent {
  id?: string;
  name: string;
  data: Record<string, unknown>;
}

/**
 * An event that talks to an agent. A trigger helper returns one of these with
 * `thread` filled in.
 */
export interface ThreadTrigger {
  /**
   * The event name. A plain name: no wildcard, and not `agent/message`.
   */
  event: string;

  /**
   * An expression the event must match, like the `if` of a trigger.
   */
  if?: string;

  /**
   * The thread key, a CEL expression over `event` that gives a string, such
   * as `event.data.channel + "/" + event.data.thread_ts`.
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
  message?: (event: ThreadTriggerEvent) => string | undefined;
}

/**
 * The thread options of an agent config.
 */
export interface ThreadKeyConfig {
  /**
   * The events that talk to the agent.
   */
  on?: ThreadTrigger | ThreadTrigger[];

  /**
   * The thread key expression, overriding the one the triggers supply. It is
   * needed for a trigger that supplies none. It is a CEL expression, not a
   * function.
   */
  thread?: string;

  /**
   * The session expression. Default: the thread key.
   */
  session?: string;
}

export interface CompiledTrigger {
  event: string;
  if?: string;
  asyncIf?: string;
  thread: ReturnType<typeof compileKey>;
  session?: ReturnType<typeof compileKey>;
  message?: ThreadTrigger["message"];
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
  const triggers = config.on ? [config.on].flat() : [];
  const names = new Set<string>();

  return triggers.map((trigger) => {
    if (trigger.event === agentMessageEvent || trigger.event.includes("*")) {
      throw new Error(
        `Agent "${id}": the trigger "${trigger.event}" must be a plain event name other than "${agentMessageEvent}".`,
      );
    }

    if (names.has(trigger.event)) {
      throw new Error(
        `Agent "${id}": two triggers on "${trigger.event}"; use one trigger per event name.`,
      );
    }
    names.add(trigger.event);

    const thread = config.thread ?? trigger.thread;
    if (!thread) {
      throw new Error(
        `Agent "${id}": the trigger "${trigger.event}" supplies no thread key; set \`thread\` on the agent.`,
      );
    }

    const session = config.session ?? trigger.session;

    try {
      return {
        event: trigger.event,
        if: trigger.if,
        asyncIf: trigger.if ? toAsync(trigger.if) : undefined,
        thread: compileKey(thread),
        session: session ? compileKey(session) : undefined,
        message: trigger.message,
      };
    } catch (err) {
      throw new Error(
        `Agent "${id}": the trigger "${trigger.event}": ${(err as Error).message}`,
        { cause: err },
      );
    }
  });
}

/**
 * The singleton key of an agent function: a message uses its `thread`, and
 * each trigger event its own expression.
 * @param triggers The compiled triggers.
 */
export function singletonKey(triggers: CompiledTrigger[]): string {
  return triggers.reduceRight((rest, trigger) => {
    return `event.name == ${JSON.stringify(trigger.event)} ? (${trigger.thread.source}) : ${rest}`;
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
    content: trigger.message?.(event),
    event: { id: event.id, name: event.name, data: event.data },
  };
}
