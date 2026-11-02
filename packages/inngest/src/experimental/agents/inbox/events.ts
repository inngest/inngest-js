/**
 * @module
 * EXPERIMENTAL: the events the agent layer sends and listens for, defined with
 * core's `eventType()` like any app event. A message built with
 * `.create()` is checked against its schema when it is sent, and a function
 * that triggers on one gets its `event.data` typed.
 *
 * Everything a thread receives is a plain event. `agent/message` carries text
 * for the model; `agent/steer` is the agent's own
 * control event, and shows up in the thread's inbox like any other.
 */
import {
  eventType,
  staticSchema,
} from "../../../components/triggers/triggers.ts";
import type { Json } from "../json.ts";

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
 * The data of `agent/question`: a question a waiting `ask()` or a model's
 * `ask_agent` sent. The sender is `data.from` when it is set.
 */
export type AgentQuestionData = {
  /**
   * The question's ID. The answer's `re` is this value.
   */
  id: string;
  text: string;
};

/**
 * The data of `agent/answer`: how a question ended.
 */
export type AgentAnswerData = {
  /**
   * The ID of the question this answers.
   */
  re: string;
} & (
  | { outcome: "answered"; text: string }
  | { outcome: "refused" | "timed_out" }
);

/**
 * The data of `agent/finished`: how a run an agent started ended.
 */
export type AgentFinishedData =
  | { outcome: "completed"; output?: Json }
  | { outcome: "failed"; error: string }
  | { outcome: "stopped" };

/**
 * A question for an agent's inbox, answered with `msg.reply(answer)`.
 */
export const agentQuestion = eventType("agent/question", {
  schema: staticSchema<AgentQuestionData>(),
});

/**
 * The answer to an `agent/question`, or the word that there will not be one.
 */
export const agentAnswer = eventType("agent/answer", {
  schema: staticSchema<AgentAnswerData>(),
});

/**
 * How a run an agent started ended.
 */
export const agentFinished = eventType("agent/finished", {
  schema: staticSchema<AgentFinishedData>(),
});
