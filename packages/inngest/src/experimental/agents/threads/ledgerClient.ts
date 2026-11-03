/**
 * @module
 * EXPERIMENTAL: `ledgerKvAdapter()`, the default KV store: how a run (or a
 * script) uses the ledger. See `ledger.ts` for the protocol.
 *
 * A run that needs the state of a KV scope instance subscribes first (an inbox
 * filtered by the instance's hash that never starts a run), then asks the
 * ledger once, and keeps a local copy: the ledger's state plus the run's own
 * writes that the ledger has not echoed yet. Every access after that reads the
 * copy, after taking in the changes that arrived since the last access. All of
 * it is inbox reads and `sendEvent` steps, so a replay sees the same copy at
 * the same point.
 *
 * What the adapter cannot do, and says so by throwing an error that points at
 * a store adapter (`createAgents(client, { store })`):
 *
 * - write inside a step's callback (a read there comes from the copy the run
 *   already holds);
 * - read from outside a function (a route or a script can write by event);
 * - run a conditional write (`setIfAbsent`, `compareAndSet`, so also `update`
 *   and `take`) from outside a function: the verdict comes back as an event
 *   only a run can wait for.
 *
 * A conditional write is the one place a run asks the ledger something after
 * its start: the ledger applies it only if the key is as expected, and says
 * which. It costs one round trip.
 */

import { getAsyncCtxSync } from "../../../components/execution/als.ts";
import { step } from "../../../components/InngestStepTools.ts";
import {
  type Inbox,
  inboxOpenedPromise,
  type UntypedInboxMessage,
} from "../../../components/inbox/Inbox.ts";
import type { Json } from "../json.ts";
import type { KvIndexEntry, KvIndexRange, KvStore } from "../kv/kv.ts";
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
 * What a script needs to write to the ledger: a client.
 */
export interface LedgerSender {
  /**
   * The app ID: a ledger function takes the events of its own app.
   */
  id: string;
  send(payload: unknown): Promise<unknown>;
}

/**
 * A run's copy of one ledger's state.
 */
interface Copy {
  /**
   * The ledger's address: the hash of the KV scope instance.
   */
  thread: string;
  app: string;
  runId: string;
  confirmed: ThreadLedgerState;
  version: number;
  pending: Array<{ seq: number; change: ThreadChange }>;
  future: Map<number, ThreadChangedData>;

