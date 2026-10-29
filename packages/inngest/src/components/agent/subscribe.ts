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
 * none, the request ends with the read still waiting, like a pending
 * `step.waitForEvent()`, and every message the executor saves runs the function
 * again: the executor does not know whether the function is waiting, only that
 * it should get the chance to see the message. Messages that arrive while the
 * function runs are read on its next request. A subscription costs one open and
 * one close step for each event and a step for every `poll()`; a read that
 * waits costs no step. Several events are several pauses sharing one
 * subscription, so their messages are one sequence in the order the executor
 * saved them.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { asyncDispose } from "../../helpers/asyncDispose.ts";
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

  /**
   * Which source of the subscription saved the message: the order of the
   * sources, starting at 0. Missing on messages saved before it was kept.
   */
  stream?: number;

  /**
   * Whether this is a message of an event, and then the message narrowed to
   * its name and data:
   * `if (msg.is(order)) msg.data.total`.
   * @param type The event name or event type.
   */
  is<TType extends SubscribeEvent["event"]>(
    type: TType,
  ): this is SourceMessage<{ event: TType }>;
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
export function streamsOf(
  opts: SubscribeOptions,
  allowEmpty = false,
): readonly SubscribeEvent[] {
  const streams = opts.events ?? [opts];

  if (streams.length === 0 && !allowEmpty) {
    throw new Error("`step.subscribe()` needs at least one event.");
  }

  return streams;
}

/**
 * A reader of one kind of message in an inbox, with a cursor of its own over the
 * same ordered sequence. Reading through a view hides nothing from the inbox or
 * from other views: every reader sees every message in its place.
 */
export interface View<TMessage> extends AsyncIterable<TMessage> {
  /**
   * Waits for the next message of this kind after this view's cursor, or
   * returns `null` once the inbox is closed and none is left. Like the inbox's
   * `next()`: `{ timeout }` gives up with `undefined`, and `{ timeout: 0 }` never
   * waits.
   * @param options The timeout.
   */
  next(): Promise<TMessage | null>;
  next(options: NextOptions): Promise<TMessage | null | undefined>;

  /**
   * Every message of this kind after this view's cursor, in order, advancing
   * the cursor past them. It never waits.
   */
  unread(): Promise<TMessage[]>;

  /**
   * Every message of this kind so far, read or not, in order. It moves no
   * cursor and never waits.
   */
  current(): Promise<TMessage[]>;
}

/**
 * What `listen()` takes: an event name, an event type, or one with an `if`.
 */
export type ListenSource = SubscribeEvent["event"] | SubscribeEvent;

/**
 * The message of one event type or name, typed by its schema.
 */
export type EventMessage<TType extends SubscribeEvent["event"]> =
  SourceMessage<{ event: TType }>;

/**
 * The messages a listened source adds.
 */
export type ListenMessage<TSource extends ListenSource> =
  TSource extends SubscribeEvent
    ? SourceMessage<TSource>
    : TSource extends SubscribeEvent["event"]
      ? SourceMessage<{ event: TSource }>
      : never;

/**
 * A source added by `listen()`.
 */
export interface Listener<TInbox = unknown> extends AsyncDisposable {
  /**
   * The number of the source in the subscription, which messages it saves carry
   * as `stream`.
   */
  stream: number;

  /**
   * The inbox the source was added to, typed with the messages of the source
   * too.
   */
  inbox: TInbox;

  /**
   * Stops listening: no more events of the source are saved. Messages already
   * saved stay and are read as usual. Calling it again does nothing.
   */
  stop(): Promise<void>;
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
   * `next({ timeout: 0 })`, or wait with `group.parallel({ mode: "race" })` (a plain
   * `Promise.race` with `optimizeParallelism` on can leave the run waiting, as it
   * can with `waitForEvent`). `close()` ends a wait that is still open.
   */
  next(): Promise<TMessage | null>;

  /**
   * With a `timeout`: stops waiting after it and returns `undefined`. A
   * timeout of `0` never waits: it returns the next message if one has
   * arrived, else `undefined`.
   * @param options The timeout.
   */
  next(options: NextOptions): Promise<TMessage | null | undefined>;

