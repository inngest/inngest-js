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
  mode: "open" | "poll" | "close" | "stop" | "current";
  seq?: number;
  stream?: number;
  streams?: { stream: number }[];
}

/**
 * Runs `fn`. `incoming` are the events that arrive, in order, one for each
 * time the function blocks waiting for a message (a request that reports only
 * waiting reads, which the next message runs again); once they run out, a wait
 * ends the run as `waiting`. The ops it records are the subscription ops the
 * executor answers, and `wait` for a read that ended its request waiting. `saved` are events that were already saved as
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
     * Answers an open the way an executor that predates many-source opens
     * does: without the count of streams it opened.
     */
    legacyExecutor?: boolean;

    /**
     * The subscription is closed (by a limit, or by a branch of the function)
     * when the function first blocks, instead of a message arriving.
     */
    closeWhenBlocked?: boolean;

    /**
     * Steps the run already holds, by the ID the function gave them: the memos
     * of a run that started before the IDs changed.
     */
    memos?: Record<string, unknown>;

    /**
     * How many timed waits end by their timer firing before a message is
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
  const ops: {
    id: string;
    mode: string;
    seq?: number;
    stream?: number;
    timeout?: string;
  }[] = [];
  const saved: unknown[] = [];
  // The steps the function asked to be planned instead of running them.
  const planned: string[] = [];
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

  const closedId = `inngest-sub:closed:${prefix.slice("inngest-sub:".length, -1)}`;

  for (let request = 0; request < 80; request++) {
    let blocked = false;
    let progressed = false;

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
      return { ops, saved, planned, output: result.data, waiting: false };
    }

    if (result.type === "function-rejected") {
      return { ops, saved, planned, output: result.error, waiting: false };
    }

    for (const op of found) {
      if (op.id === _internals.hashId("complete")) {
        return { ops, saved, planned, output: op.data, waiting: false };
      }

      const sub = (op.opts as { subscribe?: SubscribeOpts } | undefined)
        ?.subscribe;
      const waitId = op.userland?.id ?? op.id;

      // A read with nothing to read ends its request waiting.
      if (op.op === StepOpCode.None) {
        ops.push({ id: waitId, mode: "wait" });
        options.onOp?.(op, saved);
        blocked = true;
        continue;
      }

      // The timer of a timed wait.
      if (op.op === StepOpCode.Sleep && waitId.startsWith(`${key}:`)) {
        ops.push({ id: waitId, mode: "wait", timeout: op.name });
        options.onOp?.(op, saved);

        if (timeoutsLeft > 0) {
          timeoutsLeft -= 1;
          answer(op.id, null);
          progressed = true;
        } else {
          blocked = true;
        }
        continue;
      }

      if (op.op === StepOpCode.StepPlanned) {
        planned.push(op.userland?.id ?? op.id);
        // A planned step runs in a request of its own, as the executor does.
        const ran = await runFnWithStack(fn, state, {
          event: structuredClone(event),
          events: [structuredClone(event)],
          stackOrder: [...stack],
          runStep: op.id,
        });
        // Lazy ops (a defer) ride along, so the run step can come back with
        // them as steps found.
        const step =
          ran.type === "step-ran"
            ? ran.step
            : ran.type === "steps-found"
              ? ran.steps.find((found) => {
                  return found.id === op.id && found.op === StepOpCode.StepRun;
                })
              : undefined;
        if (step) {
          options.onStep?.(step);
          state = {
            ...state,
            [op.id]: {
              id: op.id,
              data: step.data,
              error: step.error,
            },
          };
          stack.push(op.id);
          progressed = true;
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

        // A defer rides along with every request: it is no progress.
        if (op.op !== StepOpCode.DeferAdd && op.op !== StepOpCode.DeferAbort) {
          progressed = true;
        }
        continue;
      }

      ops.push({
        id: op.userland?.id ?? op.id,
        mode: sub.mode,
        seq: sub.seq,
        ...(sub.stream ? { stream: sub.stream } : {}),
        ...(sub.streams ? { streams: sub.streams.length + 1 } : {}),
      });
      options.onOp?.(op, saved);

      progressed = true;

      if (sub.mode === "open") {
        answer(
          op.id,
          options.legacyExecutor
            ? { opened: true }
            : { opened: true, streams: 1 + (sub.streams?.length ?? 0) },
        );
      } else if (sub.mode === "close") {
        answer(closedId, true);
        answer(op.id, { count: saved.length });
      } else if (sub.mode === "stop") {
        answer(op.id, { stopped: true });
      } else if (sub.mode === "current") {
        answer(op.id, { count: saved.length });
      } else if (sub.mode === "poll") {
        answer(op.id, saved[(sub.seq as number) - 1] ?? null);
      }
    }

    // Every thread is waiting: the next message runs the function again.
    if (blocked && !progressed) {
      if (options.closeWhenBlocked && !stack.includes(closedId)) {
        answer(closedId, true);
        continue;
      }

      if (incoming.length === 0) {
        return { ops, saved, planned, output: undefined, waiting: true };
      }

      save(incoming.shift());
    }
  }

  throw new Error("The function did not finish");
};
