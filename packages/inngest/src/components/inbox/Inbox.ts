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
import { asyncDispose } from "../../helpers/asyncDispose.ts";
import type { EventPayload } from "../../types.ts";
import type { InboxRead } from "../execution/inboxState.ts";
import type { EventTypeWithAnySchema } from "../triggers/triggers.ts";
import { addEventIs } from "../triggers/triggers.ts";
import type { EventIs, EventTypeToShape } from "../triggers/typeHelpers.ts";

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
 * The message of one event type, or of a source that is not one: a name, or an
 * object with only a name, has no schema, so its messages are the default
 * `InboxMessage`, whose `data` is `unknown` because nothing says what it is.
 */
type TypedMessage<TEvent> = TEvent extends EventTypeWithAnySchema<string>
  ? EventTypeToShape<TEvent> & EventIs
  : InboxMessage;

// An event type has an `event` field of its own (its name), so it is checked
// before the `{ event, if }` form.
type SourceMessage<TSource> = TSource extends EventTypeWithAnySchema<string>
  ? TypedMessage<TSource>
  : TSource extends { event: infer TEvent }
    ? TypedMessage<TEvent>
    : TypedMessage<TSource>;

/**
 * The messages the sources of an inbox produce: the union of the shapes of the
 * event types among them. A source written as a name contributes the untyped
 * message. Exported mainly so declaration files can name inbox types.
 */
export type InboxMessageOf<TSources> = TSources extends readonly (infer TItem)[]
  ? SourceMessage<TItem>
  : SourceMessage<TSources>;

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

// The promise that settles once each inbox is open. It lives here, not on the
// class, so nothing internal is part of the public declaration.
const openedPromises = new WeakMap<object, Promise<void>>();

/**
 * Settles once the executor has recorded the open of `inbox`. Code that does
 * other work before its first read awaits it, so that work does not share a
 * request with the open. Internal: the package root does not export it.
 */
export const inboxOpenedPromise = (inbox: object): Promise<void> => {
  return openedPromises.get(inbox) ?? Promise.resolve();
};

// What each inbox asks about its state: whether messages are saved that no read
// has taken yet. Kept here so nothing internal is part of the declaration.
const unreadChecks = new WeakMap<object, () => boolean>();

/**
 * Whether the run's state holds messages of `inbox` that no read has taken yet.
 * They are delivered to the read that is waiting, so a reader that is about to
 * stop waits for it instead. Internal: the package root does not export it.
 */
export const inboxHasUnread = (inbox: object): boolean => {
  return unreadChecks.get(inbox)?.() ?? false;
};

/**
 * The ID of the op of the `n`th read of an inbox.
 */
const readId = (base: string, n: number): string => {
  return n === 0 ? `${base}:next` : `${base}:next:${n}`;
};

/**
 * The ID of the op that closes an inbox.
 */
const closeId = (base: string): string => {
  return `${base}:close`;
};

/**
 * What an inbox is called once its opening op has its final ID. The engine adds
 * a suffix to the ID of a step the run already has (`inbox:1`), so this is
 * known only after the op has settled, and every other op of the inbox is named
 * from it: two inboxes opened with the same ID in one run do not share one.
 */
export interface OpenedInbox {
  /**
   * The unhashed ID of the opening op: the base of the IDs of its reads and
   * its close.
   */
  id: string;

  /**
   * The ID the executor knows the opening op by. Messages carry it.
   */
  inbox: string;
}

/**
 * What an inbox needs from the step tools and the run's state. Ops are named by
 * the unhashed ID of the op, which every op of the inbox is named from.
 */
export interface InboxDeps {
  sources: OpenedSource[];

  /**
   * The ID the user gave the inbox, which names the op that opens it. A run
   * that already has a step with this ID gives the opening op a suffix, so
   * nothing else is named from this: see {@link OpenedInbox}.
   */
  id: string;

