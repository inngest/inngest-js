/**
 * @module
 * EXPERIMENTAL: `step.subscribe()`, a durable subscription to events.
 *
 * Opening a subscription asks the executor to keep a pause for the run. The
 * pause is not consumed when an event matches: the executor saves the event as
 * a step of the run, named after the subscription and the event, and wakes the
 * run if it is blocked waiting for it. Messages that arrive while the function
 * is busy are already in the run's state when it asks for them, and nothing
 * sent between turns is lost.
 *
 * The order of the messages is their order in the run's stack, which the
 * function receives with every request. A message that is already there is read
 * without a step. Only a read that has to wait is a step (the executor answers
 * it once the message exists), so a subscription costs one open and one close
 * step for each event, a wait when the function was blocked, and a step for every `poll()`.
 * Several events are several pauses sharing one subscription, so their messages
 * are one sequence in the order the executor saved them.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  EventType,
  EventTypeWithAnySchema,
} from "../triggers/triggers.ts";

/**
 * One delivered message.
 */
export interface InboxMessage<TData = unknown> {
  /**
   * Position in the subscription, starting at 1. A message put back by the
   * trigger event has `seq` 0.
   */
  seq: number;

  /**
   * The event that was sent.
   */
  data: TData;
}

/**
 * One event a subscription listens for.
 */
export interface SubscribeEvent {
  /**
   * The event to subscribe to: a name, or an `eventType()`, which types the
   * messages.
   */
  event: string | EventTypeWithAnySchema<string>;

  /**
   * An expression events must match, like the `if` of `step.waitForEvent()`.
   * The event is `async`: `async.data.thread == "t1"`.
   */
  if?: string;
}

/**
 * One event, or several in `events`. Several events share one sequence of
 * messages, in the order the executor saved them. That is the order they
 * arrived in, as far as events arrive in a defined order.
 */
export type SubscribeOptions =
  | SubscribeEvent
  | { events: readonly SubscribeEvent[] };

/**
 * The data of the messages of an event source: the schema's for an
 * `eventType()`, unknown for a name.
 */
type SourceData<TSource> =
  TSource extends EventType<string, infer TSchema>
    ? TSchema extends StandardSchemaV1<infer TData>
      ? TData
      : // biome-ignore lint/suspicious/noExplicitAny: an event type without a schema
        Record<string, any>
    : unknown;

/**
 * The data of the messages of a subscription, from the event types in its
 * options. A name among them makes it `unknown`.
 */
export type SubscribeData<TOpts> = TOpts extends {
  events: readonly (infer TEvent extends SubscribeEvent)[];
}
  ? SourceData<TEvent["event"]>
  : TOpts extends { event: infer TSource }
    ? SourceData<TSource>
    : unknown;

/**
 * The data of a subscription's messages: an explicit `TData` wins (an `any`
 * stays `any`), and without one the event types' data is inferred.
 */
export type SubscribeMessageData<TData, TOpts> = 0 extends 1 & TData
  ? // biome-ignore lint/suspicious/noExplicitAny: an explicit any stays any
    any
  : unknown extends TData
    ? SubscribeData<TOpts>
    : TData;

/**
 * The name of an event source.
 * @param source A name or an event type.
 */
export function eventNameOf(source: SubscribeEvent["event"]): string {
  return typeof source === "string" ? source : source.name;
}

/**
 * The events of the options.
 * @param opts Subscription options.
 */
export function streamsOf(opts: SubscribeOptions): readonly SubscribeEvent[] {
  const streams = "events" in opts ? opts.events : [opts];

  if (streams.length === 0) {
    throw new Error("`step.subscribe()` needs at least one event.");
  }

  return streams;
}

/**
 * A subscription. Iterate it with `for await`; the loop ends once it is
 * closed and drained.
 */
