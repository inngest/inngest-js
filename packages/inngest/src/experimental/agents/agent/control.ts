/**
 * @module
 * EXPERIMENTAL: the run control of an agent: what the body spreads into
 * `agent.loop()` so a running turn takes steering messages, stops at its
 * budget and records its turns.
 */

import { inflightOf } from "../inbox/threadInbox.ts";
import type { AgentEvent, AgentTurn } from "../loop/loop.ts";
import { agentSteerEvent, type ThreadRecord } from "../threads/thread.ts";
import type { threadRecorder } from "../threads/threadState.ts";
import { budgetReason, type LimitState } from "./limits.ts";
import type {
  AgentBodyFields,
  AgentFunctionConfig,
  AgentMessage,
  OpenedInbox,
} from "./types.ts";

/**
 * The run control the body spreads into `agent.loop()`: steering, the budget,
 * the scores setting and the record of each turn.
 */
export const createControl = (options: {
  config: AgentFunctionConfig;
  steering: {
    take: () => Promise<AgentMessage[]>;
    keep: (messages: AgentMessage[]) => void;
  };
  named: Map<string, OpenedInbox>;
  limits: LimitState;
  scoring: boolean;
  recorder: ReturnType<typeof threadRecorder>;
  threadKey: string;
}): AgentBodyFields["control"] => {
  const { config, steering, named, limits, scoring, recorder, threadKey } =
    options;

  return {
    async steer() {
      const folded: AgentEvent[] = [];

      // Read everything that has arrived: steering messages and stops
      // apply to the turn that is running; messages for the next turn
      // stay unread in the inbox.
      const waiting: AgentMessage[] = [];

      for (const message of await steering.take()) {
        if (
          message.name === agentSteerEvent ||
          (config.foldMessages === "all" && inflightOf(message) !== undefined)
        ) {
          folded.push(message);
        } else {
          waiting.push(message);
        }
      }

      steering.keep(waiting);

      return folded;
    },
    inboxes() {
      return [...named.values()];
    },
    budget() {
      return budgetReason(limits);
    },
    scores: scoring,
    ...(config.limits?.price && { price: config.limits.price }),
    async recordTurn(turn: AgentTurn) {
      const next = await recorder.turn(turn, threadKey);

      return { usage: next.usage, restarts: next.restarts ?? 0 };
    },
    async onTurn(turn: AgentTurn) {
      // A turn recorded inside its step came back with the reply, also
      // on a replay. One from before that (or from a loop without
      // `recordTurn`) is recorded now.
      const recorded = turn.recorded as
        | { usage: ThreadRecord["usage"]; restarts: number }
        | undefined;
      const next = recorded
        ? recorder.observe(recorded)
        : await recorder.turn(turn);

      limits.used = { ...next.usage };
    },
  };
};
