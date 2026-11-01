/**
 * @module
 * EXPERIMENTAL: the `Inbox` returned by `step.subscribe()`.
 *
 * An inbox receives the events that match its sources, one saved message per
 * event, and is read in order. Where the reader is lives only here: every
 * replay rebuilds it from the run's state, which holds the messages (saved by
 * the executor as they arrive) and nothing else. A read with an unread message
 * returns it in process. A read with none reports a wait to the executor, which
 * wakes the run when a message arrives; the replay then finds the message in
 * state.
 */
import type { EventPayload } from "../../types.ts";
import type { InboxRead, Want } from "../execution/inboxState.ts";

/**
 * One kind of event an inbox receives, written like a function trigger.
 */
export interface InboxSource {
  /**
   * The event to receive: its name, or an event type.
   */
  event: string | { name: string };

  /**
   * An expression the event must match, like the `if` of `waitForEvent`. The
   * arriving event is `async`: `async.data.thread == "t1"`.
   */
  if?: string;
}

type OneSource = string | { name: string } | InboxSource;

/**
 * One source or several.
 */
export type InboxSources = OneSource | readonly OneSource[];

/**
 * What the executor is told about a source.
 */
export interface OpenedSource {
  event: string;
  if?: string;
}

/**
 * Turns the sources a user passed into what is sent to the executor.
 */
export const sourcesOf = (sources: InboxSources): OpenedSource[] => {
  const list: readonly OneSource[] = isList(sources) ? sources : [sources];

  return list.map((source) => {
    if (typeof source === "string") {
      return { event: source };
    }

    if ("event" in source) {
      const name =
        typeof source.event === "string" ? source.event : source.event.name;

      return source.if === undefined
        ? { event: name }
        : { event: name, if: source.if };
    }

    return { event: source.name };
  });
};

const isList = (sources: InboxSources): sources is readonly OneSource[] => {
  return Array.isArray(sources);
};

/**
 * One event type or several, by name or as an event type.
 */
export type InboxTypes =
  | string
  | { name: string }
  | readonly (string | { name: string })[];

const namesOf = (types: InboxTypes): string[] => {
  const list: readonly (string | { name: string })[] = Array.isArray(types)
    ? types
    : [types as string | { name: string }];

  return list.map((type) => {
    return typeof type === "string" ? type : type.name;
  });
};

/**
 * The ID of the op of the `n`th read of a reader.
 */
const readId = (base: string, n: number): string => {
  return n === 0 ? `${base}:next` : `${base}:next:${n}`;
};

/**
 * The ID of the op of the `n`th `listen()` of a reader.
 */
const listenId = (base: string, n: number): string => {
  return n === 0 ? `${base}:listen` : `${base}:listen:${n}`;
};

/**
 * The ID of the op that closes a reader.
 */
const closeId = (base: string): string => {
  return `${base}:close`;
};

/**
 * What an inbox needs from the step tools and the run's state. Ops are named by
 * the unhashed ID of the op; every reader (the inbox and each view) has a base
 * ID its ops are named from.
 */
export interface InboxDeps {
  sources: OpenedSource[];

  /**
   * The unhashed ID of the op that opens the inbox: the base of the inbox's own
   * reads.
   */
  id: string;

  /**
   * The ID the executor knows the opening op by. Messages carry it.
   */
  inbox: string;

  /**
   * Opens the inbox on the executor, or with `inbox` set adds the sources of a
   * view to the inbox with that ID. Settles with what the executor recorded
   * (the pauses of the sources) once the run has replayed past the record.
   */
  open: (
    op: string,
    sources: OpenedSource[],
    inbox?: string,
  ) => Promise<unknown>;

  /**
   * The hashed ID of the wait op `op`. It is known before the op is reported, so
   * the run's state can be asked whether the read timed out.
   */
  waitId: (op: string) => string;

  /**
   * Reports the read `op`, which has nothing unread. Never settles in the
   * request that reports it, unless the read timed out: then it settles with
   * `null`. A timeout is a duration or a timestamp, like the one of
   * `waitForEvent`.
   */
  wait: (
    op: string,
    inbox: string,
    seen: string,
    want?: Want,
    timeout?: ReadTimeout,
  ) => Promise<unknown>;

  /**
   * What the read after the first `taken` messages the reader wants finds in the
   * run's state.
   */
  read: (inbox: string, taken: number, wait: string, want?: Want) => InboxRead;

  /**
   * The step ids of the messages the reader wants after the first `taken` of
   * them, in the order they were saved.
   */
  unread: (inbox: string, taken: number, want?: Want) => string[];

  /**
   * The event of a message step.
   */
  message: (id: string) => unknown;

