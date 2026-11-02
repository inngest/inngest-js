/**
 * @module
 * EXPERIMENTAL: what an agent gives the loops that run inside it: the inboxes
 * they fold from, the thread's budget and the record of each turn.
 */

import type { UntypedInboxMessage } from "../../../components/inbox/Inbox.ts";
import type { Reader } from "../inbox/threadInbox.ts";
import type { AgentEvent, AgentLoopWiring, AgentTurn } from "../loop/loop.ts";
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
  inbox: Pick<Reader<AgentEvent>, "drain">;

  /**
   * Reads an inbox the model opened with the agent's rules.
   */
  view: (inbox: OpenedInbox["inbox"]) => Reader<UntypedInboxMessage>;
  named: Map<string, OpenedInbox>;
  limits: LimitState;
  recorder: ReturnType<typeof threadRecorder>;
  threadKey: string;
}): AgentLoopWiring => {
  const { config, inbox, view, named, limits, recorder, threadKey } = options;

  return {
    async drain() {
      // The handler's inbox first, then each inbox the model opened, in the
      // order it opened them.
      const taken: AgentEvent[] = [...(await inbox.drain())];

      for (const open of [...named.values()]) {
        if (!open.inbox.closed) {
          taken.push(...(await view(open.inbox).drain()));
        }
      }

      return taken;
    },
    inboxes() {
      return [...named.values()].map((open) => {
        return { as: open.as, source: open.source };
      });
    },
    budget() {
      return budgetReason(limits);
    },
    ...(config.limits?.price && { price: config.limits.price }),
    async recordTurn(turn: AgentTurn) {
      const next = await recorder.turn(turn, threadKey);

      return { usage: next.usage, restarts: next.restarts ?? 0 };
    },
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
