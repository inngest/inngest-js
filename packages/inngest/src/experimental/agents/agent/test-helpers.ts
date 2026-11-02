/**
 * @module
 * A fake executor for the inbox tests: runs a function request by request and
 * answers the inbox ops the way the executor does. A message is a step of the
 * run in the stack, holding the event, the inbox it belongs to and the pauses
 * of the sources it came through.
 */

import { _internals } from "../../../components/execution/engine.ts";
import {
  hashedStepId,
  inboxKey,
  isInboxMessage,
} from "../../../components/execution/inboxState.ts";
import type { InngestFunction } from "../../../components/InngestFunction.ts";
import { runFnWithStack } from "../../../test/helpers.ts";
import { type OutgoingOp, StepOpCode } from "../../../types.ts";

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
     * The run's ID, for a test that needs the run's lazy reads to be its own.
     */
    runId?: string;
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
  // The lazy reads that draw rows, which are not steps.
  const reads: string[] = [];
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
    // The executor saves a step once, however often the SDK reports its op.
    if (id in state) {
      return;
    }

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
      runId: options.runId,
    });
    const found =
      result.type === "step-ran"
        ? [result.step]
        : result.type === "steps-found"
          ? result.steps
          : [];

    if (result.type === "function-resolved") {
      return { ops, reads, saved, output: result.data, waiting: false };
    }

    if (result.type === "function-rejected") {
      return { ops, reads, saved, output: result.error, waiting: false };
    }

    for (const op of found) {
      if (op.id === _internals.hashId("complete")) {
        return { ops, reads, saved, output: op.data, waiting: false };
      }

      if (op.op === StepOpCode.StepPlanned) {
        // A planned step runs in a request of its own, as the executor does.
        const ran = await runFnWithStack(fn, state, {
          event: structuredClone(event),
          events: [structuredClone(event)],
          stackOrder: [...stack],
          runStep: op.id,
          runId: options.runId,
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
        reads.push(op.userland?.id ?? op.id);

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

        const batch = opts?.batch as
          | { drain?: boolean; unread?: boolean; room?: number }
          | undefined;
        const seen = String(opts?.seen ?? "");
        const want = opts?.want as
          | { events?: string[]; src?: string[] }
          | undefined;

        // The message steps saved after the step the read last saw that it
        // wants, as the executor finds them for a batch read.
        const since = () => {
          const after = stack.slice(seen === "" ? 0 : stack.indexOf(seen) + 1);
          const ids = after.filter((id) => {
            const value = state[id]?.data as
              | { data?: { name?: string }; src?: string[] }
              | undefined;

            return (
              isInboxMessage(value) &&
              (want?.events === undefined ||
                want.events.includes(value.data?.name ?? "")) &&
              (want?.src === undefined ||
                (value.src ?? []).some((pause) => {
                  return want.src?.includes(pause);
                }))
            );
          });

          return batch?.room === undefined ? ids : ids.slice(0, batch.room);
        };

        if (batch !== undefined) {
          const found = since();

          if (batch.drain || batch.unread || found.length > 0) {
            answer(op.id, { seen, ids: found });
            continue;
          }
        }

        // A read with a timeout ends unanswered while timeouts are left.
        if (opts?.timeout !== undefined && timeoutsLeft > 0) {
          timeoutsLeft -= 1;
          answer(op.id, null);
          continue;
        }

        // The run is blocked until a message arrives; the replay finds it.
        if (incoming.length === 0) {
          return { ops, reads, saved, output: undefined, waiting: true };
        }

        save(incoming.shift());

        if (batch !== undefined) {
          answer(op.id, { seen, ids: since() });
        }

        continue;
      }

      if (op.op === StepOpCode.StepRun) {
        options.onStep?.(op);
      }

      if (op.id in state) {
        continue;
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
