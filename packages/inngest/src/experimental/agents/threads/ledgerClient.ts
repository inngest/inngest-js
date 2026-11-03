/**
 * @module
 * EXPERIMENTAL: how a run (or a script) uses the thread ledger: see
 * `ledger.ts` for the protocol.
 *
 * A run that needs a thread's state subscribes first (an inbox filtered by
 * thread that never starts a run), then asks the ledger once, and keeps a
 * local copy: the ledger's state plus the run's own writes that the ledger has
 * not echoed yet. Every access after that reads the copy, after taking in the
 * changes that arrived since the last access. All of it is inbox reads and
 * `sendEvent` steps, so a replay sees the same copy at the same point.
 */

import { getAsyncCtxSync } from "../../../components/execution/als.ts";
import { step } from "../../../components/InngestStepTools.ts";
import {
  type Inbox,
  inboxOpenedPromise,
  type UntypedInboxMessage,
} from "../../../components/inbox/Inbox.ts";
import type { Json } from "../json.ts";
import type { KvIndexEntry, KvIndexRange, KvSetOptions } from "../kv/kv.ts";
import {
  applyChange,
  emptyThreadState,
  liveKey,
  overLimitMessage,
  stateSize,
  type ThreadChange,
  type ThreadChangedData,
  type ThreadLedgerState,
  type ThreadStateData,
  threadChanged,
  threadRead,
  threadStateLimit,
  threadStateReply,
  threadWrite,
} from "./ledger.ts";

/**
 * Reads and writes one thread's state through the ledger, the way a KV scope
 * instance's raw handle does.
 */
export interface LedgerHandle {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, options?: KvSetOptions): Promise<void>;
  setIfAbsent(
    key: string,
    value: unknown,
    options?: KvSetOptions,
  ): Promise<boolean>;
  update<R>(
    key: string,
    compute: (current: unknown) => Promise<{ stop: R } | { write: unknown }>,
  ): Promise<{ stopped: R } | { written: unknown }>;
  delete(key: string): Promise<void>;
  all(): Promise<Record<string, unknown>>;
  clear(): Promise<void>;
  indexAdd(index: string, member: string, score: number): Promise<void>;
  indexRange(index: string, options: KvIndexRange): Promise<KvIndexEntry[]>;
  indexRemove(index: string, member: string): Promise<void>;
}

/**
 * What a script needs to write to the ledger.
 */
export interface LedgerSender {
  send(payload: unknown): Promise<unknown>;
}

/**
 * A run's copy of one thread's state.
 */
interface Copy {
  thread: string;
  runId: string;
  confirmed: ThreadLedgerState;
  version: number;
  pending: Array<{ seq: number; change: ThreadChange }>;
  future: Map<number, ThreadChangedData>;
  seq: number;
  sub?: Inbox;
  loading?: Promise<void>;
  ready: boolean;
  view?: ThreadLedgerState;
}

const copies = new WeakMap<object, Map<string, Copy>>();

/**
 * How long a read of the ledger waits for its answer before asking again, and
 * how many times it asks.
 */
const readWait = "20s";
const readAttempts = 3;

const quoted = (value: string): string => {
  return JSON.stringify(value);
};

const copyOf = (thread: string): Copy => {
  const execution = getAsyncCtxSync()?.execution;

  if (!execution) {
    throw new Error("The thread ledger needs a function run");
  }

  if (execution.executingStep) {
    throw new Error(
      "Thread state with no KV store cannot be used inside a step's callback: read or write it between steps, or configure a KV store with createAgents(client, { store }).",
    );
  }

  const byThread = copies.get(execution.instance) ?? new Map<string, Copy>();
  let found = byThread.get(thread);

  if (!found) {
    found = {
      thread,
      runId: String(execution.ctx.runId),
      confirmed: emptyThreadState(),
      version: 0,
      pending: [],
      future: new Map(),
      seq: 0,
      ready: false,
    };
    byThread.set(thread, found);
    copies.set(execution.instance, byThread);
  }

  return found;
};

/**
 * The copy's state: the ledger's, with the run's own unechoed writes on top.
 */
const viewOf = (copy: Copy): ThreadLedgerState => {
  if (!copy.view) {
    const view = structuredClone(copy.confirmed);

    for (const { change } of copy.pending) {
      applyChange(view, change, Date.now());
    }

    copy.view = view;
  }

  return copy.view;
};

/**
 * Takes in one `agent/thread.changed`, in version order. A change ahead of
 * the next version waits for the ones before it.
 */
