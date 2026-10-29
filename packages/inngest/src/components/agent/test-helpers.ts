/**
 * @module
 * A fake executor for the subscription tests: runs a function request by
 * request and answers the subscription ops the way the executor does. Messages
 * are steps of the run named after the subscription, in the stack, as the
 * executor saves them.
 */
import { runFnWithStack } from "../../test/helpers.ts";
import { type OutgoingOp, StepOpCode } from "../../types.ts";
import { _internals } from "../execution/engine.ts";
import { subscriptionMessageIdPrefix } from "../execution/subscription.ts";
import type { InngestFunction } from "../InngestFunction.ts";

interface SubscribeOpts {
  key: string;
  mode: "open" | "park" | "poll" | "close";
  seq?: number;
}

/**
 * Runs `fn`. `incoming` are the events that arrive, in order, one for each
 * time the function blocks waiting for a message; once they run out, a wait
 * ends the run as `waiting`. `saved` are events that were already saved as
 * messages before the run read.
 */
export const run = async (
  fn: InngestFunction.Any,
  options: {
    event?: { name: string; data: Record<string, unknown> };
    key?: string;
    saved?: unknown[];
    incoming?: unknown[];

    /**
     * What a park is answered with instead of the usual wake, whatever the
     * state holds: `{ closed: true }` is how close() ends a park.
     */
    parkAnswer?: unknown;

    /**
     * How many parks that carry a timeout end unanswered before a message is
     * allowed to arrive.
     */
    timeouts?: number;
    onOp?: (op: OutgoingOp, saved: unknown[]) => void;
    /**
     * Called with each `step.run` step as it ran, metadata included.
     */
    onStep?: (op: OutgoingOp) => void;
  } = {},
) => {
  const key = options.key ?? "inbox";
  const prefix = subscriptionMessageIdPrefix(key);
  const incoming = [...(options.incoming ?? [])];
  let timeoutsLeft = options.timeouts ?? 0;
  const ops: { id: string; mode: string; seq?: number }[] = [];
  const saved: unknown[] = [];
  const stack: string[] = [];
  let state: Parameters<typeof runFnWithStack>[1] = {};

  // The executor saves a message as a step named after the event, holding the
  // whole event. A value that is not an event is the data of one.
  const save = (value: unknown) => {
    const id = `${prefix}${saved.length + 1}`;
    // An event, or a memo from before messages were flat ({ seq, data: event }),
    // is saved as it is.
    const isEvent =
      typeof value === "object" &&
      value !== null &&
      "data" in value &&
      ("name" in value || "seq" in value);
    const data = isEvent
      ? value
      : {
          id: `evt-${saved.length + 1}`,
          name: "msg",
          data: value,
          ts: 0,
          user: {},
        };

    saved.push(data);
    stack.push(id);
    state = { ...state, [id]: { id, data } };
  };

  const answer = (id: string, data: unknown) => {
    stack.push(id);
    state = { ...state, [id]: { id, data } };
  };

  for (const data of options.saved ?? []) {
    save(data);
  }

  for (let request = 0; request < 80; request++) {
    // A fresh copy per request: defer functions strip metadata from the event.
    const event = structuredClone(
      options.event ?? { name: "sub/run", data: {} },
    );
    const result = await runFnWithStack(fn, state, {
      event,
      events: [structuredClone(event)],
      stackOrder: [...stack],
    });
    const found =
      result.type === "step-ran"
        ? [result.step]
        : result.type === "steps-found"
          ? result.steps
          : [];

    if (result.type === "function-resolved") {
      return { ops, saved, output: result.data, waiting: false };
    }

    if (result.type === "function-rejected") {
      return { ops, saved, output: result.error, waiting: false };
    }

    for (const op of found) {
      if (op.id === _internals.hashId("complete")) {
        return { ops, saved, output: op.data, waiting: false };
      }

      const sub = (op.opts as { subscribe?: SubscribeOpts } | undefined)
        ?.subscribe;
      if (op.op === StepOpCode.StepPlanned) {
        // A planned step runs in a request of its own, as the executor does.
        const ran = await runFnWithStack(fn, state, {
          event: structuredClone(event),
          events: [structuredClone(event)],
          stackOrder: [...stack],
          runStep: op.id,
        });

        if (ran.type === "step-ran") {
          options.onStep?.(ran.step);
          state = {
            ...state,
            [op.id]: {
              id: op.id,
              data: ran.step.data,
              error: ran.step.error,
            },
          };
          stack.push(op.id);
        }

        continue;
      }

      if (op.op !== StepOpCode.WaitForEvent || !sub) {
        if (op.op === StepOpCode.StepRun) {
          options.onStep?.(op);
        }

        state = {
          ...state,
          [op.id]: { id: op.id, data: op.data, error: op.error },
        };
        stack.push(op.id);
        continue;
      }

      ops.push({ id: op.userland?.id ?? op.id, mode: sub.mode, seq: sub.seq });
      options.onOp?.(op, saved);

      if (sub.mode === "open") {
        answer(op.id, { opened: true });
      } else if (sub.mode === "close") {
        answer(op.id, { count: saved.length });
      } else if (sub.mode === "poll") {
        answer(op.id, saved[(sub.seq as number) - 1] ?? null);
      } else {
        if (options.parkAnswer !== undefined) {
          answer(op.id, options.parkAnswer);
          continue;
        }

        // A park with a timeout ends unanswered while timeouts are left.
        if (
          (sub as { timeout?: string }).timeout !== undefined &&
          timeoutsLeft > 0 &&
          saved.length < (sub.seq as number)
        ) {
          timeoutsLeft -= 1;
          answer(op.id, null);
          continue;
        }

        // next: the function is blocked until the message exists.
        while (saved.length < (sub.seq as number)) {
          if (incoming.length === 0) {
            return { ops, saved, output: undefined, waiting: true };
          }

          save(incoming.shift());
        }

        // The executor answers the wait with the ID of the message it waited for.
        if (saved.length >= (sub.seq as number)) {
          answer(op.id, `${prefix}${sub.seq}`);
        }
      }
    }
  }

  throw new Error("The function did not finish");
};
