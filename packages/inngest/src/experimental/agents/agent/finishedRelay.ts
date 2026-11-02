/**
 * @module
 * EXPERIMENTAL: reports the end of a run a model started with `start_agent`.
 * The executor reports every ending of a run (completed, failed, cancelled)
 * in an `inngest/function.finished` event that carries the run's trigger
 * event, and `start_agent` marks its runs in that event's `data.from`. This
 * function turns each such ending into an `agent/finished` message for the
 * starter's thread, which starts a run there if the starter's run has ended.
 * It is driven by the platform's own terminal event, so no run's ending goes
 * unreported. There is one per app, whatever agent the run belonged to.
 */

import type { Inngest } from "../../../components/Inngest.ts";
import type { InngestFunction } from "../../../components/InngestFunction.ts";
import { agentFinished, type SenderData } from "../inbox/events.ts";
import type { RawEvent } from "../inbox/threadInbox.ts";
import type { Json } from "../json.ts";
import { threadSessions } from "../threads/thread.ts";
import { finishedOf } from "./recovery.ts";

/**
 * Runs `start_agent` began, in the trigger event the executor reports.
 */
const startedByTool = (path: string): string => {
  return `${path}.data.from.via == 'start_agent'`;
};

/**
 * The function that sends `agent/finished` when a run `start_agent` began
 * ends.
 */
export const agentFinishedFunction = (
  client: Inngest.Any,
): InngestFunction.Any => {
  return client.createFunction(
    {
      id: "agents-finished",
      retries: 3,
      idempotency: "event.data.run_id",
      triggers: [
        {
          event: "inngest/function.finished",
          if: `${startedByTool("event.data.event")} || ${startedByTool("event.data.events[0]")}`,
        },
      ],
    },
    async ({ event, step }) => {
      const data = event.data as Record<string, unknown>;
      const start = ((data.events as RawEvent[] | undefined)?.[0] ??
        data.event) as RawEvent | undefined;
      const from = (start?.data as { from?: SenderData } | undefined)?.from;

      if (from?.kind !== "agent" || from.via !== "start_agent") {
        return;
      }

      const child = {
        kind: "agent" as const,
        address: from.target ?? String(data.function_id),
        key: from.thread ?? "",
      };
      const ended = finishedOf(data);
      const outcome =
        ended.status === "failed"
          ? {
              outcome: "failed" as const,
              error: ended.error?.message ?? "unknown error",
            }
          : ended.status === "cancelled"
            ? { outcome: "stopped" as const }
            : {
                outcome: "completed" as const,
                ...(data.result !== undefined && {
                  output: data.result as Json,
                }),
              };

      await step.sendEvent(
        "agent-finished",
        agentFinished.create(
          { agent: from.address, thread: from.key, from: child, ...outcome },
          {
            id: `finished-${String(data.run_id)}`,
            meta: { sessions: threadSessions(from.key) },
          },
        ),
      );
    },
  );
};