const takeChange = (copy: Copy, data: ThreadChangedData): void => {
  if (data.change.op === "reset") {
    const { state, last } = data.change;

    copy.confirmed = state;
    copy.version = Math.max(copy.version, data.version - 1);
    copy.future.clear();
    copy.pending = copy.pending.filter((p) => {
      return p.seq > (last[copy.runId] ?? 0);
    });
    copy.view = undefined;
  } else if (data.runId === copy.runId) {
    copy.pending = copy.pending.filter((p) => {
      return p.seq !== data.seq;
    });
    copy.view = undefined;
  }

  if (data.rejected !== undefined) {
    return;
  }

  if (data.version > copy.version) {
    copy.future.set(data.version, data);
  }

  while (true) {
    let next = copy.future.get(copy.version + 1);

    // A gap that never fills: move to the lowest change held rather than
    // stall.
    if (!next && copy.future.size > 50) {
      next = copy.future.get(Math.min(...copy.future.keys()));
    }

    if (!next) {
      break;
    }

    copy.future.delete(next.version);
    applyChange(copy.confirmed, next.change, Date.now());
    copy.version = next.version;
    copy.view = undefined;
  }
};

const takeMessages = (copy: Copy, messages: UntypedInboxMessage[]): void => {
  const changes = messages
    .filter((m) => {
      return m.name === threadChanged.name;
    })
    .map((m) => {
      return m.data as ThreadChangedData;
    })
    .sort((a, b) => {
      return a.version - b.version;
    });

  for (const data of changes) {
    takeChange(copy, data);
  }
};

/**
 * Subscribes, then asks the ledger once. Changes that arrive before the answer
 * are held; those at or below the answer's version are discarded and the rest
 * are applied.
 */
const load = async (copy: Copy): Promise<void> => {
  const { thread, runId } = copy;
  const sub = step.subscribe(`thread-state:${thread}`, [
    {
      event: threadChanged.name,
      if: `async.data.thread == ${quoted(thread)}`,
    },
    {
      event: threadStateReply.name,
      if: `async.data.thread == ${quoted(thread)} && async.data.runId == ${quoted(runId)}`,
    },
  ]) as unknown as Inbox;

  copy.sub = sub;
  await inboxOpenedPromise(sub);

  const buffered: UntypedInboxMessage[] = [];

  for (let attempt = 0; attempt < readAttempts; attempt++) {
    await step.sendEvent(
      `thread-read:${thread}:${attempt}`,
      threadRead.create({ thread, runId }),
    );

    while (true) {
      const message = await sub.next({ timeout: readWait });

      if (message === undefined) {
        throw new Error(`Thread state of "${thread}": the inbox closed early`);
      }

      if (message === null) {
        break;
      }

      if (message.name !== threadStateReply.name) {
        buffered.push(message);
        continue;
      }

      const reply = message.data as ThreadStateData;

      copy.confirmed = reply.state;
      copy.version = reply.version;
      copy.pending = copy.pending.filter((p) => {
        return p.seq > reply.seq;
      });
      copy.view = undefined;
      takeMessages(
        copy,
        buffered.filter((m) => {
          return (m.data as ThreadChangedData).version > reply.version;
        }),
      );
      copy.ready = true;

      return;
    }
  }

  throw new Error(
    `Thread state of "${thread}": the ledger did not answer. Serve agents.functions() so the thread ledger runs, or configure a KV store with createAgents(client, { store }).`,
  );
};

/**
 * Makes sure the run holds a copy.
 */
const ensure = async (copy: Copy): Promise<void> => {
  if (copy.ready) {
    return;
  }

  copy.loading ??= load(copy);
  await copy.loading;
};

/**
 * Takes in the changes that arrived since the last access.
 */
const sync = async (copy: Copy): Promise<void> => {
  await ensure(copy);

  if (copy.sub) {
    takeMessages(copy, await copy.sub.drain());
  }
};

const write = async (copy: Copy, change: ThreadChange): Promise<void> => {
  await ensure(copy);

  const next = structuredClone(viewOf(copy));

  applyChange(next, change, Date.now());

  const size = stateSize(next);

  if (size > threadStateLimit) {
    throw new Error(overLimitMessage(copy.thread, size));
  }

  copy.seq += 1;

  const seq = copy.seq;

  copy.pending.push({ seq, change });
  copy.view = undefined;

  await step.sendEvent(
    `thread-write:${copy.thread}:${seq}`,
    threadWrite.create({
      thread: copy.thread,
      runId: copy.runId,
      seq,
      change,
    }),
  );
};

const expiry = (options?: KvSetOptions): { exp?: number } => {
  return options?.ttl === undefined
    ? {}
    : { exp: Date.now() + options.ttl * 1000 };
};

