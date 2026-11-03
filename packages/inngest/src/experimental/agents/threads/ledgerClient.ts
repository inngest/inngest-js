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
 *
 * Nothing here waits on a timer. A reader whose read found no live ledger asks
 * again when a ledger run says it is listening (`agent/thread.ready`). A copy
 * that sees a `reset` (a ledger run took over) or another epoch (a ledger
 * started over) sends its unechoed writes again or reloads. Every event this
 * module sends is signed, and every one it takes in must be.
 */

import { getAsyncCtxSync } from "../../../components/execution/als.ts";
import { step } from "../../../components/InngestStepTools.ts";
import { NonRetriableError } from "../../../components/NonRetriableError.ts";
import {
  type Inbox,
  inboxOpenedPromise,
  type UntypedInboxMessage,
} from "../../../components/inbox/Inbox.ts";
import { ledgerDataIsSigned, signLedgerData } from "../agent/relations.ts";
import type { Json } from "../json.ts";
import type { KvIndexEntry, KvIndexRange, KvStore } from "../kv/kv.ts";
import {
  applyChange,
  emptyThreadState,
  ledgerIsServed,
  liveKey,
  overLimitMessage,
  resolveTtl,
  stateSize,
  type ThreadChange,
  type ThreadChangedData,
  type ThreadLedgerState,
  type ThreadStateData,
  threadChanged,
  threadRead,
  threadReady,
  threadStateLimit,
  threadStateReply,
  threadWrite,
} from "./ledger.ts";

/**
 * What signs the ledger events of a client: its app ID and signing key.
 */
export interface LedgerSigner {
  /**
   * The app ID: a ledger function takes the events of its own app.
   */
  id: string;
  signingKey?: string;
  signingKeyFallback?: string;
}

/**
 * What a script needs to write to the ledger: a client.
 */
export interface LedgerSender extends LedgerSigner {
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
  signer: LedgerSigner;
  confirmed: ThreadLedgerState;
  version: number;

  /**
   * The ledger run the state came from. A change from another one means the
   * ledger started over, and the copy reloads.
   */
  epoch?: string;

  /**
   * The time of the latest event the copy took in (or the run's start event),
   * in milliseconds. Expiry is judged by it, so a replay sees what the first
   * run saw.
   */
  clock: number;
  stale: boolean;
  resend: boolean;
  heardReady: boolean;
  justLoaded: boolean;

  /**
   * How many reads and resends this copy sent, which number their steps.
   */
  reads: number;
  resends: number;
  pending: Array<{ seq: number; change: ThreadChange }>;
  future: Map<number, ThreadChangedData>;

  /**
   * What the ledger said about each of this run's writes, by `seq`.
   */
  echoes: Map<number, ThreadChangedData>;
  seq: number;
  sub?: Inbox;

  /**
   * What a run that only writes listens on: the echoes of its writes and the
   * news that a ledger run took over, so it can send a write again.
   */
  echo?: Inbox;
  echoing?: Promise<void>;
  loading?: Promise<void>;
  ready: boolean;
  view?: ThreadLedgerState;
}

const copies = new WeakMap<object, Map<string, Copy>>();

const quoted = (value: string): string => {
  return JSON.stringify(value);
};

const storeFix =
  "Configure a store adapter with createAgents(client, { store }) to do this.";

const copyOf = (
  thread: string,
  write: boolean,
  fallback?: LedgerSigner,
): Copy => {
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

    const signer =
      (als?.app as unknown as LedgerSigner | undefined) ?? fallback;

    if (!signer) {
      throw new Error("The ledger KV store needs a client to sign with");
    }

    // The ledger is a function this app serves. An app that never called
    // `agents.functions()` has none, and a read would wait for it for ever:
    // say so now, once, with no timer.
    if (!ledgerIsServed(signer.id)) {
      throw new NonRetriableError(
        `The app "${signer.id}" uses the ledger KV store (the default) but does not serve its ledger function: pass agents.functions() to serve() or connect(), or configure a store adapter with createAgents(client, { store }).`,
      );
    }

    found = {
      thread,
      app: signer.id,
      runId: String(execution.ctx.runId),
      signer,
      confirmed: emptyThreadState(),
      version: 0,
      clock: (execution.ctx.event as { ts?: number } | undefined)?.ts ?? 0,
      stale: false,
      resend: false,
      heardReady: false,
      justLoaded: false,
      reads: 0,
      resends: 0,
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
      applyChange(view, resolveTtl(change, copy.clock), copy.clock);
    }

    copy.view = view;
  }

  return copy.view;
};

