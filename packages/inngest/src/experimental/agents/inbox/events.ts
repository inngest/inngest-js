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
 * Who sent a message, as it travels in `data.from`. An agent is its address
 * and the key of the thread that sent; a plain function is its ID and key.
 * `depth` is how many agents deep the chain that led here is, and `via` marks
 * a run a model started with `start_agent`, whose end is reported back to it
 * (`target` is the agent started and `thread` its thread); all of these are
 * internal and the public `Sender` leaves them out.
 */
export type SenderData = (
  | {
      kind: "agent";
      address: string;
      key: string;
      depth?: number;
      via?: "start_agent";
      target?: string;
    }
  | { kind: "function"; id: string; key: string; depth?: number }
) & {
  /**
   * On the message `start()` sends: the key of the thread it opens, the
   * limits it passes down, and whether the agent has an `invoke()` trigger,
   * so `content` is that trigger's data and the run's event has its shape.
   */
  thread?: string;
  limits?: unknown;
  typed?: boolean;
};

/**
 * The data of `agent/message`: what starts the next turn. `content` is text
 * or JSON.
 */
export type AgentMessageData = AgentRouting & {
  content: Json;
  from?: SenderData;
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
 * Text that starts the next turn (and a run, if none is live).
 */
export const agentMessage = eventType("agent/message", {
  schema: staticSchema<AgentMessageData>(),
});

/**
 * The data of `agent/question`: a question a waiting `ask()` or a model's
 * `ask_agent` sent. The sender is `data.from` when it is set.
 */
export type AgentQuestionData = AgentRouting & {
  from?: SenderData;
  /**
   * The question's ID. The answer's `re` is this value.
   */
  id: string;
  text: string;
};

/**
 * The data of `agent/answer`: how a question ended.
 */
export type AgentAnswerData = Partial<AgentRouting> & {
  /**
   * The ID of the question this answers.
   */
  re: string;

  /**
   * Who answered.
   */
  from?: SenderData;
} & (
    | { outcome: "answered"; text: string }
    | { outcome: "refused" | "timed_out" }
  );

/**
 * The data of `agent/finished`: how a run an agent started ended.
 */
export type AgentFinishedData = AgentRouting & {
  /**
   * The agent and thread that finished.
   */
  from?: SenderData;
} & (
    | { outcome: "completed"; output?: Json }
    | { outcome: "failed"; error: string }
    | { outcome: "stopped" }
  );

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

/**
 * The message a failed run was handling, sent again by `recovery` (and by
 * nothing else), so a fresh run takes it up.
 */
export const agentRecover = eventType("agent/recover", {
  schema: staticSchema<AgentRecoverData>(),
});

/**
 * The data of `agent/message.result`: how the run that took a message ended,
 * sent once for each message so its sender can match `async.data.id`.
 */
export type AgentMessageResultData = {
  /**
   * The ID of the message event this answers.
   */
  id: string;

  /**
   * The run that took the message.
   */
  run_id: string;
} & MessageOutcome;

/**
 * How the run that took a message ended.
 */
export type MessageOutcome =
  | { status: "completed"; output?: Json }
  | { status: "failed"; error: string }
  | { status: "stopped" };

/**
 * Tells the sender of a message how the run that took it ended.
 */
export const agentMessageResult = eventType("agent/message.result", {
  schema: staticSchema<AgentMessageResultData>(),
});

/**
 * The data of `agent/ask.timeout`: a question a model asked with `ask_agent`,
 * and the thread to tell when nobody answers it in time.
 */
export type AgentAskTimeoutData = AgentRouting & {
  /**
   * The question's ID.
   */
  id: string;

  /**
   * How long to wait for the answer, such as `"1h"`.
   */
  timeout: string;
};

/**
 * Starts the clock on a question a model asked. Internal: the function that
 * handles it sends the `timed_out` answer.
 */
export const agentAskTimeout = eventType("agent/ask.timeout", {
  schema: staticSchema<AgentAskTimeoutData>(),
});
