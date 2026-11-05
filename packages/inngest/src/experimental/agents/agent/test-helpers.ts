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
import { runFnWithStack, testClientId } from "../../../test/helpers.ts";
import { type OutgoingOp, StepOpCode } from "../../../types.ts";
import { type Kv, kv, memoryKvAdapter, setAppKvStore } from "../kv/kv.ts";

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
     * Messages that arrive while a step runs (`during`, so before its
     * result is saved) or just after it (`after`), by the ID the function
     * gave the step.
     */
    arrive?: { event: unknown; at: string; when?: "during" | "after" }[];

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
    // The inbox a message belongs to is the one that opened the pause it
    // matched; a message no pause wants goes to the root inbox.
    const owner = matching[0]?.id.split(":")[0] ?? root;
    const data = { data: event, [inboxKey]: owner, src };

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

  // Reads and sleeps that wait beside the run's other work.
  const pendingWaits = new Map<string, OutgoingOp>();
  const loggedWaits = new Set<string>();
  const arrivals = [...(options.arrive ?? [])];

  // The message steps saved after the step a read last saw that it wants, as
  // the executor finds them for a batch read.
  const sinceOf = (op: OutgoingOp) => {
    const opts = op.opts as Record<string, unknown> | undefined;
    const batch = opts?.batch as { max?: number } | undefined;
    const seen = String(opts?.seen ?? "");
    const want = opts?.want as
      | { events?: string[]; src?: string[] }
      | undefined;
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

    return batch?.max === undefined ? ids : ids.slice(0, batch.max);
  };

  // A message arrives: it is saved, and the first read waiting for one is
  // answered with it. An event that arrives before any inbox of the run
  // listens for it matches no pause, so the executor saves nothing.
  const arriveNow = (value: unknown) => {
    const name = (value as { name?: unknown } | null)?.name;

    if (
      typeof name === "string" &&
      !pauses.some((pause) => {
        return pause.event === name;
      })
    ) {
      return;
    }

    save(value);

    for (const [id, op] of pendingWaits) {
      const opts = op.opts as Record<string, unknown> | undefined;

      if (opts?.batch === undefined) {
        // The replay of a plain read finds the message in the stack.
        pendingWaits.delete(id);

        return;
      }

      const ids = sinceOf(op);

      if (ids.length > 0) {
        pendingWaits.delete(id);
        answer(id, { cut: ids.at(-1) ?? null });

        return;
      }
    }
  };

  // The messages that arrive at a step, while it runs or just after it.
  const arriveAt = (stepName: string, when: "during" | "after") => {
    for (const arrival of [...arrivals]) {
      if (arrival.at === stepName && (arrival.when ?? "during") === when) {
        arrivals.splice(arrivals.indexOf(arrival), 1);
        arriveNow(arrival.event);
      }
    }
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
    const stackBefore = stack.length;
    let retried = false;

    if (result.type === "function-resolved") {
      return {
        ops,
        reads,
        saved,
        output: result.data,
        error: undefined as unknown,
        waiting: false,
      };
    }

    if (result.type === "function-rejected") {
      return {
        ops,
        reads,
        saved,
        output: result.error,
        error: result.error as unknown,
        waiting: false,
      };
    }

    for (const op of found) {
      if (op.id === _internals.hashId("complete")) {
        return {
          ops,
          reads,
          saved,
          output: op.data,
          error: op.error as unknown,
          waiting: false,
        };
      }

      if (op.op === StepOpCode.StepPlanned) {
        const stepName = op.userland?.id ?? op.id;

        // A message that arrives while the step runs is saved before the
        // step's result.
        arriveAt(stepName, "during");

        // A planned step runs in a request of its own, as the executor does.
        const ran = await runFnWithStack(fn, state, {
          event: structuredClone(event),
          events: [structuredClone(event)],
          stackOrder: [...stack],
          runStep: op.id,
          runId: options.runId,
        });

        // A step's result comes back as a `steps-found` when lazy ops (a
        // `defer`) ride along with it.
        const result =
          ran.type === "step-ran"
            ? ran.step
            : ran.type === "steps-found"
              ? ran.steps.find((candidate) => {
                  return candidate.id === op.id;
                })
              : undefined;

        if (result?.op === StepOpCode.StepError) {
          // A failed attempt that will be retried: nothing is saved, and the
          // next request replays the run and tries the step again.
          retried = true;
        } else if (result) {
          options.onStep?.(result);
          state = {
            ...state,
            [op.id]: {
              id: op.id,
              data: result.data,
              error: result.error,
            },
          };
          stack.push(op.id);
        }

        arriveAt(stepName, "after");

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
        if (!loggedWaits.has(op.id)) {
          loggedWaits.add(op.id);
          ops.push({ id: op.userland?.id ?? op.id, op: "wait", opts });
          options.onOp?.(op, saved);
        }

        const batch = opts?.batch as
          | { drain?: boolean; unread?: boolean; max?: number }
          | undefined;

        if (batch !== undefined) {
          let found = sinceOf(op);

          // The unread messages the SDK holds are before the step it saw, so
          // with none since, the cut covers every message of the inbox.
          if (found.length === 0 && batch.unread) {
            found = sinceOf({
              ...op,
              opts: { ...opts, seen: "", batch: { ...batch, max: undefined } },
            } as OutgoingOp);
          }

          if (batch.drain || batch.unread || found.length > 0) {
            answer(op.id, { cut: found.at(-1) ?? null });
            pendingWaits.delete(op.id);
            continue;
          }
        }

        // A read with a timeout ends unanswered while timeouts are left.
        if (opts?.timeout !== undefined && timeoutsLeft > 0) {
          timeoutsLeft -= 1;
          answer(op.id, null);
          continue;
        }

        // The read waits beside the run's other work. A message arrives when
        // nothing else can happen; the replay finds it.
        pendingWaits.set(op.id, op);

        continue;
      }

      // A step that ran in this request, with nothing beside it to plan. A
      // message that arrives while it runs is saved before its result.
      const ranHere = op.op === StepOpCode.StepRun && !(op.id in state);

      if (op.op === StepOpCode.StepRun) {
        options.onStep?.(op);
      }

      if (ranHere) {
        arriveAt(op.userland?.id ?? op.id, "during");
      }

      // A wait for an event ends unanswered, as it does when its timeout runs
      // out.
      if (op.op === StepOpCode.WaitForEvent) {
        answer(op.id, null);
        continue;
      }

      // The wait for `idle` of quiet is a sleep beside the read. It is a wait
      // with a timeout, as the tests see it: it ends only when one of the
      // `timeouts` is left, and otherwise the run waits for a message. Any
      // other sleep ends at once.
      if (op.op === StepOpCode.Sleep) {
        const idleSleep = (op.userland?.id ?? "").includes("inbox:idle:");

        if (idleSleep && !loggedWaits.has(op.id)) {
          loggedWaits.add(op.id);
          ops.push({
            id: op.userland?.id ?? op.id,
            op: "wait",
            opts: { ...(opts ?? {}), timeout: opts?.timeout ?? "idle" },
          });
        }

        if (idleSleep && timeoutsLeft <= 0) {
          continue;
        }

        if (idleSleep) {
          timeoutsLeft -= 1;
        }

        answer(op.id, null);
        continue;
      }

      if (op.id in state) {
        continue;
      }

      state = {
        ...state,
        [op.id]: { id: op.id, data: op.data, error: op.error },
      };
      stack.push(op.id);

      if (ranHere) {
        arriveAt(op.userland?.id ?? op.id, "after");
      }
    }

    // Nothing happened this request: the run waits on reads. A message
    // arrives if there is one, else the run is blocked until something from
    // outside arrives.
    if (stack.length === stackBefore && !retried) {
      for (const id of [...pendingWaits.keys()]) {
        if (id in state) {
          pendingWaits.delete(id);
        }
      }

      if (pendingWaits.size > 0 && incoming.length > 0) {
        arriveNow(incoming.shift());
      } else {
        return {
          ops,
          reads,
          saved,
          output: undefined,
          error: undefined as unknown,
          waiting: true,
        };
      }
    }
  }

  throw new Error("The function did not finish");
};

/**
 * The `data.text` of an inbox message (an `agent/message`),
 * or `undefined`.
 */
export const textOf = (
  message: { data: unknown } | null | undefined,
): string | undefined => {
  const data = message?.data as
    | { content?: unknown; text?: unknown }
    | undefined;
  const text = data?.content ?? data?.text;

  return typeof text === "string" ? text : undefined;
};

/**
 * Gives an app (default: the test client's) a fresh in-memory store and returns the global
 * `kv`, which reads it. Call it at the start of a test that checks what the
 * agent kept.
 */
export const freshKv = (app: string = testClientId): Kv => {
  setAppKvStore(app, memoryKvAdapter());

  return kv;
};
