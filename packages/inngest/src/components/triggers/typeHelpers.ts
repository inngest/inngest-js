// biome-ignore-all lint/suspicious/noExplicitAny: it's fine

import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { AsTuple } from "../../helpers/types.ts";
import type { createGroupTools } from "../InngestGroupTools.ts";
import type { Realtime } from "../realtime/types.ts";
import type { EventType, EventTypeWithAnySchema } from "./triggers.ts";

export type AnySchema = StandardSchemaV1<any>;
type BasicDataUnknown = Record<string, unknown>;
type BasicDataAny = Record<string, any>;

type InvokeEventName = "inngest/function.invoked";
type CronEventName = "inngest/scheduled.timer";
type CronEventData = { cron: string };

/**
 * Detects if a string type contains a wildcard character (*).
 */
type ContainsWildcard<T extends string> = T extends `${string}*${string}`
  ? true
  : false;

/**
 * Converts wildcard event names to `unknown`, preserving literal names.
 */
type WildcardToUnknown<T extends string> = ContainsWildcard<T> extends true
  ? unknown
  : T;

/**
 * Represents the structure of an event as received by function handlers.
 *
 * This is the runtime event shape that your function receives when triggered.
 *
 * @template TName - The event name as a string literal type
 * @template TData - The event data object type
 */
export type ReceivedEvent<TName, TData extends BasicDataUnknown> = {
  data: TData;
  id: string;
  name: TName;
  ts: number;
  v: string;
};

/**
 * Recursively checks if a trigger array contains an invoke trigger.
 *
 * This type is used to determine whether to add "inngest/function.invoked"
 * event to the received events tuple.
 *
 * @template T - Array of trigger definitions to check
 * @returns `true` if array contains an invoke trigger, `false` otherwise
 */
type HasInvokeTrigger<T extends readonly any[]> = T extends readonly [
  infer First,
  ...infer Rest,
]
  ? First extends EventTypeWithAnySchema<InvokeEventName>
    ? true
    : HasInvokeTrigger<Rest>
  : false;

/**
 * Converts an EventType instance to a ReceivedEvent type.
 *
 * Extracts the event name and schema from EventType and transforms it into
 * the ReceivedEvent shape that function handlers receive.
 *
 * @template TEventType - The EventType instance to convert
 * @returns ReceivedEvent type with extracted name and data
 */
type EventTypeToEvent<TEventType> = TEventType extends EventType<
  infer TName,
  infer TSchema
>
  ? TSchema extends StandardSchemaV1<infer TData extends BasicDataUnknown>
    ? ReceivedEvent<WildcardToUnknown<TName>, TData>
    : ReceivedEvent<WildcardToUnknown<TName>, BasicDataAny>
  : never;

/**
 * Converts a plain event object trigger to a ReceivedEvent type.
 *
 * Handles triggers like `{ event: "my-event", schema?: z.object(...) }`.
 *
 * @template TName - Event name
 * @template TSchema - Optional schema type
 * @returns ReceivedEvent with typed data from schema, or Record<string, any> if no schema
 */
type PlainEventToReceivedEvent<
  TName extends string,
  TSchema,
> = TSchema extends StandardSchemaV1<infer TData extends BasicDataUnknown>
  ? ReceivedEvent<WildcardToUnknown<TName>, TData>
  : ReceivedEvent<WildcardToUnknown<TName>, BasicDataAny>;

/**
 * Processes a single trigger and converts it to ReceivedEvent(s).
 *
 * @template TTrigger - The trigger to process
 * @template TSeenCron - Whether we've already seen a cron trigger
 * @returns Tuple of ReceivedEvent(s), or empty array if trigger should be skipped
 */
type ProcessSingleTrigger<
  TTrigger,
  TSeenCron extends boolean,
> = TTrigger extends EventTypeWithAnySchema<InvokeEventName> // Is this an invoke trigger?
  ? [] // Skip invoke triggers (handled separately by ToReceivedEvent)
  : TTrigger extends EventTypeWithAnySchema<string> // Is this an event type trigger?
    ? [EventTypeToEvent<TTrigger>]
    : TTrigger extends { cron: string } // Is this a cron trigger?
      ? TSeenCron extends true
        ? [] // Skip additional cron triggers (they're merged into one)
        : [ReceivedEvent<CronEventName, CronEventData>]
      : // Is this an event trigger using an EventType?
        TTrigger extends {
            event: EventType<infer TName, infer TSchema>;
            if?: string;
          }
        ? [
            TSchema extends StandardSchemaV1<
              infer TData extends BasicDataUnknown
            >
              ? ReceivedEvent<WildcardToUnknown<TName>, TData>
              : ReceivedEvent<WildcardToUnknown<TName>, BasicDataAny>,
          ]
        : // Is this an event trigger using a string name (i.e. not an EventType)?
          TTrigger extends {
              event: infer TName extends string;
              schema?: infer TSchema;
            }
          ? [PlainEventToReceivedEvent<TName, TSchema>]
          : []; // Unknown trigger type, skip it

