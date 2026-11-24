/**
 * @module
 * EXPERIMENTAL: ends a question nobody answered. A model that asks with
 * `ask_agent` never waits, so this function waits for it: after the timeout it
 * answers the question with outcome `timed_out`, through the same path as a
 * real answer (the same event ID), so whichever comes first is the one the
 * asker keeps. An answer to the question cancels it. There is one per app.
 */

import type { Inngest } from "../../../components/Inngest.ts";
import type { InngestFunction } from "../../../components/InngestFunction.ts";
import { answerQuestion } from "../inbox/answer.ts";
import type { AgentAskTimeoutData } from "../inbox/events.ts";

/**
 * The function that answers a question `timed_out` once its time is up.
 */
export const askTimeoutFunction = (
  client: Inngest.Any,
): InngestFunction.Any => {
  return client.createFunction(
    {
      id: "agents-ask-timeout",
      cancelOn: [
        { event: "agent/answer", if: "async.data.re == event.data.id" },
      ],
      triggers: [{ event: "agent/ask.timeout" }],
    },
    async ({ event, step }) => {
      const data = event.data as AgentAskTimeoutData;

      await step.sleep("timeout", data.timeout);
      await answerQuestion(
        client,
        {
          data: {
            id: data.id,
            from: { kind: "agent", address: data.agent, key: data.thread },
          },
        },
        { outcome: "timed_out" },
      );
    },
  );
};
