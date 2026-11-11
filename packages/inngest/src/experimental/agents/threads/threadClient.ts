/**
 * @module
 * EXPERIMENTAL: the agent run's side of the thread protocol, and the handle
 * behind `kv.thread`.
 *
 * An agent run does three things with its thread, and only the first waits:
 *
 * - **obtains state when it starts**, by issuing the wait and the request
 *   together so that no arriving write can reach it by neither route;
 * - **writes**, one event each, fire and forget;
 * - **asks the thread to listen**, one event, acknowledged so the model's tool
 *   can say the subscription is in place.
 *
 * `kv.thread` is sugar over that: a `get` reads the state the run already
 * holds, so it costs no round trip, and a `set` sends the thread a write, so
 * it costs one step. It is a shape users recognise over a log they do not need
 * to see, and it is **not** a key-value store.
 *
 * THE RULE FOR ANYONE TOUCHING THREAD STATE: a write happens BETWEEN steps,
 * never inside another step's callback. There are two reasons and only the
 * first announces itself.
 *
 * 1. A write to the thread is an event, so it is a step, and a step issued
 *    inside another step's callback makes the run wait on itself. It hangs:
 *    no error, no timeout, the request never returns. Findable, because it
 *    hangs.
 * 2. A write made inside a memoized callback is applied to this run's own view
 *    ONLY in the request where that callback actually ran. A replay skips the
 *    callback, so a later read in the same run returns a view missing its own
 *    writes. **Nothing fails.** It surfaces somewhere else entirely, as state
 *    that sometimes forgets the last turn.
 *
 * The second is the same family as the rule that a stamp or a step id must be
 * a pure function of durable values - the one a module-level counter broke by
 * turning 12 writes into 50 events. Both are replay determinism, both are
 * invisible when broken, and both are the reason the thread bookkeeping in
 * `agentFunction.ts` and `threadState.ts` is deliberately not wrapped in a
 * `step.run`, however much it looks like it should be.
 */

import { getAsyncCtxSync } from "../../../components/execution/als.ts";
import type { Inngest } from "../../../components/Inngest.ts";
import type { UntypedInboxMessage } from "../../../components/inbox/Inbox.ts";
import { addEventIs } from "../../../components/triggers/triggers.ts";
import { nextCount } from "../agent/executionCounter.ts";
import type { AgentThreadKeys, StepWithSubscribe } from "../agent/types.ts";
import type { Json } from "../json.ts";
import { type KvScopeHandle, setThreadHandle } from "../kv/kv.ts";
import {
  emptySnapshot,
  listenSignal,
  readSignal,
  type ThreadEntry,
  type ThreadForwardData,
  type ThreadListen,
  type ThreadSnapshot,
  type ThreadWriteOp,
  threadForward,
  threadListen,
  threadRead,
  threadWrite,
} from "./threadProtocol.ts";

/**
 * How long an agent run waits for its thread to answer its read. Generous,
 * because an unanswered read means no thread run is live and the run carries
 * on with an empty thread, which is the one answer that must not be wrong.
 */
const readTimeout = "30s";

/**
 * How long the model's listen tool waits for the thread to record a listen.
 */
const listenTimeout = "30s";

/*
 * THE THREAD RUN HOLDS EVERY KEY OF ITS THREAD'S SCOPE while an agent run has
 * it: what the user's code sets, the model's history, and the agent's own
 * record of the thread.
 *
 * It has to be every key rather than a chosen few, because of the rule that an
 * agent run never subscribes to anything its thread subscribes to. A store's
 * client that opens a subscription of its own for a read or a write would put
 * a second resolver in the run, and two resolvers on one event lose messages
 * with an arbitrary survivor and no error.
 *
 * Every function that touches thread state therefore obtains the thread's own
 * handle first - the agent run, its cleanup, and the function that records how
 * it ended - and after that `kv.thread` reads what the run already holds and
 * writes by sending the thread an event. There is no store behind any of it.
 *
 * And there is **no public read of thread state**. A read is a request to the
 * holder and a wait for its answer, which is a step, so it works inside a
 * function run and nowhere else; inside a run it is near-redundant with
 * `kv.thread.get`, which is local. Serving it from a route handler would need
 * an API call, which this layer does not make.
 */

/**
 * One agent run's view of its thread.
 */
export interface ThreadClient {
  /**
   * What the thread handed over, kept current by this run's own writes.
   */
  readonly state: ThreadSnapshot;

  /**
   * Whether a thread run answered the read. `false` means none was live: the
   * run carries on against an empty thread, and says so.
   */
  readonly answered: boolean;