/**
 * Recursively processes trigger array, converting to event types while tracking
 * crons.
 *
 * This type iterates through a trigger array, converting each trigger to its
 * corresponding ReceivedEvent type. It handles:
 * - EventType instances → ReceivedEvent with typed data
 * - Cron triggers → "inngest/scheduled.timer" event (merged if multiple)
 * - Plain event objects → ReceivedEvent with typed or untyped data
 * - Invoke triggers → skipped (handled by ToReceivedEvent)
 *
 * @template T - Array of trigger definitions to process
 * @template SeenCron - Tracks whether we've already encountered a cron trigger
 *
 * @remarks
 * Multiple cron triggers are merged into a single "inngest/scheduled.timer" event.
 */
type TriggersToEventsWithCron<
  T extends readonly any[],
  SeenCron extends boolean = false,
> = T extends readonly [infer First, ...infer Rest]
  ? [
      ...ProcessSingleTrigger<First, SeenCron>,
      ...TriggersToEventsWithCron<
        Rest,
        First extends { cron: string } ? true : SeenCron
      >,
    ]
  : [];

/**
 * Alias for TriggersToEventsWithCron that processes all non-invoke triggers.
 *
 * Despite the name "Filter", this type actually:
 * 1. Converts event triggers to ReceivedEvent types
 * 2. Converts cron triggers to "inngest/scheduled.timer" events
 * 3. Merges multiple cron triggers into one
 * 4. Preserves the order of non-invoke triggers
 *
 * @template T - Array of trigger definitions to process
 */
type FilterNonInvokeTriggers<T extends readonly any[]> =
  TriggersToEventsWithCron<T>;

/**
 * Extracts and builds a union of schema output types from invoke triggers.
 *
 * This recursively processes the trigger array and accumulates the output types
 * from all invoke trigger schemas (those with event: "inngest/function.invoked")
 * into a union type.
 *
 * @template T - Array of trigger definitions to process
 * @returns Union of all invoke trigger schema output types, or `never` if none found
 */
type ExtractInvokeSchemas<T extends readonly any[]> = T extends readonly [
  infer First,
  ...infer Rest,
]
  ? First extends EventType<InvokeEventName, infer TSchema>
    ? TSchema extends StandardSchemaV1<infer TData>
      ? TData | ExtractInvokeSchemas<Rest>
      : ExtractInvokeSchemas<Rest>
    : ExtractInvokeSchemas<Rest>
  : never;

/**
 * Extracts and builds a union of all data types from all trigger schemas.
 *
 * Unlike ExtractInvokeSchemas which only processes invoke triggers, this type
 * processes ALL triggers (event and invoke triggers) and builds a union of
 * their data types. For event triggers without schemas, it returns Record<string, any>.
 *
 * @template T - Array of trigger definitions to process
 * @returns Union of all trigger data types, or `never` if none found
 */
type ExtractAllSchemaOutputs<T extends readonly any[]> = T extends readonly [
  infer First,
  ...infer Rest,
]
  ? First extends EventType<string, infer TSchema>
    ? TSchema extends StandardSchemaV1<infer TData>
      ? TData | ExtractAllSchemaOutputs<Rest>
      : BasicDataAny | ExtractAllSchemaOutputs<Rest>
    : First extends { event: EventType<string, infer TSchema> }
      ? TSchema extends StandardSchemaV1<infer TData>
        ? TData | ExtractAllSchemaOutputs<Rest>
        : BasicDataAny | ExtractAllSchemaOutputs<Rest>
      : First extends {
            event: string;
            schema: StandardSchemaV1<infer TData>;
          }
        ? TData | ExtractAllSchemaOutputs<Rest>
        : First extends { event: string }
          ? BasicDataAny | ExtractAllSchemaOutputs<Rest>
          : ExtractAllSchemaOutputs<Rest>
  : never;