  /**
   * Opens the inbox on the executor. Settles with the final identity of the
   * opening op once the run has replayed past the executor's record.
   */
  open: (op: string, sources: OpenedSource[]) => Promise<OpenedInbox>;

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
    timeout?: ReadTimeout,
  ) => Promise<unknown>;

  /**
   * What the read after the first `taken` messages finds in the run's state.
   */
  read: (inbox: string, taken: number, wait: string) => InboxRead;

  /**
   * The step ids of the messages after the first `taken` of them, in the order
   * they were saved. With `upTo`, only the steps of the stack as far as that
   * step are read.
   */
  unread: (inbox: string, taken: number, upTo?: string) => string[];

  /**
   * Reports the batch read `op`. The executor answers it with a cut: the last
   * message the read covers (`{ cut }`, saved under the op), or `{ cut: null }`
   * if there is none, and wakes the run. It answers with `null` if the timeout
   * passed with nothing unread. A `drain` is always answered at once; a read
   * waits only if it is not a `drain`, the SDK holds no `unread` messages and none
   * was saved since.
   */
  batch: (
    op: string,
    read: {
      inbox: string;
      seen: string;
      drain: boolean;
      unread: boolean;
      max?: number;
      timeout?: ReadTimeout;
    },
  ) => Promise<unknown>;

  /**
   * Whether the run's state holds the answer to the op `op`.
   */
  answered: (op: string) => boolean;

  /**
   * The event of a message step.
   */
  message: (id: string) => unknown;

  /**
   * Tells the executor which messages the read `op` took, so it can draw them.
   * `draw` says the read has no row yet because nothing waited or ran for it;
   * otherwise `row` is the op whose row they go under.
   */
  report: (
    op: string,
    inbox: string,
    messages: string[],
    draw: boolean,
    row?: string,
  ) => void;

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
   * Closes the inbox. Settles with the cut the executor saved: the last message
   * the inbox had at the first close that reached it, or `null`.
   */
  close: (op: string, closing: { inbox: string }) => Promise<Cut>;

  /**
   * Settles when replay reaches the message step `id` in the run's stack. A read
   * answered from state settles here, so a race between it and a step has the
   * same winner on every replay.
   */
  place: (id: string) => Promise<void>;
}

/**
 * The last message step an answer of the executor covers, or `null` if there is
 * none.
 */
export interface Cut {
  cut: string | null;
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
 * What an inbox yields when no source narrows it: the event with `data` left
 * `unknown` until `is()` narrows it. Exported mainly so declaration files can
 * name inbox types.
 */
export type UntypedInboxMessage = Omit<EventPayload, "data"> & {
  data: unknown;
} & EventIs;

/**
 * The type of the messages an inbox reads, so code can name it. Without a
 * type argument it is what an inbox hands back by default.
 *
 * @example
 * ```ts
 * const handle = (message: InboxMessage<typeof inbox>) => {};
 * ```
 */
export type InboxMessage<TInbox = Inbox<UntypedInboxMessage>> =
  TInbox extends Inbox<infer TMessage> ? TMessage : never;

/**
 * A durable collection of the events that matched the sources of one
 * `step.subscribe()`. Open it with `await using` so it closes at the end of the
 * block.
 *
 * An inbox has one reader: nothing is read twice, and reads are served in the
 * order they were made.
 */
export class Inbox<TMessage = UntypedInboxMessage> implements AsyncDisposable {
  private _deps: InboxDeps;
  private _opened: Promise<OpenedInbox>;

  // Set once `close()` has been called, settled or not. A read made after it
  // takes a message it can already read, and otherwise ends.
  private _closeCalled = false;

  // Set once `close()` has settled.
  private _closed = false;

  // Settles once `close()` has settled.
  private _whenClosed: Promise<void>;
  private _markClosed: () => void = () => undefined;

  // The close, once started.
  private _closing?: Promise<string[]>;

  // Messages taken by reads so far in this replay.
  private _taken = 0;

  // Reads started so far. Each has an op of its own, named by this number, so
  // that its place in the run's state is known before it is reported.
  private _reads = 0;

  // Reads are served in order, like an async generator's.
  private _queue: Promise<unknown> = Promise.resolve();

