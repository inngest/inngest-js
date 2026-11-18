/**
 * @module
 * EXPERIMENTAL: the two helper functions an agent adds beside its own: the
 * cleanup that runs after every run, and the one that records how a run ended.
 */

import { createDefer } from "../../../components/DeferredFunction.ts";
import type { Inngest } from "../../../components/Inngest.ts";
import type { InngestFunction } from "../../../components/InngestFunction.ts";
import {
  agentFinished,
  agentMessageResult,
  type MessageOutcome,
} from "../inbox/events.ts";
import { quote, type RawEvent } from "../inbox/threadInbox.ts";
import type { Json } from "../json.ts";
import { type Kv, kvHash } from "../kv/kv.ts";
import {
  cleanupThreadSandbox,
  type ThreadSandboxCleanup,
} from "../sandboxes/threadSandboxes.ts";
import { agentMessageEvent, threadSessions } from "../threads/thread.ts";
import { obtainThreadState } from "../threads/threadClient.ts";
import { markThreadIdle, recordEnd } from "../threads/threadState.ts";
import type { CompiledTrigger } from "../threads/threadTrigger.ts";
import { finishedNotice } from "./finishedRelay.ts";
import { finishedOf } from "./recovery.ts";
import { startData, startInflight } from "./startEvent.ts";
import type { AgentFunctionConfig, StepWithSubscribe } from "./types.ts";

/**
 * The function that runs after every run of an agent ends, whichever way: it
 * saves and destroys a sandbox the run left open, clears the run's KV and marks
 * the thread idle.
 */
export const createCleanupFunction = (
  client: Inngest.Any,
  config: AgentFunctionConfig,
  ref: string,
  store: Kv,
): ReturnType<typeof createDefer> => {
  return createDefer(
    client,
    { id: `${config.id}-cleanup` },
    async ({ event, step }) => {
      const { runId, thread, sandbox } = event.data as {
        runId: string;
        thread?: string;
        sandbox?: ThreadSandboxCleanup;
      };

      // A sandbox of a run with no thread to keep it for is destroyed.
      if (sandbox && !thread) {
        await step.run(`${sandbox.name}:run:destroy`, async () => {
          const found = await client.sandboxes.get(sandbox.sandboxId);
          await found?.destroy();

          return null;
        });

        return;
      }

      // This run touches thread state - the thread's record, and a sandbox it
      // saves for the thread's next run - and a thread's state is held by its
      // holder, so it obtains the thread's handle first. After this,
      // `kv.thread` reads what this run holds and writes by sending the thread
      // an event.
      if (thread) {
        await obtainThreadState({
          client,
          step: step as unknown as StepWithSubscribe,
          ref,
          thread,
          runId: `cleanup:${runId}`,
        });
      }

      // A sandbox the run created and did not close: save it for the
      // thread's next run and destroy it.
      if (sandbox && thread) {
        await cleanupThreadSandbox({
          client: client as unknown as Parameters<
            typeof cleanupThreadSandbox
          >[0]["client"],
          ref,
          thread,
          runId,
          scope: store.scope("thread", thread),
          sandbox,
          run: (id, fn) => {
            return step.run(id, fn) as ReturnType<typeof fn>;
          },
        });

        return;
      }

      // A run's own keys are in a store of their own, so they are cleared
      // here: nothing else would, and they would outlive the run.
      await store.scope("run", runId).clear();

      if (thread) {
        await markThreadIdle(store, ref, thread, runId, true);
      }
    },
  );
};

/**
 * The IDs of the messages a run took whose senders wait for its result: the
 * message that started it.
 */
const senderIdsOf = (start: RawEvent): string[] => {
  return start.name === agentMessageEvent && start.id ? [start.id] : [];
};

/**
 * The function that runs when the executor reports that a run of the agent
 * ended. It writes the thread's `lastRun` for the agent. The senders of the
 * messages the run took hear how it ended. With the ledger KV store the ledger stores the record
 * of the end (`agent/run.ended`), and the end of a run `start_agent` began goes
 * to its starter as `agent/finished`, which the starter's SDK completes with
 * `missing`. With another store the `agents-finished` relay sends the latter.
 */
export const createFinishedFunction = (
  client: Inngest.Any,
  config: AgentFunctionConfig,
  ref: string,
  store: Kv,
  triggers: CompiledTrigger[],
): InngestFunction.Any => {
  // The executor reports every ending of a run (completed, failed, cancelled)
  // in one `inngest/function.finished` event with the status and the error.
  // A `defer` runs after each ending too, but carries no outcome, and
  // `onFailure` sees failures only.
  return client.createFunction(
    {
      id: `${config.id}-finished`,
      retries: 3,
      // A run reported twice (a batched or invoked run has several finished
      // events) is handled once.
      idempotency: "event.data.run_id",
      triggers: [
        {
          event: "inngest/function.finished",
          if: `event.data.function_id == ${quote(`${client.id}-${config.id}`)}`,
        },
      ],
    },
    async ({ event, step, logger }) => {
      const data = event.data as Record<string, unknown>;
      const start = ((data.events as RawEvent[] | undefined)?.[0] ??
        data.event) as RawEvent;
      const found = triggers.find((t) => {
        return t.event === start.name;
      });
      const message = startData(ref, found, start);
      const started = startInflight(found, start);
      const ended = finishedOf(data);
      const runId = String(data.run_id);

      // How a run ended is thread state, so this run obtains the thread's
      // handle before it writes it. The read reaches the holder, or starts one
      // if the thread has none, because a read is one of its triggers.
      await obtainThreadState({
        client,
        step: step as unknown as StepWithSubscribe,
        ref,
        thread: message.thread,
        runId: `finished:${runId}`,
      });

      // How the run ended is written first and whatever else happens next.
      const { last, record } = await recordEnd(
        store,
        ref,
        message.thread,
        {
          runId,
          at: event.ts ?? 0,
          finished: ended,
          inflight: started,
          turn: started !== undefined,
        },
        // The thread holds it: this run writes it there like any other write.
        { persist: true },
      );

      // The sender of each message the run took hears how the run ended.
      const messageIds = [
        ...senderIdsOf(start),
        ...(record.folded?.run === runId ? record.folded.ids : []),
      ];

      if (messageIds.length > 0) {
        const outcome: MessageOutcome =
          ended.status === "completed"
            ? { status: "completed", output: data.result as Json }
            : ended.status === "failed"
              ? {
                  status: "failed",
                  error: ended.error?.message ?? "unknown error",
                }
              : { status: "stopped" };

        await step.sendEvent(
          "message-results",
          messageIds.map((id) => {
            return agentMessageResult.create({ id, run_id: runId, ...outcome });
          }),
        );
      }

      // A run `start_agent` began is reported to its starter, which knows
      // which owed reports it took.
      const notice = finishedNotice(data);

      if (notice) {
        await step.sendEvent("run-ended", [
          agentFinished.create(notice, {
            id: `finished-${runId}`,
            meta: { sessions: threadSessions(notice.thread) },
          }),
        ]);
      }

      return last;
    },
  );
};
