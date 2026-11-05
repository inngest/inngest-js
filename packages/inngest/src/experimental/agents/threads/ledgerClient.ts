/**
 * @module
 * EXPERIMENTAL: `ledgerKvAdapter()`, the default KV store: how a run (or a
 * script) uses the ledger. See `ledger.ts` for the protocol.
 *
 * A run that needs the state of a KV scope instance subscribes first (an inbox
 * filtered by the instance's hash that never starts a run), then asks the
 * ledger once, and keeps a local copy. From then on one background reader
 * holds a single pending read of the subscription for the life of the run,
 * and applies each `agent/thread.write` of the instance (its own included) to
 * the copy as it arrives, resolving them with the same rule as the ledger, so
 * copies converge. Reads of the copy are plain memory: they never drain and
 * cost no step.
 *
 * Only a run that closes its copies on every way out (an agent run) gets the
 * reader; see `closesCopies`. Any other run drains its copy on the reads that
 * might see a write.
 *
 * Replay: a waiting read is an unfinished op beside every other step, so
 * steps are planned and the executor saves each message in the run's stack at
 * the place it arrived. A replay hands the message back at that place (when
 * the code is next quiet after the step that precedes it), so an arrival
 * changes the same read of the code on every replay.
 *
 * What the adapter cannot do, and says so by throwing an error that points at
 * a store adapter (`createAgents(client, { store })`):
 *
 * - write inside a step's callback (a read there comes from the copy the run
 *   already holds);
 * - read from outside a function (a route or a script can write by event);
 * - run a conditional write (`setIfAbsent`, `compareAndSet`, so also `update`
 *   and `take`): thread state here is eventually consistent, so there is no
 *   lock to build them on.
 *
 * Nothing here waits on a timer. A reader whose read found no live ledger asks
 * again when a ledger run says it is listening (`agent/thread.ready`), and a
 * writer sends again the writes that ready says the ledger lacks. Every event
 * this module sends is signed, and every one it takes in must be.
 */

import {
  getAsyncCtxSync,
  stepsIssued,
  withoutStepCount,
} from "../../../components/execution/als.ts";
import { step } from "../../../components/InngestStepTools.ts";
import {
  type Inbox,
  inboxOpenedPromise,
  type UntypedInboxMessage,
} from "../../../components/inbox/Inbox.ts";
import { NonRetriableError } from "../../../components/NonRetriableError.ts";
import { ledgerDataIsSigned, signLedgerData } from "../agent/relations.ts";
import type { KvIndexEntry, KvIndexRange, KvStore } from "../kv/kv.ts";
import {
  applyChange,
  ledgerIsServed,
  liveKey,
  overLimitMessage,
  resolveTtl,
  stateSize,
  type ThreadChange,
  type ThreadLedgerState,
  type ThreadReadyData,
  ThreadResolver,
  type ThreadStateData,
  type ThreadWriteData,
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
 * A write this run sent. It stays until the ledger is known to hold it.
 */
interface Sent {
  seq: number;
  change: ThreadChange;

  /**
   * The `ts` Inngest recorded for the write, once the run has heard it back.
   * A resend carries it so the resend orders where the first send did.
   */
  at?: number;
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

  /**
   * The run's execution, which says whether the copy may have a background
   * reader.
   */
  instance: object;

  /**
   * The resolved state: set once the copy has loaded. A run that only writes
   * holds none.
   */
  resolver?: ThreadResolver;

  /**
   * The time of the run's start event, in milliseconds: the clock until the
   * copy loads.
   */
  clock: number;

  /**
   * The writes sent that may not be in the ledger.
   */
  sent: Sent[];

  /**
   * The highest `seq` of this run's the ledger last said it holds.
   */
  ledgerLast: number;
  resend: boolean;
  justLoaded: boolean;

  /**
   * How many steps the run's code had called when it last drained, `undefined`
   * before the first drain. Only a copy with no background reader drains on
   * reads.
   */
  drainedAt?: number;

  /**
   * Whether the copy wrote since it last drained or closed.
   */
  dirty: boolean;

  /**
   * How many reads and resends this copy sent, which number their steps.
   */
  reads: number;
  resends: number;
  seq: number;
  sub?: Inbox;

  /**
   * The background reader of `sub`: settles once the subscription closes.
   */
  reader?: Promise<void>;

  /**
   * What stopped the reader, if anything did.
   */
  failure?: unknown;

  /**
   * What a run that only writes listens on: its own writes, to learn when
   * Inngest recorded them, and the news that a ledger run took over, so it can
   * send a write again.
   */
  echo?: Inbox;
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

/**
 * The stamp a run's own unheard writes take in its view: after everything
 * heard, in `seq` order.
 */
const newest = Number.MAX_SAFE_INTEGER;

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
      instance: execution.instance,
      clock: (execution.ctx.event as { ts?: number } | undefined)?.ts ?? 0,
      sent: [],
      ledgerLast: 0,
      resend: false,
      justLoaded: false,
      dirty: false,
      reads: 0,
      resends: 0,
      seq: 0,
      ready: false,
    };
    byThread.set(thread, found);
    copies.set(execution.instance, byThread);
  }

  return found;
};

