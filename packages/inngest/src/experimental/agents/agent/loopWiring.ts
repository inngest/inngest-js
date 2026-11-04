/**
 * @module
 * EXPERIMENTAL: what an agent gives the loops that run inside it: the inboxes
 * they fold from, the thread's budget and the record of each turn.
 */

import { getAsyncCtxSync } from "../../../components/execution/als.ts";
import type { UntypedInboxMessage } from "../../../components/inbox/Inbox.ts";
import type { QuestionBook } from "../inbox/questionBook.ts";
import { owedReports, type ReportBook } from "../inbox/reports.ts";
import type { Reader } from "../inbox/threadInbox.ts";
import type { AgentEvent, AgentLoopWiring, AgentTurn } from "../loop/loop.ts";
import { closesCopies } from "../threads/ledgerClient.ts";
import type { ThreadRecord } from "../threads/thread.ts";
import type { threadRecorder } from "../threads/threadState.ts";
import { budgetReason, type LimitState } from "./limits.ts";
import type { AgentFunctionConfig, OpenedInbox } from "./types.ts";

/**
 * The wiring of one run: a loop in it folds the handler's inbox and every inbox
 * the model opened, keeps to the thread's budget and records each turn.
 */
export const createLoopWiring = (options: {
  config: AgentFunctionConfig;

  /**
   * The handler's own inbox.
   */
  inbox: Pick<Reader<AgentEvent>, "drain" | "~fold">;

  /**
   * Reads an inbox the model opened with the agent's rules.
   */
  view: (inbox: OpenedInbox["inbox"]) => Reader<UntypedInboxMessage>;
  named: Map<string, OpenedInbox>;
  limits: LimitState;
  recorder: ReturnType<typeof threadRecorder>;
  threadKey: string;

  /**
   * The questions of this run.
   */
  questions: QuestionBook;

  /**
   * Whether the loops of this run remember the thread's history.
   */
  remember: boolean;

  /**
   * The ID of the event that started the run. The loop never folds it in by
   * itself: the handler passes it, or passes its own input instead.
   */
  triggerId?: string;

  /**
   * The reports the run was started with, if any.
   */
  reports?: ReportBook;

  /**
   * The agent, as `"appId/functionId"`: its history is its own on the thread.
   */
  agent: string;

  /**
   * Whether a turn is recorded inside its model step (a store), so a replay
   * does not write it again. The ledger cannot be written inside a step: the
   * turn is recorded after it.
   */
  recordInStep?: boolean;
}): AgentLoopWiring => {
  // The agent function closes the run's thread copies on every way out of the
  // body, so they may keep a background reader from here on.
  const instance = getAsyncCtxSync()?.execution?.instance;

  if (instance) {
    closesCopies(instance);
  }

  const {
    config,
    inbox,
    view,
    named,
    limits,
    recorder,
    threadKey,
    questions,
    remember,
    triggerId,
    reports,
    agent,
    recordInStep = true,
  } = options;

  return {
    remember,
    agent,
    async drain({ turn }) {
      // The handler's inbox first, then each inbox the model opened, in the
      // order it opened them. The run's trigger is the handler's to give.
      const taken: AgentEvent[] = (
        await (inbox["~fold"]?.(turn) ?? inbox.drain())
      ).filter((event) => {
        return !triggerId || event.id !== triggerId;
      });

      for (const open of [...named.values()]) {
        if (!open.inbox.closed) {
          taken.push(...(await view(open.inbox).drain()));
        }
      }

      // An answer is shown once; a second or late one is dropped.
      return taken.filter((event) => {
        return questions.admit(event);
      });
    },
    async owed() {
      return owedReports(reports);
    },
    answered(id: string) {
      return questions.isReplied(id);
    },
    questions() {
      return questions.texts();
    },
    inboxes() {
      return [...named.values()].map((open) => {
        return { as: open.as, source: open.source };
      });
    },
    budget() {
      return budgetReason(limits);
    },
    ...(config.price && { price: config.price }),
    ...(recordInStep && {
      async recordTurn(turn: AgentTurn) {
        const next = await recorder.turn(turn, threadKey);

        return { usage: next.usage, restarts: next.restarts ?? 0 };
      },
    }),
    async observeTurn(turn: AgentTurn, recorded: unknown) {
      // A turn recorded inside its step came back with the reply, also on a
      // replay. One from before that is recorded now.
      const kept = recorded as
        | { usage: ThreadRecord["usage"]; restarts: number }
        | undefined;
      const next = kept ? recorder.observe(kept) : await recorder.turn(turn);

      limits.used = { ...next.usage };
    },
  };
};