  /**
   * Saves the batch of the read `op` as an ordinary step. `take` runs only when the
   * step is new, and returns the ids of the messages the batch takes; a replay
   * returns the ids saved the first time.
   */
  record: (op: string, take: () => string[]) => Promise<string[]>;

  /**
   * Marks a wait op as seen without requesting it. A timeout that lost to a
   * message is saved in state and never asked for.
   */
  skip: (op: string) => Promise<void>;

  /**
   * The last step of the run's stack that this request loaded.
   */
  lastSeen: () => string;

  /**
   * Whether the run's state holds the close of the op `op`. The close is
   * recorded by the executor, so it is known to every replay after it.
   */
  closed: (op: string) => boolean;

  /**
   * Closes a reader. Settles with the ids the executor saved: those of the
   * first close that reached it, which are the ones every replay returns.
   */
  close: (
    op: string,
    closing: {
      inbox: string;
      ids: string[];
      pauses: { id: string; event: string }[];
      waits: string[];
    },
  ) => Promise<string[]>;
}

/**
 * What makes an inbox a view of another.
 *
 * @internal
 */
interface ViewInit<TMessage> {
  parent: Inbox<TMessage>;

  /**
   * The base ID of the view's ops.
   */
  base: string;

  /**
   * The event names an `of()` view reads, within its parent's.
   */
  events?: readonly string[];

  /**
   * The sources a `listen()` view adds, and the ID of its op.
   */
  listen?: { op: string; sources: OpenedSource[] };
}

/**
 * How long a read waits for a message: milliseconds, an `ms`-compatible string
 * like `"30s"`, or a `Date`.
 */
export type ReadTimeout = number | string | Date;

/**
 * Options of a read.
 */
export interface ReadOptions {
  /**
   * The read returns `null` if no message arrives in this time.
   */
  timeout: ReadTimeout;
}

/**
 * Options of a batch read.
 */
export interface BatchOptions {
  /**
   * Takes at most this many messages, oldest first; the rest stays unread.
   */
  max?: number;
}

/**
 * A durable collection of the events that matched the sources of one
 * `step.subscribe()`, or a view of one. Open it with `await using` so it closes
 * at the end of the block.
 *
 * Every reader (the inbox and each view) sees every message it matches, and
 * keeps its own position: nothing one reader takes is hidden from another.
 */
export class Inbox<TMessage = EventPayload> implements AsyncDisposable {
  #deps: InboxDeps;
  #opened: Promise<void>;

  // The base of the ops of this reader's reads and views.
  #base: string;

  // Set on a view.
  #parent?: Inbox<TMessage>;

  // The event names this reader wants, when it is an `of()` view.
  #events?: readonly string[];

  // Whether this reader is a `listen()` view, which wants its own sources.
  #listening = false;

  // The pauses of the sources this reader added, from its record, and the
  // event each one receives.
  #pauses: string[] = [];
  #sources: { id: string; event: string }[] = [];

  // Set once this reader's own `close()` has settled.
  #closed = false;

  // The close of this reader, once started.
  #closing?: Promise<string[]>;

  // The ops of the reads that have started and not settled.
  #unsettled = new Set<string>();

  // Views made from this reader.
  #children: Inbox<TMessage>[] = [];

  // The `of()` views of this reader by the event names they read, so that the
  // same filter is the same reader.
  #views = new Map<string, Inbox<TMessage>>();

  // `listen()` calls made on this reader so far; each has an op of its own.
  #listens = 0;

  // Messages taken by reads so far in this replay.
  #taken = 0;

  // Reads started so far. Each has an op of its own, named by this number, so
  // that its place in the run's state is known before it is reported.
  #reads = 0;

