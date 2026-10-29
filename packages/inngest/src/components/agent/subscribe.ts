/**
 * @module
 * EXPERIMENTAL: `step.subscribe()`, a durable subscription to events.
 *
 * Opening a subscription asks the executor to keep a pause for the run. The
 * pause is not consumed when an event matches: the executor saves the event as
 * a step of the run, named after the subscription and the event. Messages only
 * accumulate there; saving a message does nothing else. Messages that arrive
 * while the function is busy are already in the run's state when it asks for
 * them, and nothing sent between turns is lost.
 *
 * The order of the messages is their order in the run's stack, which the
 * function receives with every request: the k-th `next()` returns the k-th
 * message. A message that is already there is read without a step. When there is
 * none, the function parks: the executor records a marker and wakes the run
 * when a message arrives. Only a parked run is woken; a busy run reads
 * everything on its next request. A subscription costs one open and one close
 * step for each event, a park (and a wake) whenever the function had to wait,
 * and a step for every `poll()`. Several events are several pauses sharing one
 * subscription, so their messages are one sequence in the order the executor
 * saved them.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { timeStr } from "../../helpers/strings.ts";
import type {
  EventType,
  EventTypeWithAnySchema,
} from "../triggers/triggers.ts";

/**
 * One delivered message.
 */
export interface InboxMessage<TData = unknown, TName extends string = string> {
  /**
   * Position in the subscription, starting at 1. A message put back by the
   * trigger event has `seq` 0.
   */
  seq: number;

  /**
   * The ID of the event.
   */
  id: string;

  /**
   * The name of the event, so the messages of a subscription to several events
   * can be told apart.
   */
  name: TName;

  /**
   * The data of the event, typed by its schema when the subscription is to an
   * event type.
   */
  data: TData;

  /**
   * When the event was sent, in milliseconds since the epoch.
   */
  ts: number;

  /**
   * The `user` object of the event. Missing on messages saved before it was
   * kept.
   */
  user?: Record<string, unknown>;

  /**
   * The version of the event, when it was sent with one.
   */
  v?: string;
}

/**
 * How long a `next()` waits: a number of milliseconds, a time string such as
 * `"30s"`, a date, or a duration, as for `step.waitForEvent()`.
 */
export type NextTimeout = Parameters<typeof timeStr>[0];

/**
 * Options of `next()`.
 */