  /**
   * Every message this subscription has saved so far, read or not, in order.
   * It moves no cursor and has no read state, and it never waits. It is one
   * step that records how many messages there were, so a replay returns the
   * same ones. To take what arrived since you last looked, read with
   * `next({ timeout: 0 })` until it returns `undefined`.
   */
  current(): Promise<TMessage[]>;

  /**
   * Takes every message after this reader's cursor, in order, advancing the
   * cursor past them. It never waits and is empty when nothing is pending. Use
   * it between model calls to fold in what arrived while working. Each message
   * is a step, so a replay takes the same messages.
   */
  unread(): Promise<TMessage[]>;

  /**
   * A view of the messages of one event: it reads them with a cursor of its
   * own, in the order they arrived, and hides nothing from other readers. The
   * view's messages are typed by the event type.
   * @param type The event name or event type.
   */
  of<TType extends SubscribeEvent["event"]>(
    type: TType,
  ): View<SourceMessage<{ event: TType }>>;

  /**
   * Adds an event source to this subscription: its messages join the same
   * ordered sequence, from now on (events sent before are not captured). It is
   * one step. The returned listener removes the source again.
   * @param source The event to listen to, a name, an event type or both with an
   * `if` expression over `async`.
   */
  listen<TSource extends ListenSource>(
    source: TSource,
  ): Promise<Listener<Subscription<TData, TMessage | ListenMessage<TSource>>>>;

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
  mode: "open" | "poll" | "close" | "stop" | "current",
  seq: number | undefined,
  stream: number,
  extra?: {
    /**
     * The event source of an open, close or stop.
     */
    target?: SubscribeEvent;
  },
) => Promise<unknown>;

/**
 * What a subscription needs of the engine it runs in.
 */
export interface SubscribeEngine {
  /**
   * Ends the request with a read still waiting. With a timeout the wait is a
   * timer that runs the function again when it fires; without one it never
   * settles in this request.
   */
  wait: (stepId: string, timeout?: NextTimeout) => Promise<unknown>;

  /**
   * Whether the subscription has been closed.
   */
  closed: () => boolean;

  /**
   * Whether the timer `stepId` of a read waiting for message `seq` fired
   * before that message arrived.
   */
  timerWon: (seq: number, stepId: string) => boolean;

  /**
   * Plans steps instead of running a lone one in the request that found it,
   * for as long as the subscription is open.
   */
  hold: (on: boolean) => void;
}

/**
 * Gives a message its `is()` check, which is not a field: it is not copied,
 * serialized or compared.
 * @param message A message made from an event.
 */
export function withIs<TMessage extends object>(message: TMessage): TMessage {
  Object.defineProperty(message, "is", {
    value(type: SubscribeEvent["event"]) {
      return (message as { name?: string }).name === eventNameOf(type);
    },
    enumerable: false,
    configurable: true,
  });

  return message;
}