/**
 * Converts `never` type to empty object `{}` for data types.
 *
 * This utility is used to ensure that when no schemas are found, the data type
 * becomes `{}` instead of `never`, which provides better TypeScript error
 * messages and autocomplete.
 *
 * @template T - Type to check and potentially convert
 * @returns `{}` if T is `never`, otherwise returns T unchanged
 */
type NeverToEmpty<T> = [T] extends [never] ? {} : T;

/**
 * Converts a trigger array to a tuple of ReceivedEvent types.
 *
 * This type transforms trigger definitions into the event types that a function
 * handler will receive. It always includes an invoke event type because
 * functions can be invoked directly regardless of their declared triggers.
 *
 * When invoke triggers are present, it uses their schemas for the invoke event
 * data. Otherwise, it derives the invoke event data type from all trigger
 * schemas.
 *
 * @template T - Array of trigger definitions to process
 */
export type ToReceivedEvent<T extends readonly any[]> =
  HasInvokeTrigger<T> extends true
    ? [
        ...FilterNonInvokeTriggers<T>,
        ReceivedEvent<InvokeEventName, NeverToEmpty<ExtractInvokeSchemas<T>>>,
      ]
    : [
        ...TriggersToEventsWithCron<T>,
        ReceivedEvent<
          InvokeEventName,
          NeverToEmpty<ExtractAllSchemaOutputs<T>>
        >,
      ];

/**
 * Converts a tuple of ReceivedEvent types to a union.
 * @internal
 */
type ReceivedEventTupleToUnion<T extends readonly any[]> = T[number];

/**
 * Base context object for handlers using the new trigger-based event typing.
 * This uses ToReceivedEvent to derive event types directly from triggers
 * rather than looking up from the client's event registry.
 *
 * @template TStepTools - The step tools type for this context
 * @template TTriggers - Array of trigger definitions
 * @internal
 */
export type BaseContextWithTriggers<
  TStepTools,
  TTriggers extends readonly any[],
> = {
  /**
   * The event data present in the payload.
   */
  event: ReceivedEventTupleToUnion<ToReceivedEvent<TTriggers>>;
  events: AsTuple<ReceivedEventTupleToUnion<ToReceivedEvent<TTriggers>>>;

  /**
   * The run ID for the current function execution
   */
  runId: string;

  step: TStepTools;

  /**
   * Tools for grouping and coordinating steps.
   */
  group: ReturnType<typeof createGroupTools>;

  /**
   * The current zero-indexed attempt number for this function execution.
   */
  attempt: number;

  /**
   * The maximum number of attempts allowed for this function.
   */
  maxAttempts?: number;

  /**
   * Publish a realtime message to a channel topic. This is non-durable and
   * will re-execute on retry. For durable publishing, use
   * `step.realtime.publish()`.
   */
  publish: Realtime.TypedPublishFn;
};

/**
 * Context object for handlers using trigger-based event typing with middleware overrides.
 *
 * @template TStepTools - The step tools type for this context
 * @template TTriggers - Array of trigger definitions
 * @template TOverrides - Properties to override from middleware
 * @internal
 */
export type ContextWithTriggers<
  TStepTools,
  TTriggers extends readonly any[],
  TOverrides extends BasicDataUnknown = Record<never, never>,
> = Omit<BaseContextWithTriggers<TStepTools, TTriggers>, keyof TOverrides> &
  TOverrides;

/**
 * A handler type that computes its event type from a trigger array using ToReceivedEvent.
 * This provides proper typing for EventType instances and schema-bearing triggers.
 *
 * @template TStepTools - The step tools type for this context
 * @template TTriggers - Array of trigger definitions
 * @template TOverrides - Properties to override from middleware
 * @internal
 */
export type HandlerWithTriggers<
  TStepTools,
  TTriggers extends readonly any[],
  TOverrides extends BasicDataUnknown = Record<never, never>,
> = (
  /**
   * The context argument provides access to all data and tooling available to
   * the function.
   */
  ctx: ContextWithTriggers<TStepTools, TTriggers, TOverrides>,
) => unknown;

/**
 * Type guard to check if an object has a `validate` method. The use case is for
 * safely validating an event payload that might have a `validate` method
 */
export function isValidatable<T>(
  value: T,
): value is T & { validate: () => Promise<void> } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("validate" in value)) {
    return false;
  }
  return typeof value.validate === "function";
}