  constructor(deps: InboxDeps) {
    this._deps = deps;
    this._whenClosed = new Promise<void>((resolve) => {
      this._markClosed = resolve;
    });
    this._opened = deps.open(deps.id, deps.sources);

    let ready: OpenedInbox | undefined;

    unreadChecks.set(this, () => {
      return (
        ready !== undefined &&
        this._deps.unread(ready.inbox, this._taken).length > 0
      );
    });

    const settled = this._opened.then((opened) => {
      ready = opened;

      return undefined;
    });

    openedPromises.set(this, settled);

    // A failed open is reported where the inbox is read; this keeps it from
    // also being reported as unhandled.
    settled.catch(() => {
      return undefined;
    });
  }

  /**
   * Whether the inbox is closed. A closed inbox reads nothing.
   */
  get closed(): boolean {
    return this._closed;
  }

  /**
   * Returns the next unread message. If none is unread, waits for one to
   * arrive. Returns `undefined` once the inbox is closed, also for a read that
   * was waiting when it closed.
   */
  next(): Promise<TMessage | undefined>;

  /**
   * Returns the next unread message, `null` if none arrives in time, or
   * `undefined` once the inbox is closed.
   */
  next(options: ReadOptions): Promise<TMessage | null | undefined>;
  next(options?: ReadOptions): Promise<TMessage | null | undefined> {
    return this._enqueue((n, afterClose) => {
      return this._readOne(n, afterClose, options?.timeout);
    });
  }

  /**
   * Returns every unread message, waiting for at least one to arrive, or `null`
   * if none arrives in time. Returns `undefined` once the inbox is closed.
   */
  nextBatch(
    options: BatchOptions & ReadOptions,
  ): Promise<TMessage[] | null | undefined>;

  /**
   * Returns every unread message, waiting for at least one to arrive. The batch
   * is one small step naming the last message it took. A closed inbox, or one
   * that closes while this waits, returns `undefined`.
   */
  nextBatch(options?: BatchOptions): Promise<TMessage[] | undefined>;
  nextBatch(
    options?: BatchOptions & Partial<ReadOptions>,
  ): Promise<TMessage[] | null | undefined> {
    return this._enqueue((n, afterClose) => {
      return this._readBatch(
        n,
        afterClose,
        options?.max,
        true,
        options?.timeout,
      );
    });
  }

  /**
   * Returns every unread message without waiting: an empty array if there is
   * none. The read is still saved as a step, so a replay returns the same set.
   */
  drain(options?: BatchOptions): Promise<TMessage[]> {
    return this._enqueue(async (n, afterClose) => {
      return (await this._readBatch(n, afterClose, options?.max, false)) ?? [];
    });
  }

  /**
   * Reads the inbox batch by batch with `for await`. Each batch waits for at
   * least one message. The loop ends when the inbox closes, when a wait passes
   * `timeout` with nothing unread, or when the code breaks out of it.
   */
  async *batches(
    options?: BatchOptions & Partial<ReadOptions>,
  ): AsyncGenerator<TMessage[], void, undefined> {
    while (true) {
      const batch = await this._enqueue((n, afterClose) => {
        return this._readBatch(
          n,
          afterClose,
          options?.max,
          true,
          options?.timeout,
        );
      });

      if (batch === undefined || batch === null) {
        return;
      }

      yield batch;
    }
  }

  // Reads are served in order. Each gets its own number `n`, and knows whether
  // `close()` had been called when it was made.
  private _enqueue<T>(
    read: (n: number, afterClose: boolean) => Promise<T>,
  ): Promise<T> {
    const n = this._reads;
    this._reads += 1;

    const afterClose = this._closeCalled;

    const result = this._queue.then(() => {
      return read(n, afterClose);
    });

    this._queue = result.catch(() => {
      return undefined;
    });

    return result;
  }