export interface NextOptions {
  /**
   * Stop waiting after this long: `next()` then returns `undefined`. A message
   * that arrives later is not lost; the next read gets it. Durations under a
   * second round up to one second, as for `step.waitForEvent()`.
   */
  timeout?: NextTimeout;
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
  | (SubscribeEvent & { events?: never })
  | { events: readonly SubscribeEvent[]; event?: never; if?: never };

/**
 * Options that name only fields of `SubscribeOptions`. An object literal passed
 * for a generic parameter is not checked for extra fields, so a typo such as
 * `iff` would be dropped silently; this turns it into an error.
 */
export type ExactOptions<TOpts> = 0 extends 1 & TOpts
  ? never
  : [
        Exclude<keyof TOpts, "event" | "if" | "events"> | ExtraEventKeys<TOpts>,
      ] extends [never]
    ? unknown
    : {
        [K in
          | Exclude<keyof TOpts, "event" | "if" | "events">
          | ExtraEventKeys<TOpts>]: never;
      };

/**
 * The fields of the entries of `events` that a subscription event does not have.
 */
type ExtraEventKeys<TOpts> = TOpts extends {
  events: readonly (infer TEvent)[];
}
  ? TEvent extends unknown
    ? Exclude<keyof TEvent, "event" | "if">
    : never
  : never;

/**
 * Options whose events are all named by a string. Only these may be given an
 * explicit message type, because there is no event type to check it against.
 */
export type NamedOptions =
  | { event: string; if?: string; events?: never }
  | {
      events: readonly { event: string; if?: string }[];
      event?: never;
      if?: never;
    };

/**
 * The data of the messages of an event source: the schema's for an
 * `eventType()`, unknown for a name.
 */
type SourceData<TSource> = TSource extends EventType<string, infer TSchema>
  ? TSchema extends StandardSchemaV1<infer TData>
    ? TData
    : // biome-ignore lint/suspicious/noExplicitAny: an event type without a schema
      Record<string, any>
  : unknown;

/**
 * The name of an event source: the literal for an `eventType()`, any string for
 * a name.
 */
type SourceName<TSource> = TSource extends EventType<infer TName, infer _>
  ? TName
  : string;

/**
 * The message of one event source.
 */
type SourceMessage<TEvent extends SubscribeEvent> = TEvent extends unknown
  ? InboxMessage<SourceData<TEvent["event"]>, SourceName<TEvent["event"]>>
  : never;

/**
 * The messages of a subscription as a union with one member per event, so
 * checking `message.name` narrows `message.data`.
 */
export type SubscribeMessages<TOpts> = TOpts extends {
  events: readonly (infer TEvent extends SubscribeEvent)[];
}
  ? SourceMessage<TEvent>
  : TOpts extends SubscribeEvent
    ? SourceMessage<TOpts>
    : InboxMessage;

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
 * The signature of `step.subscribe()`. With event types, the message type comes
 * from them and the options are checked for typos. An explicit message type is
 * only taken for events named by a string, where there is nothing to check it
 * against.
 */
export interface SubscribeTool<TId> {
  <const TOpts extends SubscribeOptions>(
    id: TId,
    opts: TOpts & ExactOptions<TOpts>,
  ): Promise<Subscription<SubscribeData<TOpts>, SubscribeMessages<TOpts>>>;

