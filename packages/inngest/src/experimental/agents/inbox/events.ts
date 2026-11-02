/**
 * @module
 * EXPERIMENTAL: the events the agent layer sends and listens for, defined with
 * core's `eventType()` like any app event. A message built with
 * `.create()` is checked against its schema when it is sent, and a function
 * that triggers on one gets its `event.data` typed.
 *
 * Everything a thread receives is a plain event. `agent/message` carries text
 * for the model; `agent/steer` and `agent/recover` are the agent's own
 * control events, and shows up in the thread's inbox like any other.
 */
import {
  eventType,
  staticSchema,
} from "../../../components/triggers/triggers.ts";

/**
 * What every event sent to a thread carries, to route it.
 */
export type AgentRouting = {
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
 * The data of `agent/message`: text that starts the next turn.
 */
export type AgentMessageData = AgentRouting & {
  text: string;
};

/**
 * The data of `agent/recover`: the message a failed run was handling, sent
 * again when `recovery` is on so a fresh run takes it up. The inbox shows it
 * as the event it was made from, not as an `agent/recover`.
 */
export type AgentRecoverData = AgentRouting & {
  /**
   * The message the failed run was handling: its id, name and data as they
   * were sent.
   */
  event: { id?: string; name: string; data: unknown };
};

/**
 * The data of `agent/steer`: text folded into the turn that is running.
 */
export type AgentSteerData = AgentRouting & {
  text: string;
};

/**
 * Text that starts the next turn (and a run, if none is live).
 */
export const agentMessage = eventType("agent/message", {
  schema: staticSchema<AgentMessageData>(),
});

/**
 * Text folded into the turn that is running (and a run, if none is live).
 */
export const agentSteer = eventType("agent/steer", {
  schema: staticSchema<AgentSteerData>(),
});

/**
 * The message a failed run was handling, sent again by `recovery` (and by
 * nothing else), so a fresh run takes it up.
 */
export const agentRecover = eventType("agent/recover", {
  schema: staticSchema<AgentRecoverData>(),
});
