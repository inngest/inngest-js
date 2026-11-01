/**
 * @module
 * A fake executor for the inbox tests: runs a function request by request and
 * answers the inbox ops the way the executor does. A message is a step of the
 * run in the stack, holding the event, the inbox it belongs to and the pauses
 * of the sources it came through.
 */
import { runFnWithStack } from "../../test/helpers.ts";
import { type OutgoingOp, StepOpCode } from "../../types.ts";
import { _internals } from "../execution/engine.ts";
import { hashedStepId, inboxKey } from "../execution/inboxState.ts";
import type { InngestFunction } from "../InngestFunction.ts";

interface Pause {
  id: string;
  event: string;
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
     * Steps the run already holds, by the ID the function gave them: the memos
     * of a run that started before the IDs changed.
     */
    memos?: Record<string, unknown>;

    /**
     * How many reads that carry a timeout end unanswered before a message is
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
  const root = hashedStepId(options.key ?? "inbox");
  const incoming = [...(options.incoming ?? [])];
  let timeoutsLeft = options.timeouts ?? 0;
  const ops: { id: string; op: string; opts: unknown }[] = [];
  const saved: unknown[] = [];
  const stack: string[] = [];
  const pauses: Pause[] = [];
  let state: Parameters<typeof runFnWithStack>[1] = {};

  // The executor saves a message as a step holding the event, the inbox and
  // the pauses of the sources that matched it. A value that is not an event is
  // the data of one.
  const save = (value: unknown) => {
    const n = saved.length + 1;
    const isEvent =
      typeof value === "object" &&
      value !== null &&
      "data" in value &&
      "name" in value;
    const event = isEvent
      ? { id: `evt-${n}`, ts: 0, user: {}, ...(value as object) }
      : { id: `evt-${n}`, name: "msg", data: value, ts: 0, user: {} };
    const name = (event as { name: string }).name;
    const matching = pauses.filter((pause) => {
      return pause.event === name;
    });
    const src = (matching.length > 0 ? matching : pauses.slice(0, 1)).map(
      (pause) => {
        return pause.id;
      },
    );
    const id = `message:${(event as { id: string }).id}`;
    const data = { data: event, [inboxKey]: root, src };

    saved.push(event);
    stack.push(id);
    state = { ...state, [id]: { id, data } };
  };

  const answer = (id: string, data: unknown) => {
    stack.push(id);
    state = { ...state, [id]: { id, data } };
  };

  for (const [stepId, data] of Object.entries(options.memos ?? {})) {
    answer(_internals.hashId(stepId), data);
  }

  // The root inbox has its sources before anything is saved, so saved messages
  // can name them. Its open is answered the first time it is reported.
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

      const opts = op.opts as Record<string, unknown> | undefined;

      if (op.op === StepOpCode.SubscribeRead) {
        continue;
      }

      if (op.op === StepOpCode.Subscribe) {
        const sources = (opts?.sources ?? []) as { event: string }[];
        const made = sources.map((source, i) => {
          return { id: `${op.id}:${i}`, event: source.event };
        });

        pauses.push(...made);
        ops.push({ id: op.userland?.id ?? op.id, op: "open", opts });
        options.onOp?.(op, saved);
        answer(op.id, {
          pauses: made.map((pause) => {
            return pause.id;
          }),
        });
        continue;
      }

      if (op.op === StepOpCode.SubscribeClose) {
        ops.push({ id: op.userland?.id ?? op.id, op: "close", opts });
        options.onOp?.(op, saved);
        answer(op.id, opts?.ids ?? []);
        continue;
      }

      if (op.op === StepOpCode.SubscribeWait) {
        ops.push({ id: op.userland?.id ?? op.id, op: "wait", opts });
        options.onOp?.(op, saved);

        // A read with a timeout ends unanswered while timeouts are left.
        if (opts?.timeout !== undefined && timeoutsLeft > 0) {
          timeoutsLeft -= 1;
          answer(op.id, null);
          continue;
        }

        // The run is blocked until a message arrives; the replay finds it.
        if (incoming.length === 0) {
          return { ops, saved, output: undefined, waiting: true };
        }

        save(incoming.shift());
        continue;
      }

      if (op.op === StepOpCode.StepRun) {
        options.onStep?.(op);
      }

      state = {
        ...state,
        [op.id]: { id: op.id, data: op.data, error: op.error },
      };
      stack.push(op.id);
    }
  }

  throw new Error("The function did not finish");
};

/**
 * The `data.text` of an inbox message (an `agent/message` or `agent/steer`),
 * or `undefined`.
 */
export const textOf = (
  message: { data: unknown } | null | undefined,
): string | undefined => {
  const text = (message?.data as { text?: unknown } | undefined)?.text;

  return typeof text === "string" ? text : undefined;
};

export { createWaitingReporter } from "./testing/reporter.ts";
