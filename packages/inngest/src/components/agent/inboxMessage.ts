/**
 * @module
 * The messages an agent's inbox hands to its body. A message is the event it
 * was made from; the inbox underneath is `step.subscribe()`'s `Inbox`
 * (`../inbox/Inbox.ts`).
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  BatchOptions,
  ReadOptions as NextOptions,
} from "../inbox/Inbox.ts";
import type {
  EventType,
  EventTypeWithAnySchema,
} from "../triggers/triggers.ts";

/**
 * One delivered message.
 */
export interface InboxMessage<TData = unknown, TName extends string = string> {
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

export type {
  BatchOptions,
  ReadOptions as NextOptions,
} from "../inbox/Inbox.ts";

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
 * A reader of an inbox with a read position of its own: the inbox itself or a
 * view of it. Reading through one hides nothing from the inbox or from other
 * views: every reader sees every message in its place.
 */
export interface View<TMessage>
  extends AsyncIterable<TMessage>,
    AsyncDisposable {
  /**
   * The next message, waiting for one if none is unread. `undefined` once the
   * reader is closed. With a `timeout`, `null` when none arrives in time.
   */
  next(): Promise<TMessage | undefined>;
  next(options: NextOptions): Promise<TMessage | null | undefined>;

  /**
   * Every unread message, waiting for at least one. `undefined` once the reader
   * is closed; with a `timeout`, `null` when none arrives in time.
   */
  nextBatch(options?: BatchOptions): Promise<TMessage[] | undefined>;
  nextBatch(
    options: BatchOptions & NextOptions,
  ): Promise<TMessage[] | null | undefined>;

  /**
   * Every unread message without waiting: an empty array if there is none.
   */
  drain(options?: BatchOptions): Promise<TMessage[]>;

  /**
   * Reads batch by batch with `for await`. The loop ends when the reader
   * closes, or when a wait passes `timeout` with nothing unread.
   */
  batches(
    options?: BatchOptions & Partial<NextOptions>,
  ): AsyncGenerator<TMessage[], void, undefined>;

  /**
   * Closes the reader and returns its unread messages.
   */
  close(): Promise<TMessage[]>;

  /**
   * Whether the reader is closed.
   */
  readonly closed: boolean;
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