export interface Subscription<TData = unknown>
  extends AsyncIterable<InboxMessage<TData>>,
    AsyncDisposable {
  /**
   * Waits for the next message, or returns `null` once the subscription is
   * closed and every saved message has been read.
   */
  next(): Promise<InboxMessage<TData> | null>;

  /**
   * Reads the next message if it has already arrived, without waiting. Use it
   * between model calls to fold in messages sent while working. It is a step,
   * so the answer is the same when the function replays.
   */
  poll(): Promise<InboxMessage<TData> | null>;

  /**
   * Puts messages back, in order, so the next reads return them before
   * anything newer. Use it for polled messages that are not yours to handle
   * yet.
   */
  putBack(messages: InboxMessage<TData>[]): void;

  /**
   * Ends the subscription: no new messages are saved. It only ends the
   * subscription. It does not touch the run or the function's singleton, and
   * nothing is re-sent when the run ends.
   *
   * A message that arrives after `close()`, while the function's singleton
   * still applies, is dropped: it neither starts another run nor reaches this
   * one. The gap is the time between `close()` and the end of the run.
   *
   * Calling it again does nothing and returns no messages.
   * @returns The messages that were saved but not read, in the order they are
   * read. They are taken out of the subscription.
   */
  close(): Promise<InboxMessage<TData>[]>;

  /**
   * Closes the subscription when its scope ends, so `await using` needs no
   * explicit `close()`. `step.subscribe()` returns a promise, so await it
   * first: `await using inbox = await step.subscribe(...)`. Needs TypeScript
   * 5.2 or later; the symbol is polyfilled on Node before 20.5.
   */
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Runs one op of the subscription as a step.
 */
export type SubscribeOp = (
  stepId: string,
  mode: "open" | "park" | "poll" | "close",
  seq: number | undefined,
  stream: number,
) => Promise<unknown>;

/**
 * Opens a subscription.
 * @param op Runs one subscription op as a step.
 * @param key The subscription ID; prefix of every step it runs.
 * @param opts Subscription options.
 * @param read Reads the subscription's messages out of the run's state, in
 * order.
 * @param skip Tells the engine a wait was not asked for because its message
 * was already there.
 */
export async function openSubscription<TData = unknown>(
  op: SubscribeOp,
  key: string,
  opts: SubscribeOptions,
  read: () => unknown[],
  skip: (id: string) => Promise<void>,
): Promise<Subscription<TData>> {
  const streams = streamsOf(opts);

  // The IDs of a single event are the subscription's own, without a stream.
  const stepId = (stream: number, name: string) => {
    return streams.length === 1 ? `${key}:${name}` : `${key}:${stream}:${name}`;
  };

  for (let stream = 0; stream < streams.length; stream++) {
    await op(stepId(stream, "open"), "open", undefined, stream);
  }

  // How many messages have been read, how many polls were made, and how many
  // messages there were once closed.
  let readCount = 0;
  let polls = 0;
  let total: number | undefined;

  // Messages put back, oldest first.
  const held: InboxMessage<TData>[] = [];

  const drained = () => {
    return total !== undefined && readCount >= total;
  };

  // The executor keeps one parked marker per subscription, so reads of one
  // subscription run one after another, in the order they were called.
  let reads: Promise<unknown> = Promise.resolve();

  function inOrder<T>(read: () => Promise<T>): Promise<T> {
    const result = reads.then(read);
    reads = result.catch(() => {
      return undefined;
    });

    return result;
  }

  // The read of the last next() call while it is unfinished. `fresh` holds
  // until the end of the tick that started it.
  let waiting:
    | { result: Promise<InboxMessage<TData> | null>; fresh: boolean }
    | undefined;

  function next(): Promise<InboxMessage<TData> | null> {
    // A call made in a later tick while the previous read is still parked means
    // the caller dropped that read (a `Promise.race` it lost). Joining it gives
    // this caller its message, so the message is not eaten and the run is not
    // left parked behind a read nobody awaits. Calls made in the same tick
    // (`Promise.all([next(), next()])`) are separate reads.
    if (waiting && !waiting.fresh) {
      return waiting.result;
    }

    const entry = {
      result: inOrder(readNext),
      fresh: true,
    };

    waiting = entry;
    queueMicrotask(() => {
      entry.fresh = false;
    });

    const done = () => {
      if (waiting === entry) {
        waiting = undefined;
      }
    };

    entry.result.then(done, done);

    return entry.result;
  }

  async function readNext(): Promise<InboxMessage<TData> | null> {
    const waiting = held.shift();
    if (waiting) {
      return waiting;
    }

    if (drained()) {
      return null;
    }

    const seq = readCount + 1;

    // A message that is already in the state is read without a step. When it
    // is not, the run parks: the executor records a marker (the park carries
    // `seq`, the number of messages this read has seen, plus one) and answers
    // the park when the message exists; the function then runs again and finds
    // the message here. The state does not change during a request, so it is read once.
    const messages = read();

    if (messages.length < seq) {
      await op(`${key}:${seq}`, "park", seq, 0);
    } else {
      await skip(`${key}:${seq}`);
    }

    const message = messages[seq - 1];
    if (message === undefined) {
      throw new Error(`Subscription "${key}": message ${seq} is missing.`);
    }

    readCount = seq;

    return { seq, data: message as TData };
  }

  function poll(): Promise<InboxMessage<TData> | null> {
    return inOrder(readPoll);
  }

  async function readPoll(): Promise<InboxMessage<TData> | null> {
    const waiting = held.shift();
    if (waiting) {
      return waiting;
    }

    if (drained()) {
      return null;
    }

    const seq = readCount + 1;
    polls += 1;
    const message = await op(`${key}:poll:${polls}`, "poll", seq, 0);
    if (message === null || message === undefined) {
      return null;
    }

    readCount = seq;

    return { seq, data: message as TData };
  }

  let closing: Promise<InboxMessage<TData>[]> | undefined;

  // Ends every event's pause, then reads out what was saved but not read. A
  // second call finds it done and returns nothing, so an explicit `close()` and
  // the scope exit of `await using` can both run.
  function close() {
    if (closing) {
      return closing.then(() => {
        return [];
      });
    }

    closing = (async () => {
      let count = 0;

      for (let stream = 0; stream < streams.length; stream++) {
        const closed = (await op(
          stepId(stream, "close"),
          "close",
          undefined,
          stream,
        )) as { count: number };

        // The last close sees every message saved before the last pause went.
        count = closed.count;
      }

      total = count;

      const unread: InboxMessage<TData>[] = [];
      const messages = read();

      for (let seq = readCount + 1; seq <= count; seq++) {
        unread.push({ seq, data: messages[seq - 1] as TData });
      }
      readCount = count;

      return [...held.splice(0), ...unread];
    })();

    return closing;
  }

  return {
    next,
    poll,
    putBack(messages) {
      held.unshift(...messages);
    },
    close,
    async [Symbol.asyncDispose]() {
      await close();
    },
    [Symbol.asyncIterator]() {
      return {
        async next() {
          const message = await next();
          if (!message) {
            return { done: true, value: undefined };
          }

          return { done: false, value: message };
        },
      };
    },
  };
}

// Node before 20.5 lacks the symbol that `await using` looks up.
(Symbol as { asyncDispose?: symbol }).asyncDispose ??= Symbol.for(
  "Symbol.asyncDispose",
);