/**
 * Says an event was dropped, in the logs of the function that runs this copy.
 */
const dropped = (copy: Copy, name: string): void => {
  const logger = (
    getAsyncCtxSync()?.execution?.ctx as unknown as
      | { logger?: { warn: (fields: object, message: string) => void } }
      | undefined
  )?.logger;

  logger?.warn(
    { thread: copy.thread, event: name },
    "dropped a ledger event with no valid signature",
  );
};

const signedBy = <T extends Record<string, unknown>>(
  copy: Copy,
  name: string,
  data: T,
) => {
  return signLedgerData(copy.signer, name, data);
};

const writeOf = (copy: Copy, seq: number, change: ThreadChange) => {
  return threadWrite.create(
    signedBy(copy, threadWrite.name, {
      thread: copy.thread,
      app: copy.app,
      runId: copy.runId,
      seq,
      change,
    }),
  );
};

/**
 * Takes in one `agent/thread.changed`, in version order. A change ahead of
 * the next version waits for the ones before it.
 */
const takeChange = (copy: Copy, data: ThreadChangedData): void => {
  if (data.change.op === "reset") {
    // A ledger run took over (or started over) and says what it holds. What it
    // holds is the state from then on, and the writes of this copy that it did
    // not apply are for this copy to send again.
    if (data.epoch === copy.epoch && data.version <= copy.version) {
      return;
    }

    const { state, last } = data.change;

    copy.confirmed = state;
    copy.version = data.version;
    copy.epoch = data.epoch;
    copy.pending = copy.pending.filter((p) => {
      return p.seq > (last[copy.runId] ?? 0);
    });
    copy.resend = copy.pending.length > 0;
    copy.stale = false;

    for (const version of [...copy.future.keys()]) {
      if (version <= data.version) {
        copy.future.delete(version);
      }
    }

    copy.view = undefined;
  } else {
    if (copy.epoch !== undefined && data.epoch !== copy.epoch) {
      copy.stale = true;

      return;
    }

    if (data.runId === copy.runId) {
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
    applyChange(copy.confirmed, next.change, copy.clock);
    copy.version = next.version;
    copy.view = undefined;
  }
};

/**
 * Takes in the messages of the copy's inbox: changes in version order, and
 * the news that a ledger run is listening. An event with no valid signature is
 * dropped. What the messages call for (a reload, writes sent again) is done by
 * `settle`.
 */
const takeMessages = (copy: Copy, messages: UntypedInboxMessage[]): void => {
  const changes: ThreadChangedData[] = [];

  for (const message of messages) {
    if (
      message.name !== threadChanged.name &&
      message.name !== threadReady.name
    ) {
      continue;
    }

    if (!ledgerDataIsSigned(copy.signer, message.name, message.data)) {
      dropped(copy, message.name);
      continue;
    }

    if (typeof message.ts === "number") {
      copy.clock = Math.max(copy.clock, message.ts);
    }

    if (message.name === threadReady.name) {
      copy.heardReady = true;
    } else {
      changes.push(message.data as ThreadChangedData);
    }
  }

  changes.sort((a, b) => {
    return a.version - b.version;
  });

  for (const data of changes) {
    takeChange(copy, data);
  }
};

/**
 * Sends the writes the ledger has not echoed again, with the `seq` they had:
 * a ledger that already applied one drops the copy it gets.
 */
const resendPending = async (copy: Copy): Promise<void> => {
  copy.resend = false;
  copy.heardReady = false;

  if (copy.pending.length === 0) {
    return;
  }

  copy.resends += 1;
  await step.sendEvent(
    `ledger-resend:${copy.thread}:${copy.resends}`,
    copy.pending.map((p) => {
      return writeOf(copy, p.seq, p.change);
    }),
  );
};

/**
 * Reads the ledger's state: asks, and asks again each time a ledger run says
 * it is listening, until the answer comes. Changes that arrive meanwhile are
 * held; those at or below the answer's version are discarded and the rest are
 * applied.
 */
const fetchState = async (copy: Copy): Promise<void> => {
  const sub = copy.sub as Inbox;
  const { thread, runId, app } = copy;
  const buffered: UntypedInboxMessage[] = [];
  const first = copy.reads + 1;
  const ask = async () => {
    copy.reads += 1;
    await step.sendEvent(
      `ledger-read:${thread}:${copy.reads}`,
      threadRead.create(
        signedBy(copy, threadRead.name, { thread, app, runId, n: copy.reads }),
      ),
    );
  };

  await ask();

  while (true) {
    const message = await sub.next();

    if (message === undefined) {
      throw new Error(`Ledger state of "${thread}": the inbox closed early`);
    }

    if (message.name === threadReady.name) {
      if (ledgerDataIsSigned(copy.signer, message.name, message.data)) {
        // The ledger run that started with this reader's request answers it.
        if ((message.data as { answered?: string }).answered !== runId) {
          await ask();
        }
      } else {
        dropped(copy, message.name);
      }

      continue;
    }

    if (message.name !== threadStateReply.name) {
      buffered.push(message);
      continue;
    }

    const reply = message.data as ThreadStateData & { n?: number };

    if (!ledgerDataIsSigned(copy.signer, message.name, reply)) {
      dropped(copy, message.name);
      continue;
    }

    // An answer to a read of an earlier load is older than what this one
    // asked for.
    if ((reply.n ?? 0) < first) {
      continue;
    }

    if (typeof message.ts === "number") {
      copy.clock = Math.max(copy.clock, message.ts);
    }

    copy.confirmed = reply.state;
    copy.version = reply.version;
    copy.epoch = reply.epoch;
    copy.stale = false;
    copy.future.clear();
    copy.pending = copy.pending.filter((p) => {
      return p.seq > reply.seq;
    });
    copy.view = undefined;

    const mine = buffered.filter((m) => {
      return (
        m.name === threadChanged.name &&
        (m.data as ThreadChangedData).epoch === reply.epoch &&
        (m.data as ThreadChangedData).version > reply.version
      );
    });

    // A change from another ledger run than the answer's: the copy reloads
    // when it next looks.
    copy.stale = buffered.some((m) => {
      return (
        m.name === threadChanged.name &&
        (m.data as ThreadChangedData).epoch !== reply.epoch
      );
    });
    takeMessages(copy, [
      ...mine,
      ...buffered.filter((m) => {
        return m.name === threadReady.name;
      }),
    ]);
    copy.heardReady = false;

    return;
  }
};

/**
 * Subscribes, then asks the ledger once.
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
      event: threadReady.name,
      if: mine,
    },
    {
      event: threadStateReply.name,
      if: `${mine} && async.data.runId == ${quoted(runId)}`,
    },
  ]) as unknown as Inbox;

  copy.sub = sub;
  await inboxOpenedPromise(sub);
  await fetchState(copy);
  copy.ready = true;
  copy.justLoaded = true;
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
 * Does what the messages taken in call for: reloads when the ledger started
 * over, and sends the writes the ledger lacks again after a handover (`reset`)
 * or when a ledger run says it is listening.
 */
const settle = async (copy: Copy): Promise<void> => {
  if (copy.stale) {
    await fetchState(copy);
    await resendPending(copy);

    return;
  }

  if (copy.resend || (copy.heardReady && copy.pending.length > 0)) {
    await resendPending(copy);
  }

  copy.heardReady = false;
};

/**
 * Takes in the changes that arrived since the last access. Right after the
 * load there is nothing new to take in.
 */
const sync = async (copy: Copy): Promise<void> => {
  await ensure(copy);

  if (copy.justLoaded) {
    copy.justLoaded = false;

    if (copy.stale) {
      await settle(copy);
    }

    return;
  }

  if (copy.sub) {
    takeMessages(copy, await copy.sub.drain());
    await settle(copy);
  }
};

/**
 * Sends a write and returns its `seq`. The write is in the copy at once. A
 * run that has not loaded the state sends it without loading: the ledger
 * enforces the size limit.
 */
const write = async (copy: Copy, change: ThreadChange): Promise<number> => {
  if (copy.ready) {
    const next = structuredClone(viewOf(copy));

    applyChange(next, resolveTtl(change, copy.clock), copy.clock);

    const size = stateSize(next);

    if (size > threadStateLimit) {
      throw new Error(overLimitMessage(copy.thread, size));
    }
  }

  // A run that never reads has no copy listening, so a write sent while a
  // ledger run hands over would be lost. It listens from its first write on.
  if (!copy.sub && !copy.echo) {
    const { thread, app } = copy;
    const mine = `async.data.thread == ${quoted(thread)} && async.data.app == ${quoted(app)}`;

    copy.echo = step.subscribe(`ledger-echo:${thread}`, [
      { event: threadChanged.name, if: mine },
      { event: threadReady.name, if: mine },
    ]) as unknown as Inbox;
    await inboxOpenedPromise(copy.echo);
  }

  copy.seq += 1;

  const seq = copy.seq;

  copy.pending.push({ seq, change });
  copy.view = undefined;

  await step.sendEvent(
    `ledger-write:${copy.thread}:${seq}`,
    writeOf(copy, seq, change),
  );

  await awaitEchoes(copy);

  return seq;
};

/**
 * For a run that only writes: waits until the ledger has echoed every write,
 * sending the ones a ledger run that took over did not apply again. A run
 * that reads is served by its copy's own inbox instead.
 */
const awaitEchoes = async (copy: Copy): Promise<void> => {
  const echo = copy.echo;

  if (!echo || copy.sub) {
    return;
  }

  copy.echoing ??= (async () => {
    try {
      while (copy.pending.length > 0) {
        const batch = await echo.nextBatch();

        if (batch === undefined || batch === null) {
          return;
        }

        takeMessages(copy, batch);

        if (copy.resend || (copy.heardReady && copy.pending.length > 0)) {
          await resendPending(copy);
        }

        copy.heardReady = false;
      }
    } finally {
      copy.echoing = undefined;
    }
  })();

  await copy.echoing;
};

/**
 * What a conditional write did, from the state, for a verdict that did not
 * arrive because a ledger run took over before its echo was sent.
 */
const inferred = (copy: Copy, change: ThreadChange): ThreadChangedData => {
  const key = (change as { key: string }).key;
  const live = liveKey(copy.confirmed, key, copy.clock)?.v ?? null;
  const applied =
    change.op === "casDelete"
      ? live !== change.expected
      : live === (change as { value: Json }).value;

  return {
    thread: copy.thread,
    app: copy.app,
    runId: copy.runId,
    seq: 0,
    change,
    epoch: copy.epoch ?? "",
    version: copy.version,
    ...(!applied && { conflict: { current: live } }),
  };
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
  await ensure(copy);

  const seq = await write(copy, change);

  while (!copy.echoes.has(seq)) {
    // A reload took the write into the state without a verdict.
    if (!copy.pending.some((p) => p.seq === seq)) {
      copy.echoes.set(seq, inferred(copy, change));
      break;
    }

    const batch = await copy.sub?.nextBatch();

    if (batch === undefined || batch === null) {
      throw new Error(`Ledger state of "${copy.thread}": the inbox closed`);
    }

    takeMessages(copy, batch);
    await settle(copy);
  }

  const echo = copy.echoes.get(seq) as ThreadChangedData;

  copy.echoes.delete(seq);

  if (echo.rejected !== undefined) {
    throw new Error(echo.rejected);
  }

  if (!echo.conflict) {
    return { applied: true, current: null };
  }

  // The write that won came before this verdict: wait for it, so the caller's
  // next read is not stale. A reload of the state (another epoch) has it.
  while (copy.version < echo.version && copy.epoch === echo.epoch) {
    const batch = await copy.sub?.nextBatch();

    if (!batch) {
      break;
    }

    takeMessages(copy, batch);
    await settle(copy);
  }

  return { applied: false, current: echo.conflict.current };
};

const expiry = (ttl?: number): { ttl?: number } => {
  return ttl === undefined ? {} : { ttl };
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
 *   limit (about 400 writes). A write sent during a handover is sent again by
 *   its writer when the next ledger run's `reset` arrives. A function run that
 *   only writes listens for the echo of each write and waits for it, so it
 *   sends again like a run that reads. A writer outside any function (a
 *   script or a route) has nothing to listen with, so its write is best-effort
 *   and can be lost in a handover.
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
      threadWrite.create(
        signLedgerData(client, threadWrite.name, {
          thread: hash,
          app: client.id,
          runId: outsideWriter,
          seq,
          change,
        }),
      ),
    );
  };

  const noOutside = (): never => {
    throw new Error(
      `Reading the ledger KV store needs a running function: a route or script can write it, not read it. ${storeFix}`,
    );
  };

  // The copy a read uses: synced between steps, as it stands inside one.
  const live = async (hash: string) => {
    const copy = copyOf(hash, false, options.client);

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

    await write(copyOf(hash, true, options.client), op);
  };

  const decide = async (hash: string, op: ThreadChange) => {
    if (!inFunction()) {
      return noOutside();
    }

    return conditional(copyOf(hash, true, options.client), op);
  };

  return {
    ledger: true,
    async get(hash, field) {
      if (!inFunction()) {
        return noOutside();
      }

      const { copy, view } = await live(hash);
      const found = liveKey(view, field, copy.clock)?.v;

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

      const { copy, view } = await live(hash);

      return Object.fromEntries(
        Object.keys(view.keys).flatMap((key) => {
          const found = liveKey(view, key, copy.clock);

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

    if (copy.echo && !copy.echo.closed) {
      await copy.echo.close();
    }
  }

  copies.delete(instance);
};
