import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Represents a cron trigger for scheduled function execution.
 *
 * @property cron - Cron expression defining the schedule (e.g., "0 0 * * *")
 */
type CronTrigger = {
  cron: string;
};

/**
 * Represents an event trigger for function execution.
 *
 * @property event - The event name to trigger on
 * @property if - Optional CEL expression for conditional execution
 * @property schema - Optional StandardSchema for type-safe event data validation
 */
type EventTrigger = {
  event: string;
  if?: string;

  // biome-ignore lint/suspicious/noExplicitAny: schema can be any StandardSchemaV1
  schema?: StandardSchemaV1<any>;
};

/**
 * Union type of all possible trigger types.
 *
 * A trigger determines when and how a function is executed.
 */
export type Trigger = CronTrigger | EventTrigger;

/**
 * Create a cron trigger for scheduled function execution.
 *
 * @param schedule - Cron expression (e.g., "0 0 * * *" for daily at midnight)
 * @returns Cron trigger
 */
export function cron<T extends string>(schedule: T) {
  return {
    cron: schedule,
  };
}

type EventCreateParams<TData extends Record<string, unknown> | undefined> =
  TData extends undefined
    ? {
        data?: Record<string, unknown>;
        id?: string;
        ts?: number;
        v?: string;
      }
    : {
        data: TData;
        id?: string;
        ts?: number;
        v?: string;
      };

type ExtractSchema<TData> = TData extends StandardSchemaV1<infer IData, infer _>
  ? IData
  : undefined;

/**
 * Represents a typed event definition that can be used both as a trigger
 * and for creating events with validation.
 *
 * @template TName - The event name (e.g., "user.created")
 * @template TSchema - Optional StandardSchema for type-safe event data
 */
export class EventType<
  TName extends string,
  TSchema extends StandardSchemaV1<Record<string, unknown>> | undefined,
> {
  name: TName;
  schema: TSchema;

  constructor({ name, schema }: { name: TName; schema: TSchema }) {
    this.name = name;
    this.schema = schema;
  }

  get event() {
    // The `createFunction` method expects an `event` property instead of `name`
    return this.name;
  }

  /**
   * Creates an event to send.
   *
   * The returned event object includes a `validate()` method that can be called
   * to validate the event data against the schema (if one was provided).
   * Validation is not performed in here because validation may be async.
   *
   * @param params - Event parameters including data, id, timestamp, etc.
   */
  create(params: EventCreateParams<ExtractSchema<TSchema>>) {
    const event = {
      name: this.name,
      data: params.data,
      id: params.id,
      ts: params.ts,
      v: params.v,

      validate: async () => {
        if (this.schema) {
          if (!params.data) {
            throw new Error("data is required");
          }

          const check = await this.schema["~standard"].validate(params.data);
          if (check.issues) {
            throw new Error(
              check.issues
                .map((issue) => {
                  if (issue.path && issue.path.length > 0) {
                    return `${issue.path.join(".")}: ${issue.message}`;
                  }
                  return issue.message;
                })
                .join(", "),
            );
          }
        }
      },
    };

    return event;
  }

  /**
   * Create a trigger with a conditional filter.
   *
   * Functions with conditional triggers only execute when the condition
   * evaluates to true. The condition is a CEL (Common Expression Language)
   * expression that is evaluated against the event.
   *
   * @param condition - CEL expression evaluated against the event
   * @returns New event trigger with condition applied
   */
  withIf<T extends string>(condition: T) {
    return {
      event: this.name,
      if: condition,
      schema: this.schema,
    };
  }
}

// Overload: event without schema. Data is optional.
export function eventType<TName extends string>(
  name: TName,
): EventType<TName, undefined>;

// Overload: event with schema. Data is required and typed.
export function eventType<
  TName extends string,
  TData extends Record<string, unknown>,
>(
  name: TName,
  schema: StandardSchemaV1<TData>,
): EventType<TName, StandardSchemaV1<TData>>;

/**
 * Create an event type definition that can be used as a trigger and for
 * creating events.
 *
 * This is the primary way to define typed events in Inngest. It creates an
 * EventType instance that provides type safety and optional runtime validation.
 *
 * @param name - The event name (e.g., "user.created")
 * @param schema - Optional StandardSchema for type-safe event data (supports Zod, Valibot, etc.)
 * @returns EventType instance that can be used as a trigger or for creating events
 */
export function eventType<
  TName extends string,
  TData extends Record<string, unknown>,
>(
  name: TName,
  schema?: StandardSchemaV1<TData>,
): EventType<TName, StandardSchemaV1<TData>> | EventType<TName, undefined> {
  if (schema) {
    return new EventType<TName, StandardSchemaV1<TData>>({ name, schema });
  }
  return new EventType<TName, undefined>({ name, schema: undefined });
}

/**
 * Create an invoke trigger for function-to-function calls.
 *
 * This creates a trigger that allows your function to be invoked directly by
 * other functions using `step.invoke()`. The schema defines the expected data
 * structure for invocations.
 *
 * @param schema - StandardSchema defining the invoke payload structure
 * @returns Invoke trigger
 */
export function invoke<TData extends Record<string, unknown>>(
  schema: StandardSchemaV1<TData>,
) {
  return {
    event: "inngest/function.invoked",
    schema,
  } as const;
}