const members = (
  state: ThreadLedgerState,
  index: string,
  options: KvIndexRange,
): KvIndexEntry[] => {
  const entries = Object.entries(
    Object.hasOwn(state.indexes, index) ? (state.indexes[index] ?? {}) : {},
  )
    .map(([member, score]) => {
      return { member, score };
    })
    .filter((entry) => {
      return (
        entry.score >= (options.min ?? -Infinity) &&
        entry.score <= (options.max ?? Infinity)
      );
    })
    .sort((a, b) => {
      return a.score - b.score || (a.member < b.member ? -1 : 1);
    });

  if (options.order === "desc") {
    entries.reverse();
  }

  return options.limit === undefined
    ? entries
    : entries.slice(0, options.limit);
};

/**
 * The handle of a thread's state for code running inside a function.
 * @param thread The thread key.
 */
export const ledgerHandle = (thread: string): LedgerHandle => {
  const live = async () => {
    const copy = copyOf(thread);

    await sync(copy);

    return { copy, view: viewOf(copy) };
  };

  return {
    async get(key) {
      const { view } = await live();

      return liveKey(view, key, Date.now())?.v;
    },
    async set(key, value, options) {
      await write(copyOf(thread), {
        op: "set",
        key,
        value: value as Json,
        ...expiry(options),
      });
    },
    async setIfAbsent(key, value, options) {
      const { copy, view } = await live();

      if (liveKey(view, key, Date.now())) {
        return false;
      }

      await write(copy, {
        op: "setIfAbsent",
        key,
        value: value as Json,
        ...expiry(options),
      });

      return true;
    },
    async update(key, compute) {
      const { copy, view } = await live();
      const outcome = await compute(liveKey(view, key, Date.now())?.v);

      if ("stop" in outcome) {
        return { stopped: outcome.stop };
      }

      await write(copy, {
        op: "set",
        key,
        value: outcome.write as Json,
      });

      return { written: outcome.write };
    },
    async delete(key) {
      await write(copyOf(thread), { op: "delete", key });
    },
    async all() {
      const { view } = await live();
      const now = Date.now();

      return Object.fromEntries(
        Object.keys(view.keys).flatMap((key) => {
          const found = liveKey(view, key, now);

          return found ? [[key, found.v]] : [];
        }),
      );
    },
    async clear() {
      await write(copyOf(thread), { op: "clear" });
    },
    async indexAdd(index, member, score) {
      await write(copyOf(thread), { op: "indexAdd", index, member, score });
    },
    async indexRange(index, options) {
      const { view } = await live();

      return members(view, index, options);
    },
    async indexRemove(index, member) {
      await write(copyOf(thread), { op: "indexRemove", index, member });
    },
  };
};

/**
 * Names a script's writes: they are numbered together, so the ledger applies
 * them in the order the script made them.
 */
const outsideWriter = `ext-${globalThis.crypto.randomUUID()}`;
const outsideSeq = new Map<string, number>();

/**
 * The handle of a thread's state for code outside a function (a route or a
 * script). A write is an event, so it is applied in order, not at once. A read
 * has no inbox to be answered on, so it throws.
 * @param thread The thread key.
 * @param client What sends the events.
 */
export const outsideLedgerHandle = (
  thread: string,
  client: LedgerSender,
): LedgerHandle => {
  const send = async (change: ThreadChange) => {
    const seq = (outsideSeq.get(thread) ?? 0) + 1;

    outsideSeq.set(thread, seq);
    await client.send(
      threadWrite.create({ thread, runId: outsideWriter, seq, change }),
    );
  };
  const noRead = (): never => {
    throw new Error(
      "Reading thread state with no KV store needs a running function: a route or script can write it, not read it. Read it from a function, or configure a KV store with createAgents(client, { store }).",
    );
  };

  return {
    get: noRead,
    all: noRead,
    indexRange: noRead,
    setIfAbsent: noRead,
    update: noRead,
    async set(key, value, options) {
      await send({
        op: "set",
        key,
        value: value as Json,
        ...expiry(options),
      });
    },
    async delete(key) {
      await send({ op: "delete", key });
    },
    async clear() {
      await send({ op: "clear" });
    },
    async indexAdd(index, member, score) {
      await send({ op: "indexAdd", index, member, score });
    },
    async indexRemove(index, member) {
      await send({ op: "indexRemove", index, member });
    },
  };
};

/**
 * Ends the run's subscriptions to thread changes. An agent run calls it when
 * its work is done.
 * @param instance The run's execution (`execution.instance`).
 */
export const closeThreadCopies = async (instance: object): Promise<void> => {
  for (const copy of copies.get(instance)?.values() ?? []) {
    if (copy.sub && !copy.sub.closed) {
      await copy.sub.close();
    }
  }

  copies.delete(instance);
};
