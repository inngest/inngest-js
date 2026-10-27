/**
 * @module
 * A fake executor for the subscription tests: runs a function request by
 * request and answers the subscription ops the way the executor does.
 */
import { runFnWithStack } from "../../test/helpers.ts";
import { type OutgoingOp, StepOpCode } from "../../types.ts";
import { _internals } from "../execution/engine.ts";
import type { InngestFunction } from "../InngestFunction.ts";

interface SubscribeOpts {
  key: string;
  mode: "open" | "next" | "poll" | "ack" | "close";
  seq?: number;
}

/**
 * Runs `fn`. `incoming` are the events that arrive, in order, one for each
 * message the function waits for; once they run out, a wait ends the run as
 * `waiting`. `saved` are events that were already saved before the run read.
 */
export const run = async (
  fn: InngestFunction.Any,
  options: {
    event?: { name: string; data: Record<string, unknown> };
    saved?: unknown[];
    incoming?: unknown[];
    onOp?: (op: OutgoingOp, saved: unknown[]) => void;
  } = {},
) => {
  const saved = [...(options.saved ?? [])];
  const incoming = [...(options.incoming ?? [])];
  const ops: { id: string; mode: string; seq?: number }[] = [];
  const acked: number[] = [];
  let state: Parameters<typeof runFnWithStack>[1] = {};

  for (let request = 0; request < 80; request++) {
    const result = await runFnWithStack(fn, state, {
      event: options.event ?? { name: "sub/run", data: {} },
    });
    const found =
      result.type === "step-ran"
        ? [result.step]
        : result.type === "steps-found"
          ? result.steps
          : [];

    if (result.type === "function-resolved") {
      return { ops, acked, saved, output: result.data, waiting: false };
    }

    for (const op of found) {
      if (op.id === _internals.hashId("complete")) {
        return { ops, acked, saved, output: op.data, waiting: false };
      }

      const sub = (op.opts as { subscribe?: SubscribeOpts } | undefined)
        ?.subscribe;
      if (op.op !== StepOpCode.WaitForEvent || !sub) {
        state = { ...state, [op.id]: { id: op.id, data: op.data } };
        continue;
      }

      ops.push({ id: op.userland?.id ?? op.id, mode: sub.mode, seq: sub.seq });
      options.onOp?.(op, saved);
      let data: unknown;

      if (sub.mode === "open") {
        data = { opened: true };
      } else if (sub.mode === "ack") {
        acked.push(sub.seq as number);
        data = true;
      } else if (sub.mode === "close") {
        data = { count: saved.length };
      } else if (sub.mode === "poll") {
        data = saved[(sub.seq as number) - 1] ?? null;
      } else {
        // next
        if (saved.length < (sub.seq as number)) {
          if (incoming.length === 0) {
            return { ops, acked, saved, output: undefined, waiting: true };
          }
          saved.push(incoming.shift());
        }
        data = saved[(sub.seq as number) - 1];
      }

      state = { ...state, [op.id]: { id: op.id, data } };
    }
  }

  throw new Error("The function did not finish");
};