  /**
   * What the ledger said about each of this run's writes, by `seq`.
   */
  echoes: Map<number, ThreadChangedData>;
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

const storeFix =
  "Configure a store adapter with createAgents(client, { store }) to do this.";

const copyOf = (thread: string, write: boolean, fallbackApp?: string): Copy => {
  const als = getAsyncCtxSync();
  const execution = als?.execution;

  if (!execution) {
    throw new Error("The ledger KV store needs a function run");
  }

  if (execution.executingStep && write) {
    throw new Error(
      `The ledger KV store cannot be written inside a step's callback (a tool, tool.step or step.run): write between steps. ${storeFix}`,
    );
  }

  const byThread = copies.get(execution.instance) ?? new Map<string, Copy>();
  let found = byThread.get(thread);

  if (!found) {
    if (execution.executingStep) {
      throw new Error(
        `The ledger KV store cannot be read inside a step's callback before the run has read it outside one: read the same scope between steps first. ${storeFix}`,
      );
    }

    found = {
      thread,
      app: (als?.app as { id?: string } | undefined)?.id ?? fallbackApp ?? "",
      runId: String(execution.ctx.runId),
      confirmed: emptyThreadState(),
      version: 0,
      pending: [],
      future: new Map(),
      echoes: new Map(),
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
    copy.echoes.set(data.seq, data);
    copy.view = undefined;
  }

  if (data.rejected !== undefined || data.conflict !== undefined) {
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
  const { thread, runId, app } = copy;
  const mine = `async.data.thread == ${quoted(thread)} && async.data.app == ${quoted(app)}`;
  const sub = step.subscribe(`ledger-state:${thread}`, [
    {
      event: threadChanged.name,
      if: mine,
    },
    {
      event: threadStateReply.name,
      if: `${mine} && async.data.runId == ${quoted(runId)}`,
    },
  ]) as unknown as Inbox;

  copy.sub = sub;
  await inboxOpenedPromise(sub);

  const buffered: UntypedInboxMessage[] = [];

  for (let attempt = 0; attempt < readAttempts; attempt++) {
    await step.sendEvent(
      `ledger-read:${thread}:${attempt}`,
      threadRead.create({ thread, app, runId }),
    );

    while (true) {
      const message = await sub.next({ timeout: readWait });

      if (message === undefined) {
        throw new Error(`Ledger state of "${thread}": the inbox closed early`);
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
    `Ledger state of "${thread}": the ledger did not answer. Serve agents.functions() so the ledger function runs. ${storeFix}`,
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

/**
 * Sends a write and returns its `seq`. The write is in the copy at once.
 */
const write = async (copy: Copy, change: ThreadChange): Promise<number> => {
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
    `ledger-write:${copy.thread}:${seq}`,
    threadWrite.create({
      thread: copy.thread,
      app: copy.app,
      runId: copy.runId,
      seq,
      change,
    }),
  );

  return seq;
};

/**
 * Sends a conditional write and waits for the ledger's verdict, then for the
 * changes it says came first, so the next read sees what won.
 * @returns Whether the write applied, and the key's value when it did not.
 */
const conditional = async (
  copy: Copy,
  change: ThreadChange,
): Promise<{ applied: boolean; current: Json | null }> => {
  const seq = await write(copy, change);
  let attempts = 0;

  while (!copy.echoes.has(seq)) {
    const batch = await copy.sub?.nextBatch({ timeout: readWait });

    if (batch === undefined) {
      throw new Error(`Ledger state of "${copy.thread}": the inbox closed`);
    }

    if (batch === null) {
      attempts += 1;

      if (attempts >= readAttempts) {
        throw new Error(
          `Ledger state of "${copy.thread}": the ledger did not answer a conditional write. ${storeFix}`,
        );
      }

      continue;
    }

    takeMessages(copy, batch);
  }

  const echo = copy.echoes.get(seq) as ThreadChangedData;

  copy.echoes.delete(seq);

  if (echo.rejected !== undefined) {
    throw new Error(echo.rejected);
  }

  if (!echo.conflict) {
    return { applied: true, current: null };
  }

  // The write that won came before this verdict: wait for it, a few times,
  // so the caller's next read is not stale.
  for (let tries = 0; tries < 3 && copy.version < echo.version; tries++) {
    const batch = await copy.sub?.nextBatch({ timeout: "3s" });

    if (!batch) {
      break;
    }

    takeMessages(copy, batch);
  }

  return { applied: false, current: echo.conflict.current };
};

const expiry = (ttl?: number): { exp?: number } => {
  return ttl === undefined ? {} : { exp: Date.now() + ttl * 1000 };
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
 * EXPERIMENTAL: The ledger KV store: `ledgerKvAdapter()` is a `KvStore`.
 */
export interface LedgerKvStore extends KvStore {
  /**
   * Marks the store as the ledger, which keeps its own steps: the KV layer
   * does not wrap its calls in steps.
   */
  readonly ledger: true;

  /**
   * Deletes the field only if it still holds `expected`, by the ledger's
   * verdict, and says whether it did.
   */
  deleteIf(hash: string, field: string, expected: string): Promise<boolean>;
}

/**
 * Whether a store is the ledger KV store.
 * @param store The store.
 */
export const isLedgerKvStore = (store: KvStore): store is LedgerKvStore => {
  return (store as Partial<LedgerKvStore>).ledger === true;
};

/**
 * Names a script's writes: they are numbered together, so the ledger applies
 * them in the order the script made them.
 */
const outsideWriter = `ext-${globalThis.crypto.randomUUID()}`;
const outsideSeq = new Map<string, number>();

/**
 * EXPERIMENTAL: The default KV store: thread state, `kv.app`, `kv.env` and the
 * agents' own records kept by ledger functions, one live run per KV scope
 * instance, with no outside service. A run reads an instance once, keeps a
 * local copy and takes in the changes the ledger sends: nothing polls and
 * nothing asks the ledger questions mid-run, except a conditional write
 * (`setIfAbsent`, `compareAndSet`, so `update` and `take` too), which waits for
 * the ledger's verdict.
 *
 * Serve `agents.functions()` so the ledger function runs. Limits:
 *
 * - Each instance holds up to 128 KB of JSON (agent history counts), and a
 *   write past it throws.
 * - A ledger lives as a function run: it holds its state for as long as the
 *   platform lets a run wait, and hands over to a fresh run near Inngest's step
 *   limit (about 400 writes). A write sent during a handover can be lost.
 * - A ledger belongs to one app: `kv.env` is shared by the functions of one app,
 *   not across apps.
 * - Writing inside a step's callback, reading outside a function, and a
 *   conditional write outside a function throw an error that says to configure
 *   a store adapter.
 * - A concurrent `set` of one key by two live writers keeps the one the ledger
 *   applies last; only conditional writes are arbitrated.
 *
 * @param options.client A client, to write from outside a function. Inside a
 * function the running function's own app is used.
 */
export const ledgerKvAdapter = (
  options: { client?: LedgerSender } = {},
): LedgerKvStore => {
  const inFunction = () => {
    return getAsyncCtxSync()?.execution !== undefined;
  };

  const outside = async (hash: string, change: ThreadChange) => {
    const client = options.client;

    if (!client) {
      throw new Error(
        `Writing the ledger KV store from outside a function needs the client: use kv.with(client). ${storeFix}`,
      );
    }

    const seq = (outsideSeq.get(hash) ?? 0) + 1;

    outsideSeq.set(hash, seq);
    await client.send(
      threadWrite.create({
        thread: hash,
        app: client.id,
        runId: outsideWriter,
        seq,
        change,
      }),
    );
  };

  const noOutside = (): never => {
    throw new Error(
      `Reading the ledger KV store needs a running function: a route or script can write it, not read it. ${storeFix}`,
    );
  };

  // The copy a read uses: synced between steps, as it stands inside one.
  const live = async (hash: string) => {
    const copy = copyOf(hash, false, options.client?.id);

    if (getAsyncCtxSync()?.execution?.executingStep) {
      if (!copy.ready) {
        throw new Error(
          `The ledger KV store cannot be read inside a step's callback before the run has read it outside one. ${storeFix}`,
        );
      }
    } else {
      await sync(copy);
    }

    return { copy, view: viewOf(copy) };
  };

  const change = async (hash: string, op: ThreadChange) => {
    if (!inFunction()) {
      await outside(hash, op);

      return;
    }

    await write(copyOf(hash, true, options.client?.id), op);
  };

  const decide = async (hash: string, op: ThreadChange) => {
    if (!inFunction()) {
      return noOutside();
    }

    return conditional(copyOf(hash, true, options.client?.id), op);
  };

  return {
    ledger: true,
    async get(hash, field) {
      if (!inFunction()) {
        return noOutside();
      }

      const { view } = await live(hash);
      const found = liveKey(view, field, Date.now())?.v;

      return found === undefined ? null : String(found);
    },
    async set(hash, field, value, ttl) {
      await change(hash, { op: "set", key: field, value, ...expiry(ttl) });
    },
    async setIfAbsent(hash, field, value, ttl) {
      const verdict = await decide(hash, {
        op: "setIfAbsent",
        key: field,
        value,
        ...expiry(ttl),
      });

      return verdict.applied || verdict.current === value;
    },
    async compareAndSet(hash, field, expected, next) {
      return (
        await decide(hash, {
          op: "cas",
          key: field,
          expected,
          value: next,
        })
      ).applied;
    },
    async delete(hash, field) {
      await change(hash, { op: "delete", key: field });
    },
    async deleteIf(hash, field, expected) {
      return (await decide(hash, { op: "casDelete", key: field, expected }))
        .applied;
    },
    async all(hash) {
      if (!inFunction()) {
        return noOutside();
      }

      const { view } = await live(hash);
      const now = Date.now();

      return Object.fromEntries(
        Object.keys(view.keys).flatMap((key) => {
          const found = liveKey(view, key, now);

          return found ? [[key, String(found.v)]] : [];
        }),
      );
    },
    async clear(hash) {
      await change(hash, { op: "clear" });
    },
    async indexAdd(hash, index, member, score) {
      await change(hash, { op: "indexAdd", index, member, score });
    },
    async indexRange(hash, index, range) {
      if (!inFunction()) {
        return noOutside();
      }

      const { view } = await live(hash);

      return members(view, index, range);
    },
    async indexRemove(hash, index, member) {
      await change(hash, { op: "indexRemove", index, member });
    },
  };
};

/**
 * Ends the run's subscriptions to ledger changes. An agent run calls it when
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