/**
 * The time to judge expiry by.
 */
const clockOf = (copy: Copy): number => {
  return copy.resolver?.clock ?? copy.clock;
};

/**
 * The copy's state: what the copy has resolved, with the run's own writes it
 * has not heard back yet on top.
 */
const viewOf = (copy: Copy): ThreadLedgerState => {
  const resolver = copy.resolver;

  if (!resolver) {
    throw new Error("The ledger copy has not loaded");
  }

  if (!copy.view) {
    const view = structuredClone(resolver.state);
    const done = resolver.last.get(copy.runId) ?? 0;

    for (const { seq, change } of copy.sent) {
      if (seq > done) {
        applyChange(view, resolveTtl(change, resolver.clock), [
          newest,
          copy.runId,
          seq,
        ]);
      }
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

const writeOf = (
  copy: Copy,
  seq: number,
  change: ThreadChange,
  resend?: { at?: number; from: number },
) => {
  return threadWrite.create(
    signedBy(copy, threadWrite.name, {
      thread: copy.thread,
      app: copy.app,
      runId: copy.runId,
      seq,
      change,
      ...(resend && {
        from: resend.from,
        ...(resend.at !== undefined && { at: resend.at }),
      }),
    }),
  );
};

/**
 * Drops the writes the ledger and this copy both hold: nothing needs them
 * again.
 */
const prune = (copy: Copy): void => {
  const floor = Math.min(
    copy.ledgerLast,
    copy.resolver?.last.get(copy.runId) ?? copy.ledgerLast,
  );

  copy.sent = copy.sent.filter((p) => {
    return p.seq > floor;
  });
};

/**
 * Takes in the messages of the copy's inboxes: writes, resolved the way the
 * ledger resolves them, and the news that a ledger run is listening. An event
 * with no valid signature is dropped. What the messages call for (writes sent
 * again) is done by `settle`.
 */
const takeMessages = (copy: Copy, messages: UntypedInboxMessage[]): void => {
  for (const message of messages) {
    if (
      message.name !== threadWrite.name &&
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
      // What the ledger holds of this run's writes: it is the truth, also when
      // a ledger that started over holds less than an earlier one did.
      const ready = message.data as ThreadReadyData;

      copy.ledgerLast = ready.last[copy.runId] ?? 0;
      copy.resend = copy.sent.some((p) => {
        return p.seq > copy.ledgerLast;
      });

      continue;
    }

    const data = message.data as ThreadWriteData;

    if (data.runId === copy.runId) {
      const own = copy.sent.find((p) => {
        return p.seq === data.seq;
      });

      if (own && own.at === undefined) {
        own.at = data.at ?? message.ts;
      }
    }

    if (copy.resolver) {
      copy.resolver.take(data, message.ts);
      copy.view = undefined;
    }
  }
};

/**
 * Everything waiting in the copy's inboxes.
 */
const drainAll = async (copy: Copy): Promise<UntypedInboxMessage[]> => {
  const taken = [
    ...(copy.sub ? await copy.sub.drain() : []),
    ...(copy.echo ? await copy.echo.drain() : []),
  ];

  copy.dirty = false;
  copy.drainedAt = stepsIssued();

  return taken;
};

/**
 * The runs that close their copies before they end. A background reader leaves
 * a read waiting in the run, and the executor reports a waiting read when the
 * code finishes, so the run would not end: only a run that closes its copies
 * (`closeThreadCopies`) on every way out gets a reader. A copy of any other run
 * drains on the reads that might see a write.
 */
const closing = new WeakSet<object>();

/**
 * Says that the run closes its copies with `closeThreadCopies` on every way
 * out, so its copies may keep a background reader.
 * @param instance The run's execution (`execution.instance`).
 */
export const closesCopies = (instance: object): void => {
  closing.add(instance);
};

/**
 * The background reader: one pending read of the subscription for the life of
 * the run. Each arrival is applied to the copy where the executor saved it in
 * the run's stack, then the next read is made. The read waits as a single op
 * that costs nothing until a message arrives.
 */
const pump = async (copy: Copy): Promise<void> => {
  const sub = copy.sub as Inbox;

  try {
    while (true) {
      const message = await sub.next();

      if (message === undefined) {
        return;
      }

      takeMessages(copy, [message]);
      prune(copy);
    }
  } catch (error) {
    copy.failure = error;
  }
};

/**
 * Sends the writes the ledger lacks again, with the `seq` they had and the
 * time they were first recorded: a ledger or copy that already applied one
 * drops the copy it gets.
 */
const resendPending = async (copy: Copy): Promise<void> => {
  copy.resend = false;

  const todo = copy.sent.filter((p) => {
    return p.seq > copy.ledgerLast;
  });
  const first = todo[0];

  if (!first) {
    return;
  }

  copy.resends += 1;
  await step.sendEvent(
    `ledger-resend:${copy.thread}:${copy.resends}`,
    todo.map((p) => {
      return writeOf(copy, p.seq, p.change, { at: p.at, from: first.seq });
    }),
  );
};

/**
 * Reads the ledger's state: asks, and asks again each time a ledger run says
 * it is listening, until the answer comes. Writes that arrive meanwhile are
 * held and resolved on top of the answer.
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
        buffered.push(message);

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

    copy.resolver = new ThreadResolver({
      state: reply.state,
      last: reply.last,
      clock: copy.clock,
    });
    copy.ledgerLast = reply.last[runId] ?? 0;
    copy.view = undefined;

    // What this run wrote before it listened comes from its own inbox.
    takeMessages(copy, [
      ...(copy.echo ? await copy.echo.drain() : []),
      ...buffered,
    ]);
    prune(copy);

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
      event: threadWrite.name,
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

  // The read subscription hears every write the echo does.
  if (copy.echo) {
    await copy.echo.close();
    copy.echo = undefined;
  }

  copy.ready = true;
  copy.justLoaded = true;
};

/**
 * Starts the background reader of a loaded copy of a run that closes its
 * copies. It starts where the code is when the run says so, the same place on
 * every replay. Its reads are not counted as steps of the run's code: how far
 * it reads before a given point of the code depends on what the request
 * loaded, and a count that differs between replays would make an inbox drain
 * skip a read on one replay and not on another.
 */
const startReader = (copy: Copy): void => {
  if (copy.ready && !copy.reader && copy.sub && closing.has(copy.instance)) {
    copy.reader = withoutStepCount(() => {
      return pump(copy);
    });
  }
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
 * Does what the messages taken in call for: sends the writes the ledger lacks
 * again, after a ledger run says what it holds.
 */
const settle = async (copy: Copy): Promise<void> => {
  if (copy.resend) {
    await resendPending(copy);
  }
};

/**
 * Makes sure the copy is loaded. With a background reader what arrived is
 * already in the copy, so a read takes nothing in: only a resend a ledger
 * handover called for is done here. A copy with no reader takes in the writes
 * that arrived since the last access, and right after the load there is
 * nothing new to take in.
 */
const sync = async (copy: Copy): Promise<void> => {
  await ensure(copy);
  startReader(copy);

  if (copy.failure) {
    throw copy.failure;
  }

  if (copy.reader) {
    await settle(copy);

    return;
  }

  if (copy.justLoaded) {
    copy.justLoaded = false;
    await settle(copy);

    return;
  }

  const last = stepsIssued();

  if (last === undefined || last !== copy.drainedAt) {
    takeMessages(copy, await drainAll(copy));
    prune(copy);
  }

  await settle(copy);
};

/**
 * Sends a write. The write is in the copy's view at once. A run that holds the
 * state refuses a write past the size limit before it sends it; a run that has
 * not loaded the state sends it without loading, and the ledger enforces the
 * limit.
 */
const write = async (copy: Copy, change: ThreadChange): Promise<void> => {
  if (copy.ready) {
    const next = structuredClone(viewOf(copy));

    applyChange(next, resolveTtl(change, clockOf(copy)), [
      newest,
      copy.runId,
      copy.seq + 1,
    ]);

    const size = stateSize(next);

    if (size > threadStateLimit) {
      throw new Error(overLimitMessage(copy.thread, size));
    }
  }

  if (!copy.sub && !copy.echo) {
    // A run that never reads has no copy listening, so a write sent while a
    // ledger run hands over would be lost. It listens from its first write on.
    const { thread, app, runId } = copy;
    const mine = `async.data.thread == ${quoted(thread)} && async.data.app == ${quoted(app)}`;

    copy.echo = step.subscribe(`ledger-echo:${thread}`, [
      {
        event: threadWrite.name,
        if: `${mine} && async.data.runId == ${quoted(runId)}`,
      },
      { event: threadReady.name, if: mine },
    ]) as unknown as Inbox;
    await inboxOpenedPromise(copy.echo);
  } else {
    // A write listens for nothing: a ledger run that took over since says what
    // it lacks at the next read or when the run ends, which is when a drain
    // pays.
    await settle(copy);
  }

  copy.dirty = true;
  copy.seq += 1;

  const seq = copy.seq;

  copy.sent.push({ seq, change });
  copy.view = undefined;

  await step.sendEvent(
    `ledger-write:${copy.thread}:${seq}`,
    writeOf(copy, seq, change),
  );
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
    .flatMap(([member, found]) => {
      return found.del || found.s === undefined
        ? []
        : [{ member, score: found.s }];
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
 * The error the ledger adapter throws for a conditional write.
 */
export const conditionalOnLedger = (what: string): Error => {
  return new Error(
    `${what} is not available on the ledger KV store: thread state there is eventually consistent, a shared whiteboard with a small lag, not a lock. For anything agents must agree on, send a message to one owner. ${storeFix}`,
  );
};

/**
 * EXPERIMENTAL: The default KV store: thread state, `kv.app`, `kv.env` and the
 * agents' own records kept by ledger functions, one live run per KV scope
 * instance, with no outside service.
 *
 * Thread state on the ledger is eventually consistent. Think of it as a shared
 * whiteboard that every live run sees with a small lag, not as a lock: a write
 * reaches every copy as an `agent/thread.write` event, and everyone resolves
 * writes by one rule, so copies converge. For one key, the later write wins,
 * ordered by when Inngest recorded the event, then the writer, then the
 * writer's own write count. A value never goes backwards for a key, but two
 * writers racing on one key can each read their own write until the other's
 * arrives. For anything agents must agree on, send a message to one owner or
 * configure a store adapter. Prefer one writer per key.
 *
 * The store has no conditional writes: `setIfAbsent`, `compareAndSet`, `update`
 * and `take` throw an error that says to configure a store adapter. Store
 * adapters keep them.
 *
 * Serve `agents.functions()` so the ledger function runs. Limits:
 *
 * - Each instance holds up to 128 KB of JSON (agent history counts), and a
 *   write past it throws in a run that holds the state; a run that only writes
 *   does not hold it, so the ledger refuses the write and logs it.
 * - A ledger lives as a function run: it holds its state for as long as the
 *   platform lets a run wait, and hands over to a fresh run near Inngest's step
 *   limit (about 900 writes). A write sent during a handover is sent again by
 *   its writer when the next ledger run says what it holds, which a writer
 *   hears at its next access to the state. A writer outside any function (a
 *   script or a route) has nothing to listen with, so its write is best-effort
 *   and can be lost in a handover; its event time is also the sender's clock,
 *   not the platform's.
 * - A ledger belongs to one app: `kv.env` is shared by the functions of one app,
 *   not across apps.
 * - Writing inside a step's callback and reading outside a function throw an
 *   error that says to configure a store adapter.
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

  return {
    ledger: true,
    async get(hash, field) {
      if (!inFunction()) {
        return noOutside();
      }

      const { copy, view } = await live(hash);
      const found = liveKey(view, field, clockOf(copy))?.v;

      return found === undefined ? null : String(found);
    },
    async set(hash, field, value, ttl) {
      await change(hash, { op: "set", key: field, value, ...expiry(ttl) });
    },
    async setIfAbsent() {
      throw conditionalOnLedger("setIfAbsent");
    },
    async compareAndSet() {
      throw conditionalOnLedger("compareAndSet");
    },
    async delete(hash, field) {
      await change(hash, { op: "delete", key: field });
    },
    async all(hash) {
      if (!inFunction()) {
        return noOutside();
      }

      const { copy, view } = await live(hash);

      return Object.fromEntries(
        Object.keys(view.keys).flatMap((key) => {
          const found = liveKey(view, key, clockOf(copy));

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
 * Ends the run's subscriptions to ledger writes. An agent run calls it when
 * its work is done.
 * @param instance The run's execution (`execution.instance`).
 */
export const closeThreadCopies = async (instance: object): Promise<void> => {
  for (const copy of copies.get(instance)?.values() ?? []) {
    if (copy.reader && copy.sub) {
      // Closing ends the reader's pending read and hands back what the
      // reader did not take. The last writes may have met a handover: hear it
      // before leaving.
      const unread = copy.sub.closed ? [] : await copy.sub.close();

      await copy.reader;
      takeMessages(copy, unread);
      prune(copy);
      await settle(copy);
    } else if (copy.dirty && (copy.sub || copy.echo)) {
      // A run that only writes holds no reader: hear what its echo holds.
      takeMessages(copy, await drainAll(copy));
      prune(copy);
      await settle(copy);
    }

    if (copy.sub && !copy.sub.closed) {
      await copy.sub.close();
    }

    if (copy.echo && !copy.echo.closed) {
      await copy.echo.close();
    }
  }

  copies.delete(instance);
};
