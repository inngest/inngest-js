/**
 * @module
 * EXPERIMENTAL: the events the agent layer sends and listens for, defined with
 * core's `eventType()` like any app event. A message built with
 * `.create()` is checked against its schema when it is sent, and a function
 * that triggers on one gets its `event.data` typed.
 *
 * Everything a thread receives is a plain event. `agent/message` carries text
 * for the model; `agent/steer`, `agent/stop` and `agent/request` are the
 * agent's own control events, and show up in the thread's inbox like any other.
 */
import { eventType, staticSchema } from "../triggers/triggers.ts";

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
 * An event the SDK sends again as `agent/message` when recovery resumes a
 * failed turn. The inbox shows it as the event it was, not as an
 * `agent/message`.
 */
export type AgentResendData = AgentRouting & {
  event: { id?: string; name: string; data: unknown };
};

/**
 * The data of `agent/steer`: text folded into the turn that is running.
 */
export type AgentSteerData = AgentRouting & {
  text: string;
};

/**
 * The data of `agent/stop`: a request to stop. `"nextTurn"` lets the running
 * model call finish.
 */
export type AgentStopData = AgentRouting & {
  when: "nextTurn";
};

/**
 * The data of `agent/request`: a question from another thread.
 */
export type AgentRequestData<TRequest = unknown> = AgentRouting & {
  /**
   * What the other thread asks.
   */
  payload: TRequest;

  /**
   * The signal the reply is sent to.
   */
  replyTo: string;

  /**
   * The key of the thread that asked, when it is a thread.
   */
  from?: string;
};

/**
 * Text that starts the next turn (and a run, if none is live).
 */
export const agentMessage = eventType("agent/message", {
  schema: staticSchema<AgentMessageData | AgentResendData>(),
});

/**
 * Text folded into the turn that is running (and a run, if none is live).
 */
export const agentSteer = eventType("agent/steer", {
  schema: staticSchema<AgentSteerData>(),
});

/**
 * A request to stop. A stop never starts a run, so stopping an idle thread
 * does nothing.
 */
export const agentStop = eventType("agent/stop", {
  schema: staticSchema<AgentStopData>(),
});

/**
 * A question from another thread, answered with `message.reply()`.
 */
export const agentRequest = eventType("agent/request", {
  schema: staticSchema<AgentRequestData>(),
});