  /**
   * The entries the thread holds that no agent run has taken up: what a lost
   * forward costs. Reading them is how an agent that fell behind catches up.
   */
  pending(): ThreadEntry[];

  /**
   * Tells the thread this run has taken the log up to a position, so a later
   * read does not hand those entries back. Fire and forget.
   */
  took(seq: number): Promise<void>;

  /**
   * Asks the thread to subscribe to something, and waits only until the thread
   * has recorded it. With `remove`, asks it to stop.
   */
  listen(listen: ThreadListen, remove?: boolean): Promise<boolean>;

  /**
   * The handle `kv.thread` uses while this run is live.
   */
  handle: KvScopeHandle;
}

/**
 * What `kv.thread` gives a user's code: the handle, with writes refused inside
 * a step's callback.
 *
 * A write made in there WORKS - it is durable and the thread applies it - and
 * the run that made it cannot read it back, because it is applied to the run's
 * own view only in the request where that callback ran and a replay skips the
 * callback. Measured in a running app: a run wrote three keys, read two of
 * them back as missing, and the thread ended up holding all three. "Works,
 * durable, invisible" is the shape of a surprise that costs days, so it throws
 * instead, on the first attempt, with the way to do it properly.
 *
 * The mitigation not taken, because it is the first thing anyone proposes:
 * overlaying the run's own in-callback writes onto what `get` returns would
 * work only in the request where the callback ran. On every later request the
 * overlay is empty, so `get` would answer differently across requests of the
 * same run - which is exactly the replay non-determinism that the write-id
 * collision was.
 *
 * Internal writers keep the in-callback path: they do not read their own
 * writes back in the same run, and they carry the write ids that make a
 * step's retry harmless.
 * @param handle The run's thread handle.
 */
export const threadKeysFor = (handle: KvScopeHandle): AgentThreadKeys => {
  const refuseInStep = (call: string) => {
    const executing = getAsyncCtxSync()?.execution?.executingStep;

    if (!executing) {
      return;
    }

    throw new Error(
      [
        `kv.thread.${call}() cannot be called inside a step's callback.`,
        "The write would be durable and would reach the thread, but this run could not read it back: a write made inside a callback is applied to the run's own view only in the request where that callback ran, and a replay skips the callback. So the value would look missing to the code right after it.",
        'Return the value from the step and set it outside:\n\n  const result = await step.run("work", async () => {\n    // ...\n    return value;\n  });\n\n  await kv.thread.set("result", result);',
      ].join(" "),
    );
  };

  return {
    get<T = unknown>(key: string) {
      return handle.get(key) as Promise<T | undefined>;
    },
    set(key: string, value: Json) {
      refuseInStep("set");

      return handle.set(key, value);
    },
    delete(key: string) {
      refuseInStep("delete");

      return handle.delete(key);
    },
    all() {
      return handle.all();
    },
  };
};

/**
 * The entries of a forward, or nothing when the message is not one.
 */
export const forwardedEntries = (message: {
  name: string;
  data?: unknown;
}): ThreadEntry[] | undefined => {
  return message.name === threadForward.name
    ? ((message.data as ThreadForwardData | undefined)?.events ?? [])
    : undefined;
};

/**
 * One log entry as a message, which is the event exactly as it arrived at the
 * thread.
 */
export const entryAsMessage = (entry: ThreadEntry): UntypedInboxMessage => {
  return addEventIs({
    id: entry.id ?? "",
    name: entry.name,
    data: entry.data,
    ts: entry.ts,
    user: {},
  }) as unknown as UntypedInboxMessage;
};

/**
 * EXPERIMENTAL: obtains the thread's state for one agent run, and gives the
 * run the handle behind `kv.thread`.
 *
 * The wait and the request are issued **together**: the executor registers the
 * wait before the send executes, so a write that arrives in between reaches
 * the agent by one route or the other, never neither. Do not reorder them, and
 * do not serve the answer from a cache - a precomputed answer reopens the very
 * gap this closes.
 */
