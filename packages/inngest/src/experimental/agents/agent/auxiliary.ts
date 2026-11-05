/**
 * @module
 * EXPERIMENTAL: the two helper functions an agent adds beside its own: the
 * cleanup that runs after every run, and the one that records how a run ended
 * and resumes a failed turn.
 */

import { createDefer } from "../../../components/DeferredFunction.ts";
import { getAsyncCtxSync } from "../../../components/execution/als.ts";
import type { Inngest } from "../../../components/Inngest.ts";
import type { InngestFunction } from "../../../components/InngestFunction.ts";
import {
  agentFinished,
  agentMessageResult,
  agentRecover,
  type MessageOutcome,
} from "../inbox/events.ts";
import { quote, type RawEvent } from "../inbox/threadInbox.ts";
import type { Json } from "../json.ts";
import { type Kv, kvHash } from "../kv/kv.ts";
import {
  cleanupThreadSandbox,
  type ThreadSandboxCleanup,
} from "../sandboxes/threadSandboxes.ts";
import { runEnded } from "../threads/ledger.ts";
import { closeThreadCopies } from "../threads/ledgerClient.ts";
import {
  agentMessageEvent,
  agentRecoverEvent,
  threadSessions,
} from "../threads/thread.ts";
import { markThreadIdle, recordEnd, runScore } from "../threads/threadState.ts";
import type { CompiledTrigger } from "../threads/threadTrigger.ts";
import { finishedNotice } from "./finishedRelay.ts";
import { finishedOf, turnInFlight } from "./recovery.ts";
import { signLedgerData } from "./relations.ts";
import { startData, startInflight } from "./startEvent.ts";
import type { AgentFunctionConfig } from "./types.ts";

/**
 * Ends this function run's ledger subscriptions, if it made any.
 */
const closeCopies = async (): Promise<void> => {
  const instance = getAsyncCtxSync()?.execution?.instance;

  if (instance) {
    await closeThreadCopies(instance).catch(() => undefined);
  }
};

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
  onLedger: () => boolean,
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

      try {
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

        // Each KV call is its own step. With the ledger a run's own keys live
        // in the run, so there is nothing to clear.
        if (!onLedger()) {
          await store.scope("run", runId).clear();
        }

        if (thread) {
          await markThreadIdle(store, ref, thread, runId, onLedger());
        }
      } finally {
        await closeCopies();
      }
    },
  );
};

/**
 * The IDs of the messages a run took whose senders wait for its result: the
 * message that started it, or the one a recovery resent.
 */
const senderIdsOf = (start: RawEvent): string[] => {
  if (start.name === agentMessageEvent) {
    return start.id ? [start.id] : [];
  }

  if (start.name === agentRecoverEvent) {
    const resent = (start.data as { event?: RawEvent }).event;

    return resent?.name === agentMessageEvent && resent.id ? [resent.id] : [];
  }

  return [];
};

/**
 * The function that runs when the executor reports that a run of the agent
 * ended. It writes the thread's `lastRun` for the agent and, with `recovery`
 * on, resends the turn that was in flight. The senders of the messages the run
 * took hear how it ended. With the ledger KV store the ledger stores the record
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
  onLedger: () => boolean,
): InngestFunction.Any => {
  const recovery = config.recovery === true;

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
          resume:
            ended.status === "failed" && recovery
              ? !ended.error?.nonRetriable
              : undefined,
        },
        // With the ledger the ledger stores it, from `agent/run.ended`.
        { persist: !onLedger() },
      );

      // Only a run that `recordEnd` marked as resumed is resumed: a late report
      // for an older run, after a newer one has ended, is not.
      const mine = last?.runId === runId ? last : undefined;
      const resumed =
        recovery && ended.status === "failed" && mine?.recovery === "resumed";

      // The sender of each message the run took hears how the run ended. A
      // run that recovery resumes reports when the resumed run ends.
      const messageIds = resumed
        ? []
        : [
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

      // With the ledger the end of a run goes to the thread's ledger, which
      // stores how it ended, and a run `start_agent` began is reported to its
      // starter, which knows which owed reports it took. One send for both.
      if (onLedger() && last) {
        const notice = finishedNotice(data);

        await step.sendEvent("run-ended", [
          runEnded.create(
            signLedgerData(client, runEnded.name, {
              thread: kvHash("thread", {
                env: client.env ?? "default",
                app: client.id,
                thread: message.thread,
              }),
              app: client.id,
              agent: ref,
              runId,
              last,
            }),
            { id: `ended-${runId}` },
          ),
          ...(notice
            ? [
                agentFinished.create(notice, {
                  id: `finished-${runId}`,
                  meta: { sessions: threadSessions(notice.thread) },
                }),
              ]
            : []),
        ]);
      }

      if (!resumed) {
        await closeCopies();

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

      if (!inflight || (!inflight.event && inflight.content === undefined)) {
        await closeCopies();

        return last;
      }

      await step.sendEvent(
        "recover-resend",
        agentRecover.create(
          // Signed, so a run takes the lend a resent start carries only from
          // a resend this app made.
          signLedgerData(client, agentRecover.name, {
            agent: ref,
            thread: message.thread,
            event: inflight.event ?? {
              ...(inflight.id !== undefined && { id: inflight.id }),
              name: agentMessageEvent,
              data: {
                agent: ref,
                thread: message.thread,
                content: inflight.content,
                ...(inflight.from !== undefined && { from: inflight.from }),
              },
            },
          }),
          {
            id: `recover-${runId}`,
            meta: { sessions: threadSessions(message.thread) },
          },
        ),
      );
      await closeCopies();

      return last;
    },
  );
};
