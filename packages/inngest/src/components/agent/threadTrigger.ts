/**
 * @module
 * EXPERIMENTAL: starting a thread from a trigger. An agent's `on` lists the
 * events that talk to it (a Slack message, a pull request comment). Each one
 * is turned into an `agent/message` for the thread its event belongs to, so
 * the first message of a thread starts a run and every later one reaches the
 * live run's inbox, through the singleton per thread the agent function
 * already has.
 *
 * The thread key is a JavaScript function of the trigger event, supplied by
 * the trigger (a helper for a vendor event knows how to derive it) or by the
 * agent's `thread` option, which wins. The turn into `agent/message` runs in
 * the SDK, so the key is stamped on the message (`data.thread` and the
 * `agent_thread` and `agent_session` entries of `meta.sessions`) where the
 * backend can read it. The singleton key never has to be an expression of the
 * vendor event, so a custom `thread` function needs no CEL.
 */

import type { Inngest } from "../Inngest.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import { NonRetriableError } from "../NonRetriableError.ts";
import { type ConfigValue, resolveConfigValue } from "./config.ts";
import {
  agentMessageEvent,
  type ThreadMessage,
  threadSessions,
} from "./thread.ts";

/**
 * The trigger event, as the thread functions see it.
 */
export interface ThreadTriggerEvent {
  id?: string;
  name: string;
  data: Record<string, unknown>;
}

/**
 * What a thread function receives.
 */
export interface ThreadKeyContext {
  event: ThreadTriggerEvent;
}

/**
 * An event that talks to an agent. A trigger helper returns one of these with
 * `thread` filled in.
 */
export interface ThreadTrigger {
  /**
   * The event name.
   */
  event: string;

  /**
   * An expression the event must match, like the `if` of a trigger.
   */
  if?: string;

  /**
   * The thread key of an event. Pure: it re-runs on replay.
   */
  thread?: (ctx: ThreadKeyContext) => string | Promise<string>;

  /**
   * The session the thread belongs to. Default: the thread key.
   */
  session?: (ctx: ThreadKeyContext) => string | Promise<string>;

  /**
   * The text of the message the event carries. Default: none; the body reads
   * the event itself from `data.event`.
   */
  message?: (ctx: ThreadKeyContext) => string | undefined;
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
   * The thread key of a trigger event. Overrides the key the triggers supply,
   * and is needed for a trigger that supplies none. A string is one thread.
   */
  thread?: ConfigValue<string, ThreadKeyContext>;

  /**
   * The session of a trigger event. Default: the thread key.
   */
  session?: ConfigValue<string, ThreadKeyContext>;
}

/**
 * The triggers of a config, as a list.
 * @param on The `on` option.
 */
export function triggersOf(on: ThreadKeyConfig["on"]): ThreadTrigger[] {
  if (!on) {
    return [];
  }

  return Array.isArray(on) ? on : [on];
}

/**
 * Creates the function that turns trigger events into thread messages, or
 * `undefined` when the agent has no `on`.
 * @param client Inngest client.
 * @param ref The agent, as `"appId/functionId"`.
 * @param id The agent's function ID.
 * @param config The thread options.
 */
export function createThreadStarter(
  client: Inngest.Any,
  ref: string,
  id: string,
  config: ThreadKeyConfig,
): InngestFunction.Any | undefined {
  const triggers = triggersOf(config.on);

  if (triggers.length === 0) {
    return undefined;
  }

  const names = new Set<string>();

  for (const trigger of triggers) {
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

    if (!config.thread && !trigger.thread) {
      throw new Error(
        `Agent "${id}": the trigger "${trigger.event}" supplies no thread key; set \`thread\` on the agent.`,
      );
    }
  }

  return client.createFunction(
    {
      id: `${id}-start`,
      triggers: triggers.map((trigger) => {
        return trigger.if
          ? { event: trigger.event, if: trigger.if }
          : { event: trigger.event };
      }),
    },
    async ({ event, step }) => {
      const ctx = { event: event as ThreadTriggerEvent };
      const trigger = triggers.find((t) => {
        return t.event === event.name;
      }) as ThreadTrigger;

      const thread = await resolveConfigValue(
        (config.thread ?? trigger.thread) as ConfigValue<
          string,
          ThreadKeyContext
        >,
        ctx,
      );
      const session = await resolveConfigValue(
        (config.session ?? trigger.session ?? thread) as ConfigValue<
          string,
          ThreadKeyContext
        >,
        ctx,
      );

      for (const [name, key] of [
        ["thread", thread],
        ["session", session],
      ] as const) {
        if (typeof key !== "string" || key === "") {
          throw new NonRetriableError(
            `Agent "${id}": the ${name} key of "${event.name}" must be a non-empty string.`,
          );
        }
      }

      if (!event.id) {
        throw new NonRetriableError(
          `Agent "${id}": the trigger event "${event.name}" has no id.`,
        );
      }

      const data: ThreadMessage = {
        agent: ref,
        thread,
        kind: "user",
        content: trigger.message?.(ctx),
        event: { id: event.id, name: event.name, data: event.data },
      };

      // The ID makes a retry, or the trigger delivered twice, one message.
      await step.sendEvent("deliver", {
        id: `${ref}:${thread}:${event.id}`,
        name: agentMessageEvent,
        data,
        meta: { sessions: threadSessions(thread, session) },
      });

      return { thread };
    },
  );
}
