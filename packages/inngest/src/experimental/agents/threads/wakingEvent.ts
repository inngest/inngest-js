/**
 * @module
 * EXPERIMENTAL: the event an agent run was woken by. A module of its own with
 * no imports that run, because it is read by modules the thread protocol's
 * own imports reach.
 */
import type { ThreadForwardData } from "./threadProtocol.ts";

/**
 * The name of `threadForward`, written out so this module imports nothing.
 */
const forwardName = "agent/thread.forward";

/**
 * EXPERIMENTAL: the event an agent run was woken by, as it was sent. A run
 * the thread's forward started has the forward as its event, which is the
 * thread's envelope: who sent the event, what it grants and what it asks for
 * are all in the first entry the forward carries. Any other event is itself.
 */
export const wakingEvent = <
  T extends { id?: string; name?: string; data?: unknown },
>(
  event: T,
): T | { id?: string; name: string; data: unknown; ts: number } => {
  if (event.name !== forwardName) {
    return event;
  }

  const first = (event.data as ThreadForwardData | undefined)?.events?.[0];

  return first
    ? {
        ...(first.id !== undefined && { id: first.id }),
        name: first.name,
        data: first.data,
        ts: first.ts,
      }
    : event;
};
