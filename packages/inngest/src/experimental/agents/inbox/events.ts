/**
 * @module
 * EXPERIMENTAL: the events the agent layer sends and listens for, defined with
 * core's `eventType()` like any app event. A message built with
 * `.create()` is checked against its schema when it is sent, and a function
 * that triggers on one gets its `event.data` typed.
 *
 * Everything a thread receives is a plain event. `agent/message` carries text
 * for the model; `agent/question`, `agent/answer` and `agent/finished` carry
 * the asks and the ends of started runs; `agent/recover` is the agent's own
 * control event. All of them show up in the thread's inbox like any other.
 */
import {
  eventType,
  staticSchema,
} from "../../../components/triggers/triggers.ts";
import type { Renewal, WireGrant } from "../agent/grant.ts";
import type { Json } from "../json.ts";
import type { LentMachine } from "../sandboxes/defs.ts";
import type { ReportSchemas } from "./reports.ts";

/**
 * What a message carries under the reserved key `"::agents"` when it relies on
 * a grant: the grant, and a proof made for this event and target. A start
 * always carries it; a message sent to an unattached child by its starter may
 * carry a `renew`.
 */
export type GrantData = {
  grant?: WireGrant;
  pop?: string;
  renew?: Renewal;
};

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
   * On the message `start()` sends: the key of the thread it opens, and
   * whether the agent has an `invoke()` trigger, so `content` is that
   * trigger's data and the run's event has its shape. The limits, report
   * routes and lend it passes down are in the signed grant, under
   * `data["::agents"]`.
   */
  thread?: string;
  typed?: boolean;

  /**
   * On the message `start()` sends: the reports the agent owes, by type, with
   * the JSON Schema of each and whether it is owed. Where each goes is in the
   * grant.
   */
  reports?: ReportSchemas;

  /**
   * On the message `start()` or `start_agent` sends to an attached child:
   * the run ID of the parent. The child is cancelled by the `agent/parent.ended`
   * event of that run. The grant carries the same run ID, signed.
   */
  parent_run?: string;

  /**
   * On the message `start()` sends when it lends the child tools or sandboxes:
   * what is lent, by sandbox name. The grant holds a digest of it, so a child
   * refuses a `lent` that does not match.
   */
  lent?: Record<string, LentMachine>;
};

/**
 * The data of `agent/message`: what starts the next turn. `content` is text
 * or JSON.
 */
export type AgentMessageData = AgentRouting & {
  content: Json;
  from?: SenderData;
  "::agents"?: GrantData;
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

  /**
   * The app that made the resend and its signature over the data. A run
   * accepts a lend carried by a resent start only when the resend is signed.
   */
  by?: string;
  sig?: string;
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
  "::agents"?: GrantData;
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

  /**
   * Set on the report of an attached child that was stopped. A run that is
   * live on the thread reads it; it never starts a run, so a child cancelled
   * because its parent ended does not wake the parent's thread.
   */
  quiet?: true;

  /**
   * The names of the reports the run owed (`report.required()`) and finished
   * without sending. An empty list means every owed report was sent. The
   * starter's SDK sets it when the message reaches the starter's inbox: it
   * subtracts the reports it took from that child from the ones it owed. It
   * is not set when the child owed none.
   */
  missing?: string[];
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
 * The data of `agent/parent.ended`: the run that ended for good.
 */
export type AgentParentEndedData = {
  /**
   * The ID of the run that ended: completed, failed after its retries, or
   * cancelled.
   */
  run_id: string;
};

/**
 * Sent once when a run that started attached children ends for good. Each
 * attached child is cancelled by it, matched on its `parent_run`.
 */
export const agentParentEnded = eventType("agent/parent.ended", {
  schema: staticSchema<AgentParentEndedData>(),
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

/**
 * The data of `agent/group.joined`: a thread joined a group.
 */
export type AgentGroupJoinedData = {
  /**
   * The group's id, which every member's thread key carries. A live member
   * hears of a join through an inbox source filtered by it.
   */
  group: string;

  /**
   * The name the starter gave the group.
   */
  name: string;

  /**
   * The new member's agent, `"appId/functionId"`.
   */
  agent: string;

  /**
   * The new member's thread key, which the other members use to reach it.
   */
  thread: string;
};

/**
 * EXPERIMENTAL: tells the members of a group that a thread joined it. It is
 * sent once when `start()` or `start_agent` is given a `group`, not once per
 * member, and live members receive it through an inbox source that filters on
 * the group's id. It never starts a run.
 */
export const agentGroupJoined = eventType("agent/group.joined", {
  schema: staticSchema<AgentGroupJoinedData>(),
});