  <TData>(id: TId, opts: NamedOptions): Promise<Subscription<TData>>;
}

/**
 * The events of the options.
 * @param opts Subscription options.
 */
export function streamsOf(opts: SubscribeOptions): readonly SubscribeEvent[] {
  const streams = opts.events ?? [opts];

  if (streams.length === 0) {
    throw new Error("`step.subscribe()` needs at least one event.");
  }

  return streams;
}

/**
 * A subscription. Iterate it with `for await`; the loop ends once it is
 * closed and drained.
 */
export interface Subscription<
  TData = unknown,
  // biome-ignore lint/suspicious/noExplicitAny: a view of the messages, whatever their data
  TMessage extends InboxMessage<any, string> = InboxMessage<TData>,
> extends AsyncIterable<TMessage>,
    AsyncDisposable {
  /**
   * Waits for the next message, or returns `null` once the subscription is
   * closed and every saved message has been read.
   *
   * A `next()` that is waiting still takes its message, even if you stopped
   * awaiting it: do not race `next()` against a timer or another step in a
   * plain `Promise.race` and then read again, because the dropped call eats a
   * message and the next read waits for the one after it. Race a step against
   * `poll()`, or wait with `group.parallel({ mode: "race" })` (a plain
   * `Promise.race` with `optimizeParallelism` on can leave the run waiting, as it
   * can with `waitForEvent`). `close()` ends a wait that is still open.
   */
  next(): Promise<TMessage | null>;
  next(options: NextOptions): Promise<TMessage | null | undefined>;

  /**
   * Reads the next message if it has already arrived, without waiting. Use it
   * between model calls to fold in messages sent while working. It is a step,
   * so the answer is the same when the function replays.
   */
  poll(): Promise<TMessage | null>;

  /**
   * Puts messages back, in order, so the next reads return them before
   * anything newer. Use it for polled messages that are not yours to handle
   * yet.
   */
  putBack(messages: TMessage[]): void;

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
  close(): Promise<TMessage[]>;

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
  park?: { timeout?: NextTimeout; attempt?: number },
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
export async function openSubscription<
  TData = unknown,
  // biome-ignore lint/suspicious/noExplicitAny: a view of the messages, whatever their data
  TMessage extends InboxMessage<any, string> = InboxMessage<TData>,
>(
  op: SubscribeOp,
  key: string,
  opts: SubscribeOptions,
  read: () => unknown[],
  skip: (id: string) => Promise<void>,
  answerOf: (id: string) => { found: boolean; data?: unknown },
): Promise<Subscription<TData, TMessage>> {
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

  // A message is the event the executor saved, with its `seq`. The saved value
  // is trusted to be an event (the executor writes it from the event it matched),
  // so it is only checked for the fields every reader needs. Memos from before
  // messages were flat held `{ seq, data: event }`; those are unwrapped.
  const isEvent = (value: unknown): value is Record<string, unknown> => {
    return (
      typeof value === "object" &&
      value !== null &&
      typeof (value as { name?: unknown }).name === "string"
    );
  };

  const messageOf = (saved: unknown, seq: number): InboxMessage<TData> => {
    const wrapped =
      typeof saved === "object" && saved !== null
        ? (saved as { seq?: unknown; data?: unknown })
        : undefined;
    const event =
      typeof wrapped?.seq === "number" && isEvent(wrapped.data)
        ? wrapped.data
        : isEvent(saved)
          ? saved
          : undefined;

    if (!event) {
      throw new Error(`Subscription "${key}": message ${seq} is not an event.`);
    }

    return { ...event, seq } as unknown as InboxMessage<TData>;
  };

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

  function next(options?: NextOptions) {
    return inOrder(() => {
      return readNext(options);
    }) as Promise<InboxMessage<TData> | null | undefined>;
  }

  // How many parks for each message timed out. Every park is its own step, so
  // one that timed out is not answered again.
  const timedOut = new Map<number, number>();

  async function readNext(
    options?: NextOptions,
  ): Promise<InboxMessage<TData> | null | undefined> {
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
    const attempt = timedOut.get(seq) ?? 0;
    const parkId = attempt ? `${key}:${seq}:${attempt}` : `${key}:${seq}`;

    // A park that timed out was recorded as such: a message that arrived since
    // does not change that answer on a replay.
    if (options?.timeout !== undefined) {
      const recorded = answerOf(parkId);

      if (recorded.found && recorded.data === null) {
        timedOut.set(seq, attempt + 1);
        await op(parkId, "park", seq, 0, { timeout: options.timeout, attempt });

        return undefined;
      }
    }

    let answered: unknown;

    if (messages.length < seq) {
      answered = await op(parkId, "park", seq, 0, {
        timeout: options?.timeout,
        attempt,
      });

      if (answered === null) {
        timedOut.set(seq, attempt + 1);

        return undefined;
      }
    } else {
      await skip(parkId);
    }

    const message = messages[seq - 1];
    if (message === undefined) {
      // A park that close() ended is answered as closed: the end of the
      // subscription. Any other park is only answered once its message exists.
      if ((answered as { closed?: boolean } | null | undefined)?.closed) {
        return null;
      }

      throw new Error(`Subscription "${key}": message ${seq} is missing.`);
    }

    readCount = seq;

    return messageOf(message, seq);
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

    return messageOf(message, seq);
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
        unread.push(messageOf(messages[seq - 1], seq));
      }
      readCount = count;

      return [...held.splice(0), ...unread];
    })();

    return closing;
  }

  // The messages are built with a name and the data of the event; the caller's
  // `TMessage` is only a narrower view of the same objects.
  const subscription: Subscription<TData> = {
    next: next as Subscription<TData>["next"],
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

  return subscription as unknown as Subscription<TData, TMessage>;
}

// Node before 20.5 lacks the symbol that `await using` looks up.
(Symbol as { asyncDispose?: symbol }).asyncDispose ??= Symbol.for(
  "Symbol.asyncDispose",
);