/**
 * Opens a subscription.
 * @param op Runs one subscription op as a step.
 * @param key The subscription ID; prefix of every step it runs.
 * @param opts Subscription options.
 * @param read Reads the subscription's messages out of the run's state, in
 * order.
 * @param skip Tells the engine a wait was not asked for because its message
 * was already there.
 * @param engine What the subscription needs of the engine it runs in.
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
  engine: SubscribeEngine,
  allowEmpty = false,
): Promise<Subscription<TData, TMessage>> {
  // The event sources, by stream. A stopped source stays in its place, so the
  // numbers of the others do not change.
  const streams = streamsOf(opts, allowEmpty).map((source) => {
    return { source, active: true };
  });

  // Every step of a source carries its stream number. A run that began when the
  // first source's steps had no number (`<key>:open`) keeps those ids.
  const stepId = (stream: number, name: string) => {
    const legacy = `${key}:${name}`;

    return stream === 0 && answerOf(legacy).found
      ? legacy
      : `${key}:${stream}:${name}`;
  };

  for (let stream = 0; stream < streams.length; stream++) {
    await op(stepId(stream, "open"), "open", undefined, stream, {
      target: streams[stream]?.source,
    });
  }

  // From here a message can run the function while a step of it is running.
  engine.hold(true);

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

    return withIs({ ...event, seq }) as unknown as InboxMessage<TData>;
  };

  // Messages put back, oldest first.
  const held: InboxMessage<TData>[] = [];

  const drained = () => {
    return total !== undefined && readCount >= total;
  };

  // Reads of one subscription run one after another, in the order they were
  // called: each one waits for the message after the last one it read.
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

  // How many timers for each message fired. Every timer is its own step, so
  // one that fired is not waited for again.
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

    // A timeout of 0 never waits: it is a read of what has arrived, recorded.
    if (options?.timeout === 0) {
      return (await readPoll()) ?? undefined;
    }

    const seq = readCount + 1;

    // A message that is already in the state is read without a step. When it is
    // not, the request ends with this read waiting (nothing is reported for an
    // untimed read, a timer for a timed one), and the message runs the function
    // again, which finds it here. The state does not change during a request,
    // so it is read once.
    const messages = read();
    const attempt = timedOut.get(seq) ?? 0;
    const waitId = attempt ? `${key}:${seq}:${attempt}` : `${key}:${seq}`;

    // A timer that fired before the message arrived ended this wait for good: a
    // message saved since does not change that answer on a replay.
    if (options?.timeout !== undefined && engine.timerWon(seq, waitId)) {
      timedOut.set(seq, attempt + 1);
      await skip(waitId);

      return undefined;
    }

    if (messages.length < seq) {
      if (engine.closed()) {
        return null;
      }

      await engine.wait(waitId, options?.timeout);
      timedOut.set(seq, attempt + 1);

      return undefined;
    }

    // The timer of a read that got its message is not waited for.
    await skip(waitId);

    readCount = seq;

    return messageOf(messages[seq - 1], seq);
  }

  // Views: a cursor of its own over the same sequence. A view's read is the
  // first message of its kind after the cursor, a function of the stack, so it
  // is the same on every replay. What depends on the moment (`unread()`,
  // `current()`, a timeout) first records how many messages there were.
  let views = 0;

  function of(type: SubscribeEvent["event"]) {
    const wanted = eventNameOf(type);
    const reader = `v${++views}`;
    let cursor = 0;
    let probes = 0;
    const timedOutAt = new Map<number, number>();
    let order: Promise<unknown> = Promise.resolve();

    const alone = <T>(run: () => Promise<T>): Promise<T> => {
      const result = order.then(run);
      order = result.catch(() => {
        return undefined;
      });

      return result;
    };

    // How many messages there were when this step ran, recorded.
    const counted = async () => {
      probes += 1;

      const answer = (await op(
        `${key}:${reader}:current:${probes}`,
        "current",
        undefined,
        0,
      )) as { count: number };

      return answer.count;
    };

    const scan = (from: number, to: number, first = false) => {
      const found: InboxMessage<TData>[] = [];
      const messages = read();

      for (let index = from; index < Math.min(to, messages.length); index++) {
        const saved = messages[index];

        if ((saved as { name?: string } | undefined)?.name === wanted) {
          found.push(messageOf(saved, index + 1));

          if (first) {
            break;
          }
        }
      }

      return found;
    };

    // The parks this view made on the way to a message are answered steps in
    // the state, which a replay does not ask for again: tell the engine they are
    // accounted for. Every park id this view could have used between two
    // cursors is skipped; one that was never used is no step to wait for.
    const skipParks = async (from: number, to: number) => {
      for (let seq = from + 1; seq <= to + 1; seq++) {
        await skip(`${key}:${reader}:${seq}`);

        for (
          let attempt = 1;
          attempt <= (timedOutAt.get(seq) ?? 0);
          attempt++
        ) {
          await skip(`${key}:${reader}:${seq}:${attempt}`);
        }
      }
    };

    const nextOf = async (
      options?: NextOptions,
    ): Promise<InboxMessage<TData> | null | undefined> => {
      const startedAt = cursor;

      // The bound of the first scan: with a timeout, what was there when the
      // read began, recorded, so that a timeout stays one on replay.
      let bound =
        options?.timeout === undefined
          ? Number.POSITIVE_INFINITY
          : await counted();

      for (;;) {
        const [hit] = scan(cursor, bound, true);

        if (hit) {
          cursor = hit.seq;
          await skipParks(startedAt, hit.seq);

          return hit;
        }

        if (options?.timeout === 0) {
          cursor = Math.max(cursor, Math.min(bound, read().length));

          return undefined;
        }

        const seen = Math.min(bound, read().length);

        cursor = Math.max(cursor, seen);

        if (total !== undefined && cursor >= total) {
          return null;
        }

        // Nothing of this kind yet: wait for the next message of any kind, then
        // look again.
        const seq = seen + 1;
        const attempt = timedOutAt.get(seq) ?? 0;
        const waitId = attempt
          ? `${key}:${reader}:${seq}:${attempt}`
          : `${key}:${reader}:${seq}`;

        if (options?.timeout !== undefined && engine.timerWon(seq, waitId)) {
          timedOutAt.set(seq, attempt + 1);
          await skip(waitId);

          return undefined;
        }

        // Messages saved after the bound was taken are read now.
        if (read().length > seen) {
          bound = Number.POSITIVE_INFINITY;
          continue;
        }

        if (engine.closed()) {
          return null;
        }

        await engine.wait(waitId, options?.timeout);
        timedOutAt.set(seq, attempt + 1);

        return undefined;
      }
    };

    const view: View<InboxMessage<TData>> = {
      next: ((options?: NextOptions) => {
        return alone(() => {
          return nextOf(options);
        });
      }) as View<InboxMessage<TData>>["next"],
      unread() {
        return alone(async () => {
          const count = await counted();
          const taken = scan(cursor, count);

          cursor = Math.max(cursor, count);

          return taken;
        });
      },
      current() {
        return alone(async () => {
          return scan(0, await counted());
        });
      },
      [Symbol.asyncIterator]() {
        return {
          async next() {
            const message = await view.next();

            return message
              ? { done: false, value: message }
              : { done: true, value: undefined };
          },
        };
      },
    };

    return view;
  }

  let currents = 0;

  async function current() {
    currents += 1;

    const answer = (await op(
      `${key}:current:${currents}`,
      "current",
      undefined,
      0,
    )) as { count: number };

    // The count was taken when the step ran; the state of this request holds at
    // least that many messages, since it was loaded after the step finished.
    return read()
      .slice(0, answer.count)
      .map((saved, index) => {
        return messageOf(saved, index + 1);
      });
  }

  // A read of the next message if it has arrived, without waiting. Recorded as
  // a step, so a replay returns the same answer.
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

  function unread() {
    return inOrder(async () => {
      const taken: InboxMessage<TData>[] = [];

      for (;;) {
        const message = await readPoll();
        if (!message) {
          return taken;
        }

        taken.push(message);
      }
    });
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
      let count = read().length;
      let closedAny = false;

      for (let stream = 0; stream < streams.length; stream++) {
        const entry = streams[stream];

        if (!entry?.active) {
          continue;
        }

        entry.active = false;
        closedAny = true;

        const closed = (await op(
          stepId(stream, "close"),
          "close",
          undefined,
          stream,
          { target: entry.source },
        )) as { count: number };

        // The last close sees every message saved before the last pause went.
        count = closed.count;
      }

      // With no source left to close, one close op still marks the inbox
      // closed and ends any park, and gives the authoritative count.
      if (!closedAny) {
        const closed = (await op(stepId(0, "close"), "close", undefined, 0, {
          target: streams[0]?.source,
        })) as { count: number };

        count = closed.count;
      }

      total = count;
      engine.hold(false);

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
    current: current as Subscription<TData>["current"],
    of: of as unknown as Subscription<TData>["of"],
    unread: unread as Subscription<TData>["unread"],
    async listen(source) {
      if (closing) {
        throw new Error(`Subscription "${key}": listen() on a closed inbox.`);
      }

      const target: SubscribeEvent =
        typeof source === "object" && "event" in source
          ? source
          : { event: source };
      const stream = streams.length;

      streams.push({ source: target, active: true });
      await op(stepId(stream, "open"), "open", undefined, stream, { target });

      const entry = streams[stream];
      const listener = {
        stream,
        inbox: subscription,
        async stop() {
          if (!entry?.active) {
            return;
          }

          entry.active = false;
          await op(stepId(stream, "stop"), "stop", undefined, stream, {
            target,
          });
        },
        async [asyncDispose]() {
          await listener.stop();
        },
      };

      return listener as never;
    },
    putBack(messages) {
      held.unshift(...messages);
    },
    close,
    async [asyncDispose]() {
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
