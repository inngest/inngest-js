/**
 * @module
 * EXPERIMENTAL: who a message is from, read from the running function: an agent
 * is its address and the key of its thread; any other function is its run.
 */

import type { getAsyncCtxSync } from "../../../components/execution/als.ts";
import type { SenderData } from "../inbox/events.ts";

/**
 * The execution a sender is read from.
 */
type Execution = NonNullable<ReturnType<typeof getAsyncCtxSync>>["execution"];

/**
 * The sender of what the running function sends. `depth` is the chain depth
 * the receiver runs at: one deeper than the sender.
 * @param execution The running function's execution.
 */
export const senderOf = (
  execution: NonNullable<Execution>,
): Extract<SenderData, { depth?: number }> => {
  const { ctx } = execution;
  const parent = (ctx.event as { data?: { from?: { depth?: unknown } } }).data
    ?.from;
  const depth = typeof parent?.depth === "number" ? parent.depth : 0;
  const self = execution.agent;

  return self?.ref
    ? {
        kind: "agent",
        address: self.ref,
        key: self.thread,
        depth: depth + 1,
      }
    : {
        kind: "function",
        id: ctx.runId as string,
        key: ctx.runId as string,
        depth: depth + 1,
      };
};
