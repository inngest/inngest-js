/**
 * @module
 * The messages an agent's inbox hands to its body. A message is the event it
 * was made from; the inbox underneath is `step.subscribe()`'s `Inbox`
 * (`../inbox/Inbox.ts`).
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
   * Position in the reader that handed the message over, starting at 1. The
   * event that started the run, put first in the thread's inbox, has `seq` 0.
   */
  seq: number;

  /**
   * The ID of the event.
   */
  id: string;

  /**
   * The name of the event, so the messages of an inbox that receives several
   * events can be told apart.
   */
  name: TName;

  /**
   * The data of the event, typed by its schema when the source is an event
   * type.
   */
  data: TData;

  /**
   * When the event was sent, in milliseconds since the epoch.
   */
  ts: number;

  /**
   * The `user` object of the event.
   */
  user?: Record<string, unknown>;

  /**
   * The version of the event, when it was sent with one.
   */
  v?: string;

  /**
   * Whether this is a message of an event, and then the message narrowed to
   * its name and data:
   * `if (msg.is(order)) msg.data.total`.
   * @param type The event name or event type.
   */
  is<TType extends InboxEvent["event"]>(
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
   * that arrives later is not lost; the next read gets it. `0` never waits.
   */
  timeout?: NextTimeout;
}

/**
 * One event an inbox receives.
 */
export interface InboxEvent {
  /**
   * The event: a name, or an `eventType()`, which types the messages.
   */
  event: string | EventTypeWithAnySchema<string>;

  /**
   * An expression events must match, like the `if` of `step.waitForEvent()`.
   * The event is `async`: `async.data.thread == "t1"`.
   */
  if?: string;
}

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
type SourceMessage<TEvent extends InboxEvent> = TEvent extends unknown
  ? InboxMessage<SourceData<TEvent["event"]>, SourceName<TEvent["event"]>>
  : never;

/**
 * The name of an event source.
 * @param source A name or an event type.
 */
export function eventNameOf(source: InboxEvent["event"]): string {
  return typeof source === "string" ? source : source.name;
}

/**
 * A reader of one kind of message in an inbox, with a cursor of its own over the
 * same ordered sequence. Reading through a view hides nothing from the inbox or
 * from other views: every reader sees every message in its place.
 */
export interface View<TMessage> extends AsyncIterable<TMessage> {
  /**
   * Waits for the next message of this kind after this view's cursor, or
   * returns `null` once the inbox is closed and none is left. `{ timeout }`
   * gives up with `undefined`, and `{ timeout: 0 }` never waits.
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
 * The message of one event type or name, typed by its schema.
 */
export type EventMessage<TType extends InboxEvent["event"]> = SourceMessage<{
  event: TType;
}>;

/**
 * Gives a message its `is()` check, which is not a field: it is not copied,
 * serialized or compared.
 * @param message A message made from an event.
 */
export function withIs<TMessage extends object>(message: TMessage): TMessage {
  Object.defineProperty(message, "is", {
    value(type: InboxEvent["event"]) {
      return (message as { name?: string }).name === eventNameOf(type);
    },
    enumerable: false,
    configurable: true,
  });

  return message;
}
