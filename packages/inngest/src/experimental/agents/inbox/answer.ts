/**
 * @module
 * EXPERIMENTAL: answering an `agent/question`. One function owns it for every
 * way to answer (`msg.reply()` on a folded question and the model's `reply`
 * tool): where the answer goes, and that only the first answer counts.
 *
 * The answer is sent with the event ID `answer:<question id>`. The executor
 * delivers events that share an ID to inboxes all the same, so the receiver
 * keeps the rule: a waiting `ask()` closes its private inbox on the first
 * answer, and a model agent drops an `agent/answer` whose question it no
 * longer has open.
 */

import { getAsyncCtxSync } from "../../../components/execution/als.ts";
import type { Inngest } from "../../../components/Inngest.ts";
import { step } from "../../../components/InngestStepTools.ts";
import { threadSessions } from "../threads/thread.ts";
import { agentAnswer, type SenderData } from "./events.ts";

/**
 * The question being answered: its id and who asked.
 */
export interface QuestionRef {
  data: {
    /**
     * The question's ID.
     */
    id: string;

    /**
     * The question's text.
     */
    text?: string;

    /**
     * The asker. Without one the answer cannot be routed.
     */
    from?: SenderData;
  };
}

/**
 * What the answerer says: the text of an answer, or that there is none.
 */
export type Answer =
  | { text: string }
  | { outcome: "refused" | "timed_out"; text?: undefined };

/**
 * The ID of the event that carries a question's answer.
 * @param questionId The question's ID.
 */
export const answerEventId = (questionId: string): string => {
  return `answer:${questionId}`;
};

/**
 * Answers a question. Inside a function it is a step, so a replay sends it
 * once. An answer for an agent goes to that agent's thread; an answer for a
 * plain function carries only the question's ID, which its `ask()` waits on.
 * @param client Inngest client.
 * @param question The question message: its ID and sender.
 * @param answer The answer, or that there is none.
 */
export async function answerQuestion(
  client: Inngest.Any,
  question: QuestionRef,
  answer: Answer,
): Promise<void> {
  const asker = question.data.from;
  const routing =
    asker?.kind === "agent" ? { agent: asker.address, thread: asker.key } : {};
  const event = agentAnswer.create(
    {
      ...routing,
      re: question.data.id,
      ...("outcome" in answer && answer.outcome
        ? { outcome: answer.outcome }
        : { outcome: "answered" as const, text: answer.text as string }),
    } as Parameters<typeof agentAnswer.create>[0],
    {
      id: answerEventId(question.data.id),
      ...(asker?.kind === "agent" && {
        meta: { sessions: threadSessions(asker.key) },
      }),
    },
  );
  const execution = getAsyncCtxSync()?.execution;

  if (execution && !execution.executingStep) {
    await step.sendEvent(answerEventId(question.data.id), event);

    return;
  }

  await client.send(event);
}
