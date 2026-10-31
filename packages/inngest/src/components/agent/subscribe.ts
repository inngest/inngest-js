/**
 * @module
 * EXPERIMENTAL: `step.subscribe()`, a durable inbox of events.
 *
 * Opening an inbox asks the executor to keep a pause for each source. A
 * matching event does not consume the pause: the executor delivers it to the
 * run's inbox, where it waits in a buffer at no step cost until the function
 * asks for it. Asking is a next op: it flushes the buffer into the run's state
 * as one step per message, or, with nothing buffered, leaves the run waiting for
 * the next message. The order of the messages is their order in the run's stack,
 * which the function receives with every request, so a message that is already
 * there is read in process, with no request.
 *
 * Costs: the open is one step, each message received one, each timeout one, and
 * the close one. Messages nobody asked for cost nothing.
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
 * A reader of messages in an inbox, with a cursor of its own over the same
 * ordered sequence. The inbox itself, `of(type)` and `listen()` all return this
 * one kind of object. Reading through a view hides nothing from the inbox or
 * from other views: every reader sees every message in its place.
 *
 * Messages are in arrival order: the order the executor received the events,
 * not the order they were sent or their timestamps.
 */
export interface View<TMessage>
  extends AsyncIterable<TMessage>,
    AsyncDisposable {
  /**
   * Waits for the next message of this view after its cursor, in arrival order,
   * or returns `null` once the inbox is closed and none is left. `{ timeout }`
   * gives up with `undefined`, and `{ timeout: 0 }` never waits.
   *
   * A view has at most one `next()` outstanding: calling it while one is
   * pending returns that same promise, so a read that loses a `Promise.race`
   * does not take a message away from the next call.
   * @param options The timeout.
   */
  next(): Promise<TMessage | null>;
  next(options: NextOptions): Promise<TMessage | null | undefined>;

  /**
   * Every message of this view not yet read, in arrival order, advancing the
   * cursor past them. It never waits and is empty when nothing is pending.
   */
  all(): Promise<TMessage[]>;

  /**
   * Puts messages back, in order, so this view's next reads return them first.
   */
  putBack(messages: TMessage[]): void;

  /**
   * Stops the sources of this view: every source of the event for `of(type)`
   * (whoever opened it), the sources a `listen()` opened for its view. Sources
   * already stopped are skipped, so it is safe beside another closer. Messages
   * already saved stay.
   */
  close(): Promise<void>;
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
 * What `listen()` returns: a full view of the messages of the sources it
 * opened, and nothing else of the inbox. `close()` stops exactly those sources.
 */
export type ListenView<TMessage> = View<TMessage> & {
  /**
   * The number of the first source this `listen()` opened, which the messages
   * it saves carry as `stream`.
   * @internal
   */
  stream: number;
};

/**
 * A subscription: the view of every message of the inbox, plus the means to
 * view parts of it (`of()`), add sources (`listen()`) and end it (`close()`).
 * Iterate it with `for await`; the loop ends once it is closed and drained.
 *
 * Messages are in arrival order: the order the executor received the events,
 * not the order they were sent or their timestamps.
 *
 * Limits are enforced when buffered messages become steps: 200 messages per
 * subscription, 500 per run, and half the run's step limit. The message that
 * would break a limit and everything buffered after it are dropped, the
 * subscription closes, and the reader gets the messages saved before it, then
 * the end (`next()` returns `null`).
 */
export interface Subscription<
  TData = unknown,
  // biome-ignore lint/suspicious/noExplicitAny: a view of the messages, whatever their data
  TMessage extends InboxMessage<any, string> = InboxMessage<TData>,
> extends Omit<View<TMessage>, "close"> {
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
   * Adds event sources to this subscription: their messages join the same
   * ordered sequence, from now on (events sent before are not captured). It is
   * one step. The returned view reads only the messages of the sources it
   * opened, with a cursor of its own, and its `close()` stops them.
   *
   * A source is an event name, an event type, or one with an `if`. A
   * low-level source's `if` is the pause form, the same as `waitForEvent`'s:
   * `async` is the incoming event and `event` is the event that started the
   * run. An array is several sources, each its own pause (one exact event name
   * and its own `if`), opened by the same step.
   *
   * @example
   * ```ts
   * await using ci = await inbox.listen({
   *   event: "ci/finished",
   *   if: "async.data.pr == event.data.pr",
   * });
   * ```
   * @param source The event to listen to, or an array of them.
   */
  listen<TSource extends ListenSource>(
    source: TSource | readonly TSource[],
  ): Promise<ListenView<ListenMessage<TSource>>>;

  /**
   * Whether `next()` would return at once, without waiting: a message is held
   * back or saved and unread, or the subscription is drained. Reads no step.
   * @internal
   */
  ready(): boolean;

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
  mode: "open" | "next" | "all" | "close" | "stop",
  extra?: {
    /**
     * The event sources an open, stop or close lists, by stream number.
     */
    streams?: { stream: number; target: SubscribeEvent }[];

    /**
     * How long a next op waits before it gives up.
     */
    timeout?: NextTimeout;
  },
) => Promise<unknown>;

/**
 * What a subscription needs of the engine it runs in.
 */
export interface SubscribeEngine {
  /**
   * The data of the message steps of the inbox in the run's state, in the order
   * the executor saved them.
   */
  messages: () => unknown[];

  /**
   * Whether the state holds the step a limit saves when it closes the inbox.
   */
  closed: () => boolean;

  /**
   * The answer the run's state holds for a step, if it has one.
   */
  answerOf: (stepId: string) => { found: boolean; data?: unknown };
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

interface Source {
  source: SubscribeEvent;
  active: boolean;
}

/**
 * Opens a subscription.
 * @param op Runs one subscription op as a step.
 * @param key The subscription ID; prefix of every step it runs.
 * @param opts Subscription options.
 * @param engine What the run's state holds.
 * @param allowEmpty Whether the options may list no event.
 */
export async function openSubscription<
  TData = unknown,
  // biome-ignore lint/suspicious/noExplicitAny: a view of the messages, whatever their data
  TMessage extends InboxMessage<any, string> = InboxMessage<TData>,
>(
  op: SubscribeOp,
  key: string,
  opts: SubscribeOptions,
  engine: SubscribeEngine,
  allowEmpty = false,
): Promise<Subscription<TData, TMessage>> {
  // The event sources, by stream number. A stopped source stays in its place, so
  // the numbers of the others do not change.
  const sources: Source[] = streamsOf(opts, allowEmpty).map((source) => {
    return { source, active: true };
  });

  const listed = (streams: number[]) => {
    return streams.map((stream) => {
      return { stream, target: (sources[stream] as Source).source };
    });
  };

  await op(`${key}:open`, "open", {
    streams: listed(sources.map((_, stream) => stream)),
  });

  // A message is the event the executor saved, with the stream that delivered it.
  const messageOf = (saved: unknown, seq: number): InboxMessage<TData> => {
    if (
      typeof saved !== "object" ||
      saved === null ||
      typeof (saved as { name?: unknown }).name !== "string"
    ) {
      throw new Error(`Subscription "${key}": message ${seq} is not an event.`);
    }

    return withIs({ ...saved, seq }) as unknown as InboxMessage<TData>;
  };

  // Set once close() has run: the number of messages the inbox holds, and the
  // end of it.
  let closedAt: number | undefined;

  const ended = () => {
    return closedAt !== undefined || engine.closed();
  };

  let views = 0;

  // A view reads the messages that pass `matches` with a cursor of its own, an
  // index into the inbox's messages. Everything it does is a function of the
  // state and of the calls made, so a replay reads the same messages.
  function makeView(
    matches: (message: Record<string, unknown>) => boolean,
    streamsOf: () => number[],
  ) {
    const id = views++;
    const prefix = `${key}:${id}`;

    // Messages put back, oldest first.
    const held: InboxMessage<TData>[] = [];
    let cursor = 0;
    let nexts = 0;
    let alls = 0;
    let pending: Promise<InboxMessage<TData> | null | undefined> | undefined;
    let stopped = false;

    // The next message after the cursor that this view reads, within `bound`
    // messages of the inbox.
    const take = (bound = Number.POSITIVE_INFINITY) => {
      const messages = engine.messages();

      while (cursor < Math.min(bound, messages.length)) {
        const saved = messages[cursor++];

        if (matches(saved as Record<string, unknown>)) {
          return messageOf(saved, cursor);
        }
      }

      return undefined;
    };

    const peek = () => {
      const messages = engine.messages();

      for (let index = cursor; index < messages.length; index++) {
        if (matches(messages[index] as Record<string, unknown>)) {
          return true;
        }
      }

      return false;
    };

    const drained = () => {
      return (stopped || ended()) && !peek();
    };

    const flush = async () => {
      alls += 1;

      const answer = (await op(`${prefix}:all:${alls}`, "all")) as
        | { total?: number }
        | undefined;

      return answer?.total ?? 0;
    };

    async function readNext(
      options?: NextOptions,
    ): Promise<InboxMessage<TData> | null | undefined> {
      const waiting = held.shift();
      if (waiting) {
        return waiting;
      }

      // A timeout of 0 never waits: it flushes what has arrived and reads it.
      if (options?.timeout === 0) {
        const total = await flush();

        return take(total) ?? (drained() ? null : undefined);
      }

      nexts += 1;
      const waitId = `${prefix}:next:${nexts}`;

      // A wait that timed out is recorded under its own id: a message that
      // arrived since does not change that on a replay.
      if (options?.timeout !== undefined && engine.answerOf(waitId).found) {
        await op(waitId, "next", { timeout: options.timeout });

        return undefined;
      }

      const message = take();
      if (message) {
        return message;
      }

      if (drained()) {
        return null;
      }

      // Nothing to read: the executor flushes what is buffered, or leaves the run
      // waiting for the next message. The request ends here; the function runs
      // again once a message is in the state, and reads it above. The op only
      // returns when its timer won.
      await op(waitId, "next", { timeout: options?.timeout });

      return undefined;
    }

    const view: View<InboxMessage<TData>> = {
      next: ((options?: NextOptions) => {
        if (!pending) {
          pending = readNext(options).finally(() => {
            pending = undefined;
          });
        }

        return pending;
      }) as View<InboxMessage<TData>>["next"],
      async all() {
        const total = await flush();
        const taken = held.splice(0);

        for (let message = take(total); message; message = take(total)) {
          taken.push(message);
        }

        return taken;
      },
      putBack(messages) {
        held.unshift(...(messages as InboxMessage<TData>[]));
      },
      async close() {
        const active = streamsOf().filter((stream) => {
          return (sources[stream] as Source).active;
        });

        stopped = true;

        if (active.length === 0) {
          return;
        }

        for (const stream of active) {
          (sources[stream] as Source).active = false;
        }

        await op(`${prefix}:stop`, "stop", { streams: listed(active) });
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
      async [asyncDispose]() {
        await view.close();
      },
    };

    return {
      view,
      held,
      ready: () => {
        return held.length > 0 || peek() || drained();
      },
      rest: (bound: number) => {
        const taken = held.splice(0);

        for (let message = take(bound); message; message = take(bound)) {
          taken.push(message);
        }

        return taken;
      },
    };
  }

  const inboxView = makeView(
    () => {
      return true;
    },
    () => {
      return sources.map((_, stream) => stream);
    },
  );

  const of = (type: SubscribeEvent["event"]) => {
    const wanted = eventNameOf(type);

    return makeView(
      (message) => {
        return message.name === wanted;
      },
      () => {
        return sources.flatMap(({ source }, stream) => {
          return eventNameOf(source.event) === wanted ? [stream] : [];
        });
      },
    ).view;
  };

  let closing: Promise<InboxMessage<TData>[]> | undefined;

  // Stops every source, marks the inbox closed, and reads out what was saved
  // but not read. A second call finds it done and returns nothing, so an
  // explicit `close()` and the scope exit of `await using` can both run.
  const close = () => {
    if (closing) {
      return closing.then(() => {
        return [];
      });
    }

    closing = (async () => {
      const active = sources
        .map((_, stream) => {
          return stream;
        })
        .filter((stream) => {
          return (sources[stream] as Source).active;
        });

      for (const stream of active) {
        (sources[stream] as Source).active = false;
      }

      const answer = (await op(`${key}:close`, "close", {
        streams: listed(active),
      })) as { total?: number } | undefined;

      closedAt = answer?.total ?? 0;

      return inboxView.rest(closedAt);
    })();

    return closing;
  };

  const subscription: Subscription<TData> = {
    next: inboxView.view.next as Subscription<TData>["next"],
    all: inboxView.view.all as Subscription<TData>["all"],
    putBack: inboxView.view.putBack as Subscription<TData>["putBack"],
    of: of as unknown as Subscription<TData>["of"],
    async listen(source) {
      if (closing) {
        throw new Error(`Subscription "${key}": listen() on a closed inbox.`);
      }

      const listening = (Array.isArray(source) ? source : [source]).map(
        (entry) => {
          return (
            typeof entry === "object" && "event" in entry
              ? entry
              : { event: entry }
          ) as SubscribeEvent;
        },
      );
      const opened = listening.map((target) => {
        sources.push({ source: target, active: true });

        return sources.length - 1;
      });

      const made = makeView(
        (message) => {
          return opened.includes(message.stream as number);
        },
        () => {
          return opened;
        },
      );

      await op(`${key}:${views - 1}:listen`, "open", {
        streams: listed(opened),
      });

      return Object.assign(made.view, { stream: opened[0] ?? 0 }) as never;
    },
    ready: inboxView.ready,
    close,
    async [asyncDispose]() {
      await close();
    },
    [Symbol.asyncIterator]() {
      return inboxView.view[Symbol.asyncIterator]();
    },
  };

  return subscription as unknown as Subscription<TData, TMessage>;
}