export const obtainThreadState = async (options: {
  client: Inngest.Any;
  step: StepWithSubscribe;

  /**
   * The agent, as `"appId/functionId"`.
   */
  ref: string;
  thread: string;
  runId: string;

  /**
   * The event that started this run when the thread never saw it - a typed
   * `invoke()` start, say. It travels with the read so the log holds it.
   */
  arrival?: { id?: string; name: string; data: unknown };

  /**
   * The state that came with the forward that started this run, when the
   * thread was small enough to send it. There is nothing to ask for, so the
   * run asks for nothing: no read, no round trip, and no window to defer.
   */
  given?: ThreadSnapshot;
}): Promise<ThreadClient> => {
  const { client, step, ref, thread, runId, arrival, given } = options;
  const signal = readSignal(ref, thread, runId);
  const [answer] = given
    ? [{ signal, data: given }]
    : await Promise.all([
        step.waitForSignal<ThreadSnapshot>("thread:state", {
          signal,
          timeout: readTimeout,
          onConflict: "replace",
        }),
        step.sendEvent(
          "thread:read",
          threadRead.create({
            agent: ref,
            thread,
            signal,
            ...(arrival && { arrival }),
            run: runId,
          }),
        ),
      ]);

  // A copy: the answer is a memoized step's data, and this run goes on to
  // apply its own writes to the state it holds. Mutating what the executor
  // handed over would change what a replay reads.
  const state: ThreadSnapshot = structuredClone(
    answer
      ? ((answer.data as ThreadSnapshot | undefined) ?? emptySnapshot())
      : emptySnapshot(),
  );
  const answered = answer !== null && answer !== undefined;
  const instance = getAsyncCtxSync()?.execution?.instance;
  let listens = 0;

  /**
   * Sends the thread a write. One event, no ack, no wait, no retry: the thread
   * is the only writer and a write that reaches no live thread run reaches
   * nothing, which is accepted.
   */
  // How many writes this run has made from inside each step's callback, by the
  // step. A callback is not re-run on a replay, so its writes cannot share a
  // counter with the ones made between steps: that counter is consumed again
  // on every replay and the callback's is not, so the two paths drift into
  // each other and produce the same id twice.
  const inStepWrites = new Map<string, number>();

  const write = async (ops: ThreadWriteOp[]) => {
    const base = "thread:write";
    const executing = getAsyncCtxSync()?.execution?.executingStep;

    // A WRITE ID MUST BE A PURE FUNCTION OF DURABLE VALUES, AND EVERY VALUE IT
    // DEPENDS ON MUST BE PRESENT ON EVERY PATH THAT PRODUCES ONE. The second
    // half is the half that bites: a value that can be absent, with a fallback
    // that is not unique, turns an idempotency key into a silencer. The thread
    // keys its log on this id, so a repeat is not a duplicate write - it is a
    // DROPPED one, with nothing anywhere saying so. The symptom is an agent
    // that does not remember.
    //
    // So the two paths have their own namespaces, and each uses only what is
    // present on it:
    //
    // - between steps, the run's own count of them, which a replay re-derives
    //   because it re-executes the same code in the same order;
    // - inside a step's callback, the step's id and a count within it, because
    //   the callback is not re-run on a replay and a retry of it runs the same
    //   writes in the same order.
    if (executing?.id) {
      const nth = inStepWrites.get(executing.id) ?? 0;

      inStepWrites.set(executing.id, nth + 1);

      // Inside a step's callback a step cannot be issued - the run would wait
      // on itself - so the write is sent directly. A retry of that step sends
      // it again, which is exactly what the id is for.
      await client.send(
        threadWrite.create({
          agent: ref,
          thread,
          // The step part is escaped, because a step's id is its NAME and a
          // name may contain a colon - the SDK's own do. Unescaped, a step
          // named `work:0` writing once and a step named `work` writing at
          // index 0 would produce the same id, and the thread would drop one
          // of them. Same shape as before, `<run>:<step>:<n>`, but the middle
          // can no longer be mistaken for the ends.
          id: `${runId}:${encodeURIComponent(executing.id)}:${nth}`,
          ops,
          run: runId,
        }),
      );

      return;
    }

    if (!instance) {
      // Nothing to count with, and a shared fallback would collide. Say so.
      throw new Error(
        "A write to a thread needs a run to count it: `kv.thread.set` works inside an agent run, and the id of a write must be unique to it.",
      );
    }

    const nth = nextCount(instance, base);

    await step.sendEvent(
      nth === 0 ? base : `${base}:${nth}`,
      threadWrite.create({
        agent: ref,
        thread,
        id: `${runId}:${nth}`,
        ops,
        run: runId,
      }),
    );
  };

  const text = (value: unknown) => {
    return JSON.stringify(value);
  };
  const live = (key: string): string | undefined => {
    const held = state.keys[key];

    return held && (held.exp === undefined || held.exp > Date.now())
      ? held.v
      : undefined;
  };
  const apply = (ops: ThreadWriteOp[]) => {
    for (const op of ops) {
      switch (op.kind) {
        case "set":
          state.keys[op.key] = {
            v: op.value,
            ...(op.exp !== undefined && { exp: op.exp }),
          };

          break;
        case "delete":
          delete state.keys[op.key];

          break;
        case "clear":
          state.keys = {};
          state.indexes = {};

          break;
        case "index.add": {
          state.indexes ??= {};
          state.indexes[op.index] ??= {};

          const members = state.indexes[op.index];

          if (members) {
            members[op.member] = op.score;
          }

          break;
        }
        case "index.remove":
          delete state.indexes?.[op.index]?.[op.member];

          break;
        default:
          break;
      }
    }
  };
  const commit = async (ops: ThreadWriteOp[]) => {
    await write(ops);
    apply(ops);
  };
  const expires = (options?: { ttl?: number }) => {
    return options?.ttl === undefined
      ? {}
      : { exp: Date.now() + options.ttl * 1000 };
  };
  const handle: KvScopeHandle = {
    async get(key) {
      const raw = live(key);

      return raw === undefined ? undefined : JSON.parse(raw);
    },
    async set(key, value, setOptions) {
      await commit([
        {
          kind: "set",
          key,
          value: text(value),
          ...expires(setOptions),
        },
      ]);
    },
    async setIfAbsent(key, value, setOptions) {
      const held = live(key);
      const written = text(value);

      if (held !== undefined) {
        return held === written;
      }

      await commit([
        { kind: "set", key, value: written, ...expires(setOptions) },
      ]);

      return true;
    },
    async update(key, compute) {
      // One writer, so there is nothing to compare against: the run computes
      // from what it holds and sends the write.
      const held = live(key);
      const outcome = await compute(
        held === undefined ? undefined : JSON.parse(held),
      );

      if ("stop" in outcome) {
        return { stopped: outcome.stop };
      }

      await commit([{ kind: "set", key, value: text(outcome.write) }]);

      return { written: outcome.write };
    },
    async delete(key) {
      await commit([{ kind: "delete", key }]);
    },
    async all() {
      const held = Object.fromEntries(
        Object.keys(state.keys).flatMap((key) => {
          const raw = live(key);

          return raw === undefined ? [] : [[key, JSON.parse(raw)]];
        }),
      );

      return held;
    },
    async clear() {
      await commit([{ kind: "clear" }]);
    },
    async indexAdd(index, member, score) {
      await commit([{ kind: "index.add", index, member, score }]);
    },
    async indexRange(index, rangeOptions) {
      const entries = Object.entries(state.indexes?.[index] ?? {})
        .map(([member, score]) => {
          return { member, score };
        })
        .filter((entry) => {
          return (
            entry.score >= (rangeOptions.min ?? -Infinity) &&
            entry.score <= (rangeOptions.max ?? Infinity)
          );
        })
        .sort((a, b) => {
          return a.score - b.score || (a.member < b.member ? -1 : 1);
        });

      if (rangeOptions.order === "desc") {
        entries.reverse();
      }

      return entries.slice(0, rangeOptions.limit ?? entries.length);
    },
    async indexRemove(index, member) {
      await commit([{ kind: "index.remove", index, member }]);
    },
  };

  if (instance) {
    setThreadHandle(instance, thread, handle);
  }

  return {
    state,
    answered,
    pending() {
      return state.entries.filter((entry) => {
        return entry.seq > state.taken;
      });
    },
    async took(seq) {
      // WHAT MATTERS IS THAT `taken` ADVANCED, NOT THAT A TAKE WAS WRITTEN.
      //
      // Nothing is written when the thread has already moved its watermark
      // past this position, which it does as soon as a run hands over the
      // event that started it: the thread appends that entry and counts it as
      // taken in the same breath, because the run that handed it over has it.
      // So a thread can be perfectly up to date with no take op anywhere in
      // the stream. Anything - a test, a dashboard, a monitor - that watches
      // for the EVENT rather than the state will under-report, and silently.
      if (seq <= state.taken) {
        return;
      }

      state.taken = seq;
      await write([{ kind: "take", seq }]);
    },
    async listen(listen, remove) {
      const nth = listens++;
      const signal = listenSignal(ref, thread, runId, nth);
      const [heard] = await Promise.all([
        step.waitForSignal<{ listening: boolean }>(`thread:listen:${nth}`, {
          signal,
          timeout: listenTimeout,
          onConflict: "replace",
        }),
        step.sendEvent(`thread:listen:send:${nth}`, {
          ...threadListen.create({
            agent: ref,
            thread,
            listen,
            ...(remove && { remove: true as const }),
            signal,
            run: runId,
          }),
        }),
      ]);

      if (heard) {
        state.listens = remove
          ? state.listens.filter((held) => {
              return !(held.event === listen.event && held.if === listen.if);
            })
          : [...state.listens, listen];
      }

      return Boolean(heard);
    },
    handle,
  };
};
