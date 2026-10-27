/**
 * @module
 * Test driver shared by the inbox tests: runs a function request by request
 * and answers doorbell waits.
 */
import { runFnWithStack } from "../../test/helpers.ts";
import { type OutgoingOp, StepOpCode } from "../../types.ts";
import { _internals } from "../execution/engine.ts";
import type { InngestFunction } from "../InngestFunction.ts";

/**
 * Runs `fn` request by request. `onWait` answers each doorbell wait: return
 * `true` for a ring and `false` for a timeout.
 */
export const run = async (
  fn: InngestFunction.Any,
  onWait: (op: OutgoingOp) => Promise<boolean>,
  event?: { name: string; data: Record<string, unknown> },
  onOp?: (op: OutgoingOp) => Promise<void>,
) => {
  const ran: string[] = [];
  let state: Parameters<typeof runFnWithStack>[1] = {};

  for (let request = 0; request < 40; request++) {
    const result = await runFnWithStack(fn, state, { event });
    const found =
      result.type === "step-ran"
        ? [result.step]
        : result.type === "steps-found"
          ? result.steps
          : [];

    if (result.type === "function-resolved") {
      return { ran, output: result.data };
    }

    for (const op of found) {
      if (op.id === _internals.hashId("complete")) {
        return { ran, output: op.data };
      }

      ran.push(op.userland?.id ?? op.id);
      await onOp?.(op);

      if (op.op === StepOpCode.Sleep) {
        state = { ...state, [op.id]: { id: op.id, data: null } };
        continue;
      }

      if (op.op === StepOpCode.WaitForSignal) {
        const rung = await onWait(op);
        state = {
          ...state,
          [op.id]: {
            id: op.id,
            data: rung ? { signal: "x", data: null } : null,
          },
        };
        continue;
      }

      state = { ...state, [op.id]: { id: op.id, data: op.data } };
    }
  }

  throw new Error("The function did not finish");
};

/**
 * Answers every doorbell wait with a timeout.
 */
export const noRing = async () => {
  return false;
};
