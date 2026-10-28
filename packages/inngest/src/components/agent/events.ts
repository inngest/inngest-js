/**
 * @module
 * EXPERIMENTAL: the events the agent layer sends and listens for, defined with
 * core's `eventType()` like any app event. A message or a stop built with
 * `.create()` is checked against its schema when it is sent, and a function
 * that triggers on one gets its `event.data` typed.
 */
import { eventType, staticSchema } from "../triggers/triggers.ts";
import type { ThreadMessage } from "./thread.ts";

/**
 * What an `agent/thread.stop` event carries in `data`.
 */
export type ThreadStop = {
  /**
   * The agent, as `"appId/functionId"`.
   */
  agent: string;

  /**
   * The thread key.
   */
  thread: string;
};

/**
 * The event every thread message is sent as.
 */
export const agentMessage = eventType("agent/message", {
  schema: staticSchema<ThreadMessage>(),
});

/**
 * The event that cancels a thread's live run.
 */
export const agentStop = eventType("agent/thread.stop", {
  schema: staticSchema<ThreadStop>(),
});
