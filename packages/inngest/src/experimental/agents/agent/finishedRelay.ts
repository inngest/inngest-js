/**
 * @module
 * EXPERIMENTAL: reports the end of a run a model started with `start_agent`.
 * The executor reports every ending of a run (completed, failed, cancelled)
 * in an `inngest/function.finished` event that carries the run's trigger
 * event, and `start_agent` marks its runs in that event's `data.from`. This
 * function turns each such ending into an `agent/finished` message for the
 * starter's thread, which starts a run there if the starter's run has ended
 * (except for an attached child that was stopped: that report never starts
 * one).
 * It is driven by the platform's own terminal event, so no run's ending goes
 * unreported. There is one per app, whatever agent the run belonged to.
 *
 * It is served only when the app has a KV store. With the ledger, each
 * agent's finished function sends `agent/finished` (see `auxiliary.ts`), and
 * this function would send a second message for the same ending.
 *
 * Neither sets `missing`: the starter's SDK does, from the reports it took.
 */

import type { Inngest } from "../../../components/Inngest.ts";
import type { InngestFunction } from "../../../components/InngestFunction.ts";
import {
  type AgentFinishedData,
  agentFinished,
  type SenderData,
} from "../inbox/events.ts";
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
 * The first event of a run, as the executor reports it in
 * `inngest/function.finished`.
 */
export const startOfFinished = (
  data: Record<string, unknown>,
): RawEvent | undefined => {
  return ((data.events as RawEvent[] | undefined)?.[0] ?? data.event) as
    | RawEvent
    | undefined;
};

/**
 * The `agent/finished` a run `start_agent` began ends with, from its
 * `inngest/function.finished` data, or `undefined` for any other run. The
 * starter's SDK adds `missing` when it takes the message in.
 * @param data The data of the `inngest/function.finished` event.
 */
export const finishedNotice = (
  data: Record<string, unknown>,
): AgentFinishedData | undefined => {
  const start = startOfFinished(data);
  const from = (start?.data as { from?: SenderData } | undefined)?.from;

  if (from?.kind !== "agent" || from.via === undefined) {
    return undefined;
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

  // An attached child that was stopped may have been cancelled because its
  // parent's run ended: the report is for a live run only and never starts
  // one on the parent's thread.
  const quiet = from.parent_run !== undefined && outcome.outcome === "stopped";

  return {
    agent: from.address,
    thread: from.key,
    from: child,
    ...outcome,
    ...(quiet && { quiet: true as const }),
  };
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
      const notice = finishedNotice(data);

      if (!notice) {
        return;
      }

      await step.sendEvent(
        "agent-finished",
        agentFinished.create(notice, {
          id: `finished-${String(data.run_id)}`,
          meta: { sessions: threadSessions(notice.thread) },
        }),
      );
    },
  );
};
