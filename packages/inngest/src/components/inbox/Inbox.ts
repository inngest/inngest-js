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
   * Reports a read with nothing unread. Never settles in the request that
   * reports it.
   */
  wait: (inbox: string, seen: string) => Promise<unknown>;

  /**
   * The events the inbox has received, from the run's state, in order.
   */
  messages: (inbox: string) => unknown[];

  /**
   * The last step of the run's stack that this request loaded.
   */
  lastSeen: () => string;
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
  next(): Promise<TMessage> {
    const read = this.#queue.then(() => {
      return this.#readOne();
    });

    this.#queue = read.catch(() => {
      return undefined;
    });

    return read;
  }

  async #readOne(): Promise<TMessage> {
    await this.#opened;

    const messages = this.#deps.messages(this.#deps.inbox);
    if (this.#taken < messages.length) {
      const message = messages[this.#taken] as TMessage;
      this.#taken += 1;

      return message;
    }

    // Nothing is unread. The executor wakes the run when a message arrives and
    // the replay finds it in state, so this does not settle in this request.
    return (await this.#deps.wait(
      this.#deps.inbox,
      this.#deps.lastSeen(),
    )) as TMessage;
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