  // Reads on one reader are served in order, like an async generator's.
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: InboxDeps, view?: ViewInit<TMessage>) {
    this.#deps = deps;
    this.#base = view?.base ?? deps.id;
    this.#parent = view?.parent;
    this.#events = view?.events;

    if (view?.listen) {
      this.#listening = true;

      this.#opened = deps
        .open(view.listen.op, view.listen.sources, deps.inbox)
        .then((record) => {
          this.#record(view.listen?.sources ?? [], record);

          return undefined;
        });
    } else if (view) {
      this.#opened = Promise.resolve();
    } else {
      this.#opened = deps.open(deps.id, deps.sources).then((record) => {
        this.#record(deps.sources, record);

        return undefined;
      });
    }

    // A failed open is reported where the inbox is read; this keeps it from
    // also being reported as unhandled.
    this.#opened.catch(() => {
      return undefined;
    });
  }

  // The record of an open lists the pauses of the sources, in their order.
  #record(sources: OpenedSource[], record: unknown): void {
    this.#pauses = (record as { pauses?: string[] } | null)?.pauses ?? [];
    this.#sources = this.#pauses.map((id, i) => {
      return { id, event: sources[i]?.event ?? "" };
    });
  }

  /**
   * Whether this reader is closed: it was closed, or a reader it is a view of
   * was. A closed reader reads nothing.
   */
  get closed(): boolean {
    return this.#closed || (this.#parent?.closed ?? false);
  }

  /**
   * A view of the messages of these event types. Calling it again with the same
   * types gives the same reader, wherever it is called, and a view reads from
   * the start of the inbox.
   */
  of(types: InboxTypes): Inbox<TMessage> {
    const names = [...new Set(namesOf(types))].sort();
    const events = this.#events
      ? names.filter((name) => {
          return this.#events?.includes(name);
        })
      : names;
    const key = events.join("\n");

    let view = this.#views.get(key);
    if (!view) {
      view = new Inbox<TMessage>(this.#deps, {
        parent: this,
        base: `${this.#base}:of:${events.join(",")}`,
        events,
      });
      this.#views.set(key, view);
      this.#children.push(view);
    }

    return view;
  }

  /**
   * Adds sources to the inbox and returns a view over just them. Each call adds
   * its own sources, even if another view has the same.
   */
  listen(sources: InboxSources): Inbox<TMessage> {
    const op = listenId(this.#base, this.#listens);
    this.#listens += 1;

    const view = new Inbox<TMessage>(this.#deps, {
      parent: this,
      base: op,
      listen: { op, sources: sourcesOf(sources) },
    });
    this.#children.push(view);

    return view;
  }

  /**
   * The pauses of this reader's sources and of every view's under it.
   */
  #sourcePauses(): string[] {
    return [
      ...this.#pauses,
      ...this.#children.flatMap((child) => {
        return child.#sourcePauses();
      }),
    ];
  }

  /**
   * The source pauses of this reader and of every view under it, with their
   * events, which a close deletes.
   */
  #closingPauses(): { id: string; event: string }[] {
    return [
      ...this.#sources,
      ...this.#children.flatMap((child) => {
        return child.#closingPauses();
      }),
    ];
  }

  /**
   * The reads of this reader and of every view under it that have not settled.
   */
  #closingReads(): string[] {
    return [
      ...this.#unsettled,
      ...this.#children.flatMap((child) => {
        return child.#closingReads();
      }),
    ];
  }

  /**
   * Whether the run's state holds the close of this reader or of one it is a
   * view of. Reads that were waiting end then: they find nothing, and nothing
   * will wake them.
   */
  #closedInState(): boolean {
    if (this.#deps.closed(closeId(this.#base))) {
      return true;
    }

    return this.#parent ? this.#parent.#closedInState() : false;
  }

  /**
   * What this reader wants of the inbox's messages: a `listen()` view and any
   * `of()` view under it want the messages that came through the sources of the
   * nearest `listen()` view, and an `of()` view wants its event names.
   */
  #want(): Want | undefined {
    let owner: Inbox<TMessage> | undefined = this;
    while (owner && !owner.#listening) {
      owner = owner.#parent;
    }

    const want: Want = {};
    if (owner) {
      want.src = owner.#sourcePauses();
    }
    if (this.#events) {
      want.events = this.#events;
    }

    return want.src || want.events ? want : undefined;
  }

  /**
   * Settles once the opens of this reader, of the readers it is a view of, and
   * of the views under it have been replayed past: until then the sources a
   * filter names are not known.
   */
  async #ready(): Promise<void> {
    await Promise.all([this.#openedAbove(), this.#openedBelow()]);
  }

  async #openedAbove(): Promise<void> {
    await this.#opened;

    if (this.#parent) {
      await this.#parent.#openedAbove();
    }
  }

  async #openedBelow(): Promise<void> {
    await Promise.all([
      this.#opened,
      ...this.#children.map((child) => {
        return child.#openedBelow();
      }),
    ]);
  }

  /**
   * Returns the next unread message. If none is unread, waits for one to
   * arrive. Returns `undefined` once the reader is closed, also for a read
   * that was waiting when it closed.
   */
  next(): Promise<TMessage | undefined>;

  /**
   * Returns the next unread message, `null` if none arrives in time, or
   * `undefined` once the reader is closed.
   */
  next(options: ReadOptions): Promise<TMessage | null | undefined>;
  next(options?: ReadOptions): Promise<TMessage | null | undefined> {
    return this.#enqueue((n) => {
      return this.#readOne(n, options?.timeout);
    });
  }

  /**
   * Returns every unread message, waiting for at least one to arrive. The batch
   * is one small step listing the messages it took. A closed reader, or one
   * that closes while this waits, returns an empty array.
   */
  nextBatch(options?: BatchOptions): Promise<TMessage[]> {
    return this.#enqueue((n) => {
      return this.#readBatch(n, options?.max, true);
    });
  }

  /**
   * Returns every unread message without waiting: an empty array if there is
   * none. The read is still saved as a step, so a replay returns the same set.
   */
  drain(options?: BatchOptions): Promise<TMessage[]> {
    return this.#enqueue((n) => {
      return this.#readBatch(n, options?.max, false);
    });
  }

  /**
   * Reads the inbox batch by batch with `for await`. Each batch waits for at
   * least one message. The loop ends when the reader closes or the code
   * breaks out of it.
   */
  async *batches(
    options?: BatchOptions,
  ): AsyncGenerator<TMessage[], void, undefined> {
    while (true) {
      const batch = await this.nextBatch(options);

      if (batch.length === 0) {
        return;
      }

      yield batch;
    }
  }

  // Reads on one inbox are served in order. Each gets its own number `n`.
  #enqueue<T>(read: (n: number) => Promise<T>): Promise<T> {
    const n = this.#reads;
    this.#reads += 1;

    // The read is unsettled from the moment it starts, so a close that comes
    // before the read reports its wait still names it.
    const op = this.#deps.waitId(readId(this.#base, n));
    this.#unsettled.add(op);

    const result = this.#queue
      .then(() => {
        return read(n);
      })
      .finally(() => {
        this.#unsettled.delete(op);
      });

    this.#queue = result.catch(() => {
      return undefined;
    });

    return result;
  }

  async #readBatch(
    n: number,
    max: number | undefined,
    wait: boolean,
  ): Promise<TMessage[]> {
    if (this.closed) {
      return [];
    }

    await this.#ready();

    const op = readId(this.#base, n);
    const want = this.#want();

    if (
      wait &&
      this.#deps.unread(this.#deps.inbox, this.#taken, want).length === 0
    ) {
      // Nothing will wake a read of a reader that was closed.
      if (this.#closedInState()) {
        return [];
      }

      // Nothing is unread. The executor wakes the run when a message arrives,
      // and the replay finds it in state, so this does not settle here.
      await this.#deps.wait(op, this.#deps.inbox, this.#deps.lastSeen(), want);
    }

    const ids = await this.#deps.record(op, () => {
      const unread = this.#deps.unread(this.#deps.inbox, this.#taken, want);

      return max === undefined ? unread : unread.slice(0, max);
    });

    this.#taken += ids.length;

    return ids.map((id) => {
      return this.#deps.message(id) as TMessage;
    });
  }

  async #readOne(
    n: number,
    timeout?: ReadTimeout,
  ): Promise<TMessage | null | undefined> {
    if (this.closed) {
      return undefined;
    }

    await this.#ready();

    const op = readId(this.#base, n);
    const want = this.#want();

    const found = this.#deps.read(
      this.#deps.inbox,
      this.#taken,
      this.#deps.waitId(op),
      want,
    );

    if (found.found === "message") {
      this.#taken += 1;

      if (found.timedOut) {
        await this.#deps.skip(op);
      }

      return found.message as TMessage;
    }

    // The reader was closed while this read had nothing to read: it ends.
    if (found.found === "nothing" && this.#closedInState()) {
      return undefined;
    }

    // Nothing is unread. The executor wakes the run when a message arrives and
    // the replay finds it in state, so this does not settle in this request. A
    // read that timed out settles with the null the executor saved.
    const answer = await this.#deps.wait(
      op,
      this.#deps.inbox,
      this.#deps.lastSeen(),
      want,
      timeout,
    );

    return answer as TMessage | null;
  }

  /**
   * Reads the inbox in order with `for await`. The loop ends when the reader
   * closes or the code breaks out of it.
   */
  async *[Symbol.asyncIterator](): AsyncGenerator<TMessage, void, undefined> {
    while (true) {
      const message = await this.next();

      if (message === undefined) {
        return;
      }

      yield message;
    }
  }

  /**
   * Closes this reader and everything under it: the sources it added stop
   * receiving, every read waiting under it ends with `undefined`, and it
   * returns the messages it had not read. A view keeps its own unread
   * messages when a reader above it closes, and returns them from its own
   * `close()`. Closing a `listen()` view leaves the inbox's copies; closing an
   * `of()` view ends only that reader.
   */
  close(): Promise<TMessage[]> {
    this.#closing ??= this.#close();

    return this.#closing.then((ids) => {
      return ids.map((id) => {
        return this.#deps.message(id) as TMessage;
      });
    });
  }

  async #close(): Promise<string[]> {
    await this.#ready();

    const ids = await this.#deps.close(closeId(this.#base), {
      inbox: this.#deps.inbox,
      ids: this.#deps.unread(this.#deps.inbox, this.#taken, this.#want()),
      pauses: this.#closingPauses(),
      waits: this.#closingReads(),
    });

    this.#closed = true;

    return ids;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