  private async _readBatch(
    n: number,
    afterClose: boolean,
    max: number | undefined,
    wait: boolean,
    timeout?: ReadTimeout,
  ): Promise<TMessage[] | null | undefined> {
    if (this._closed) {
      return wait ? undefined : [];
    }

    const { id, inbox } = await this._opened;

    const op = readId(id, n);
    const held = this._deps.unread(inbox, this._taken);

    // A read that finds nothing and whose inbox was closed, or whose close was
    // called before the read started, ends instead of waiting.
    if (
      wait &&
      held.length === 0 &&
      !this._deps.answered(op) &&
      (afterClose || this._closedInState(id))
    ) {
      await this._whenClosed;

      return undefined;
    }

    // The executor answers with the last message the read covers. The answer is
    // the read's record: a replay reads the same messages from the state it
    // loaded.
    const answer = (await this._deps.batch(op, {
      inbox,
      seen: this._deps.lastSeen(),
      drain: !wait,
      unread: held.length > 0,
      ...(max === undefined ? {} : { max }),
      ...(timeout === undefined ? {} : { timeout }),
    })) as Cut | null;

    // The timeout passed with nothing unread.
    if (answer === null) {
      return null;
    }

    const covered =
      answer.cut === null
        ? []
        : this._deps.unread(inbox, this._taken, answer.cut);
    const ids = max === undefined ? covered : covered.slice(0, max);

    this._taken += ids.length;

    this._deps.report(`${op}:read`, inbox, ids, true, op);

    return ids.map((id) => {
      return addEventIs(this._deps.message(id) as object) as TMessage;
    });
  }

  /**
   * Draws the read of a message that came from the run's own state and not
   * from this inbox, such as the event that started the run: it gets a row like
   * any read answered from state, and costs no step. Internal.
   */
  noteStart(): void {
    // Only the trace needs this row, so the read does not wait for the open.
    void this._opened
      .then(({ id, inbox }) => {
        this._deps.report(`${id}:start`, inbox, [], true);
      })
      .catch(() => {
        // A failed open surfaces on the reads themselves.
      });
  }

  private async _readOne(
    n: number,
    afterClose: boolean,
    timeout?: ReadTimeout,
  ): Promise<TMessage | null | undefined> {
    if (this._closed) {
      return undefined;
    }

    const { id, inbox } = await this._opened;

    const op = readId(id, n);

    const found = this._deps.read(inbox, this._taken, this._deps.waitId(op));

    if (found.found === "message") {
      this._taken += 1;

      if (found.timedOut) {
        await this._deps.skip(op);
      }

      this._deps.report(op, inbox, [found.id], true);

      await this._deps.place(found.id);

      return addEventIs(found.message as object) as TMessage;
    }

    // The inbox was closed while this read had nothing to read, or its close
    // was called before the read started: it ends. The close op cannot name a
    // read that started after it, so a wait here would never be ended.
    if (found.found === "nothing" && (afterClose || this._closedInState(id))) {
      await this._whenClosed;

      return undefined;
    }

    // Nothing is unread. The executor wakes the run when a message arrives and
    // the replay finds it in state, so this does not settle in this request. A
    // read that timed out settles with the null the executor saved.
    const answer = await this._deps.wait(
      op,
      inbox,
      this._deps.lastSeen(),
      timeout,
    );

    if (answer === null) {
      return null;
    }

    return addEventIs(answer as object) as TMessage;
  }

  /**
   * Whether the run's state holds the close. Nothing will wake a read that
   * finds nothing then: it ends in the place of the close, after the steps that
   * came before it, so a race against a step has the same winner on every
   * replay.
   */
  private _closedInState(
    id: string, // the unhashed ID of the op that opened the inbox
  ): boolean {
    return this._deps.closed(closeId(id));
  }

  /**
   * Reads the inbox in order with `for await`. The loop ends when the inbox
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
   * Closes the inbox: its sources stop receiving, every read waiting ends with
   * `undefined`, and it returns the messages that were not read. A read made
   * after this call that would have to wait ends with `undefined`.
   */
  close(): Promise<TMessage[]> {
    this._closeCalled = true;
    this._closing ??= this._close();

    return this._closing.then((ids) => {
      return ids.map((id) => {
        return addEventIs(this._deps.message(id) as object) as TMessage;
      });
    });
  }

  private async _close(): Promise<string[]> {
    const { id, inbox } = await this._opened;

    const { cut } = await this._deps.close(closeId(id), { inbox });

    this._closed = true;
    this._markClosed();

    return cut === null ? [] : this._deps.unread(inbox, this._taken, cut);
  }

  async [asyncDispose](): Promise<void> {
    await this.close();
  }
}
