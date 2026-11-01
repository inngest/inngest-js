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
import type { InboxRead } from "../execution/inboxState.ts";

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
 * What an inbox needs from the step tools and the run's state.
 */
export interface InboxDeps {
  sources: OpenedSource[];

  /**
   * The ID the executor knows the opening op by. Messages carry it.
   */
  inbox: string;

  /**
   * Opens the inbox on the executor. Settles once the run has replayed past
   * the open record.
   */
  open: (sources: OpenedSource[]) => Promise<unknown>;

  /**
   * The hashed ID of the wait op of the `n`th read of this inbox. It is known
   * before the op is reported, so the run's state can be asked whether the read
   * timed out.
   */
  waitId: (n: number) => string;

  /**
   * Reports the `n`th read, which has nothing unread. Never settles in the
   * request that reports it, unless the read timed out: then it settles with
   * `null`. A timeout is a duration or a timestamp, like the one of
   * `waitForEvent`.
   */
  wait: (
    n: number,
    inbox: string,
    seen: string,
    timeout?: ReadTimeout,
  ) => Promise<unknown>;

  /**
   * What the read after the first `taken` messages finds in the run's state.
   */
  read: (inbox: string, taken: number, wait: string) => InboxRead;

  /**
   * Marks a wait op as seen without requesting it. A timeout that lost to a
   * message is saved in state and never asked for.
   */
  skip: (n: number) => Promise<void>;

  /**
   * The last step of the run's stack that this request loaded.
   */
  lastSeen: () => string;
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
 * A durable collection of the events that matched the sources of one
 * `step.subscribe()`. Open it with `await using` so it closes at the end of the
 * block.
 */
export class Inbox<TMessage = EventPayload> implements AsyncDisposable {
  #deps: InboxDeps;
  #opened: Promise<void>;

  // Messages taken by reads so far in this replay.
  #taken = 0;

  // Reads started so far. Each has an op of its own, named by this number, so
  // that its place in the run's state is known before it is reported.
  #reads = 0;

  // Reads on one inbox are served in order, like an async generator's.
  #queue: Promise<unknown> = Promise.resolve();

  constructor(deps: InboxDeps) {
    this.#deps = deps;
    this.#opened = deps.open(deps.sources).then(() => {
      return undefined;
    });

    // A failed open is reported where the inbox is read; this keeps it from
    // also being reported as unhandled.
    this.#opened.catch(() => {
      return undefined;
    });
  }

  /**
   * Returns the next unread message. If none is unread, waits for one to
   * arrive.
   */
  next(): Promise<TMessage>;

  /**
   * Returns the next unread message, or `null` if none arrives in time.
   */
  next(options: ReadOptions): Promise<TMessage | null>;
  next(options?: ReadOptions): Promise<TMessage | null> {
    const n = this.#reads;
    this.#reads += 1;

    const read = this.#queue.then(() => {
      return this.#readOne(n, options?.timeout);
    });

    this.#queue = read.catch(() => {
      return undefined;
    });

    return read;
  }

  async #readOne(n: number, timeout?: ReadTimeout): Promise<TMessage | null> {
    await this.#opened;

    const found = this.#deps.read(
      this.#deps.inbox,
      this.#taken,
      this.#deps.waitId(n),
    );

    if (found.found === "message") {
      this.#taken += 1;

      if (found.timedOut) {
        await this.#deps.skip(n);
      }

      return found.message as TMessage;
    }

    // Nothing is unread. The executor wakes the run when a message arrives and
    // the replay finds it in state, so this does not settle in this request. A
    // read that timed out settles with the null the executor saved.
    const answer = await this.#deps.wait(
      n,
      this.#deps.inbox,
      this.#deps.lastSeen(),
      timeout,
    );

    return answer as TMessage | null;
  }

  /**
   * Reads the inbox in order with `for await`. The loop ends when the code
   * breaks out of it.
   */
  async *[Symbol.asyncIterator](): AsyncGenerator<TMessage, void, undefined> {
    while (true) {
      yield await this.next();
    }
  }

  /**
   * Stops the inbox from receiving. The pauses live until the run ends.
   */
  async close(): Promise<void> {
    await this.#opened;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
