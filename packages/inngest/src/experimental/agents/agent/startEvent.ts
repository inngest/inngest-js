/**
 * @module
 * EXPERIMENTAL: what a run's start event means: the trigger event as the body
 * sees it, the thread and agent data it carries and the turn it starts.
 */

import { internalEvents } from "../../../helpers/consts.ts";
import { reportWireEvent, routingOf } from "../inbox/reports.ts";
import { inflightOf } from "../inbox/threadInbox.ts";
import type { Json } from "../json.ts";
import type { Inflight, TriggerEvent } from "../threads/thread.ts";
import {
  type CompiledTrigger,
  startOf,
  type ThreadTriggerEvent,
} from "../threads/threadTrigger.ts";

/**
 * The trigger event as the body sees it. An invoke event carries what the SDK
 * tells the invoked agent in `data.from`; that is not the caller's input.
 */
export const triggerOf = (event: TriggerEvent | undefined) => {
  const data = event?.data as Record<string, unknown> | undefined;

  if (!event || !data || !("from" in data)) {
    return event;
  }

  const { from: _told, ...input } = data;

  return { ...event, data: input };
};

/**
 * What a run's start event carries: for an event of `triggers`, the agent, thread and
 * the event; otherwise the event's own data, which names the thread.
 */
export const startData = (
  ref: string,
  found: CompiledTrigger | undefined,
  event: { id?: string; name: string; data?: unknown },
) => {
  if (!found && event.name === reportWireEvent) {
    // A report names its agent and thread under the reserved key.
    return routingOf(event.data) as {
      agent: string;
      thread: string;
      event?: TriggerEvent;
      fresh?: true;
    };
  }

  return found
    ? startOf(ref, found, event as unknown as ThreadTriggerEvent)
    : (event.data as {
        agent: string;
        thread: string;
        event?: TriggerEvent;
        fresh?: true;
      });
};

/**
 * The turn a run's start event is, if it starts one.
 */
export const startInflight = (
  found: CompiledTrigger | undefined,
  event: { id?: string; name: string; data?: unknown },
): Inflight | undefined => {
  if (found) {
    return { event: { id: event.id, name: event.name, data: event.data } };
  }

  // An invoke of a plain agent is read as an `agent/message`.
  if (event.name === internalEvents.FunctionInvoked) {
    const content = (event.data as { content?: Json } | undefined)?.content;

    return content === undefined ? undefined : { content };
  }

  return inflightOf({ ...event, data: event.data });
};
