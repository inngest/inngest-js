/**
 * @module
 * EXPERIMENTAL: the two helper functions an agent adds beside its own: the
 * cleanup that runs after every run, and the one that records how a run ended
 * and resumes a failed turn.
 */

import { createDefer } from "../../../components/DeferredFunction.ts";
import type { Inngest } from "../../../components/Inngest.ts";
import type { InngestFunction } from "../../../components/InngestFunction.ts";
import { agentMessage } from "../inbox/events.ts";
import { quote, type RawEvent } from "../inbox/threadInbox.ts";
import type { kvFrom } from "../kv/kv.ts";
import {
  cleanupThreadSandbox,
  type ThreadSandboxCleanup,
} from "../sandboxes/threadSandboxes.ts";
import { threadSessions } from "../threads/thread.ts";
import { markThreadIdle, recordEnd, runScore } from "../threads/threadState.ts";
import type { CompiledTrigger } from "../threads/threadTrigger.ts";
import { type AgentRecovery, finishedOf, turnInFlight } from "./recovery.ts";
import { startData, startInflight } from "./startEvent.ts";
import type { AgentFunctionConfig } from "./types.ts";

/**
 * The function that runs after every run of an agent ends, whichever way: it
 * saves and destroys a sandbox the run left open, and clears the run's KV.
 */
export const createCleanupFunction = (
  client: Inngest.Any,
  config: AgentFunctionConfig,
  ref: string,
  store: ReturnType<typeof kvFrom>,
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

      // Each KV call is its own step.
      await store.scope("run", runId).clear();

      if (thread) {
        await markThreadIdle(store, thread, runId);
      }
    },
  );
};

/**
 * The function that runs when the executor reports that a run of the agent
 * ended: it writes the thread's `lastRun` and, with `recovery` on, resends the
 * turn that was in flight.
 */
export const createFinishedFunction = (
  client: Inngest.Any,
  config: AgentFunctionConfig,
  ref: string,
  store: ReturnType<typeof kvFrom>,
  triggers: CompiledTrigger[],
): InngestFunction.Any => {
  const recovery: AgentRecovery | undefined =
    config.recovery === true ? {} : config.recovery || undefined;

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

      // How the run ended is written first and whatever else happens next.
      const { last, record } = await recordEnd(store, message.thread, {
        runId,
        at: event.ts ?? 0,
        finished: ended,
        inflight: started,
        turn: started !== undefined,
        resume:
          ended.status === "failed" && recovery
            ? recovery.resume !== false && !ended.error?.nonRetriable
            : undefined,
      });
      if (!recovery || ended.status !== "failed") {
        return last;
      }

      // Only a run that `recordEnd` marked as resumed is resumed: a late report
      // for an older run, after a newer one has ended, is not.
      const mine = last?.runId === runId ? last : undefined;

      if (mine?.recovery !== "resumed") {
        return last;
      }

      const { inflight } = turnInFlight(
        record,
        runId,
        { inflight: started, turn: started !== undefined },
        (a, b) => {
          return runScore(a) < runScore(b);
        },
      );

      if (!inflight || (!inflight.event && inflight.text === undefined)) {
        return last;
      }

      await step.sendEvent(
        "recover-resend",
        agentMessage.create(
          {
            agent: ref,
            thread: message.thread,
            ...(inflight.event
              ? { event: inflight.event }
              : { text: inflight.text }),
          },
          {
            id: `recover-${runId}`,
            meta: { sessions: threadSessions(message.thread) },
          },
        ),
      );

      return last;
    },
  );
};
