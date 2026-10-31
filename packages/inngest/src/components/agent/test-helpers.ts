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
import {
  subscriptionMessageIdPrefix,
  subscriptionMessagePrefix,
} from "../execution/subscription.ts";
import type { InngestFunction } from "../InngestFunction.ts";

interface SubscribeOpts {
  key: string;
  mode: "open" | "next" | "all" | "close" | "stop";
  timeout?: string;
  streams?: { stream: number; event: string; if?: string }[];
}

/**
 * Runs `fn`. `incoming` are the events that arrive, in order, one for each
 * time the function blocks waiting for a message; once they run out, a wait
 * ends the run as `waiting`. `saved` are events that were already saved as
 * messages before the run read, and `buffered` are events held in the inbox's
 * buffer, which an op flushes into steps.
 */
export const run = async (
  fn: InngestFunction.Any,
  options: {
    event?: { name: string; data: Record<string, unknown> };
    key?: string;
    saved?: unknown[];
    incoming?: unknown[];

    /**
     * Events the executor holds in the inbox's buffer when the run starts: they
     * are steps only once an op flushes them.
     */
    buffered?: unknown[];

    /**
     * Whether the inbox was closed by a limit before the run reads.
     */
    closed?: boolean;

    /**
     * Steps the run already holds, by the ID the function gave them: the memos
     * of a run that started before the IDs changed.
     */
    memos?: Record<string, unknown>;

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
  const closedId = `${subscriptionMessagePrefix}closed:${prefix.slice(subscriptionMessagePrefix.length, -1)}`;
  const incoming = [...(options.incoming ?? [])];
  let timeoutsLeft = options.timeouts ?? 0;
  const ops: { id: string; mode: string; streams?: number }[] = [];
  const buffer: unknown[] = [...(options.buffered ?? [])];
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

  for (const [stepId, data] of Object.entries(options.memos ?? {})) {
    answer(_internals.hashId(stepId), data);
  }

  for (const data of options.saved ?? []) {
    save(data);
  }

  // The executor flushes the buffer into steps, in arrival order.
  const flush = () => {
    for (const value of buffer.splice(0)) {
      save(value);
    }
  };

  if (options.closed) {
    answer(closedId, { limit: "test" });
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

      ops.push({
        id: op.userland?.id ?? op.id,
        mode: sub.mode,
        ...(sub.streams ? { streams: sub.streams.length } : {}),
      });
      options.onOp?.(op, saved);

      if (sub.mode === "open") {
        answer(op.id, { opened: true });
      } else if (sub.mode === "stop") {
        answer(op.id, { stopped: true });
      } else if (sub.mode === "all" || sub.mode === "close") {
        flush();
        answer(op.id, { total: saved.length });
      } else if (buffer.length > 0) {
        // next: what is buffered becomes steps, and the run is shown them.
        flush();
      } else if (options.closed) {
        // A closed inbox only shows the run its end.
      } else if (sub.timeout !== undefined && timeoutsLeft > 0) {
        // The timer won: null is saved under the op.
        timeoutsLeft -= 1;
        answer(op.id, null);
      } else if (incoming.length > 0) {
        // A message arrives while the op waits: a step, and a discovery.
        save(incoming.shift());
      } else {
        return { ops, saved, output: undefined, waiting: true };
      }
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
