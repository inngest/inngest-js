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

/**
 * Parameters when creating an event (e.g. before sending an event).
 *
 * @template TData - The data type of the event. Note that this is the schema input, not output.
 */
type EventCreateParams<TData extends Record<string, unknown> | undefined> = {
  id?: string;
  ts?: number;
  v?: string;
} & (TData extends undefined // The `data` field has a special case we need to handle
  ? // If data is undefined then data is optional
    {
      data?: Record<string, unknown>;
    }
  : // If data is defined then data is required
    {
      data: TData;
    });

/**
 * Extract the input type from a StandardSchemaV1.
 */
type ExtractSchemaInput<TData> = TData extends StandardSchemaV1<
  infer IInput,
  infer _
>
  ? IInput
  : undefined;

/**
 * An event that has been created but not validated.
 * @template TInputData - The input data type of the event (i.e. before validation)
 * @template TOutputData - The output data type of the event (i.e. after validation)
 */
type UnvalidatedCreatedEvent<TInputData, TOutputData> =
  ValidatedCreatedEvent<TInputData> & {
    validate: () => Promise<ValidatedCreatedEvent<TOutputData>>;
  };

/**
 * An event that has been validated.
 * @template TData - The data type of the event.
 */
type ValidatedCreatedEvent<TData> = {
  data: TData;
  name: string;
  id?: string;
  ts?: number;
  v?: string;
};

/**
 * Extract the output type from a StandardSchemaV1.
 */
type ExtractSchemaOutput<TData> = TData extends StandardSchemaV1<
  infer _,
  infer IOutput
>
  ? IOutput
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
  TSchema extends
    | StandardSchemaV1<Record<string, unknown>, Record<string, unknown>>
    | undefined,
> {
  /**
   * The event name. This is the same as the `name` property, but is necessary
   * to make the event type compatible with other features (e.g. event
   * triggers).
   */
  readonly event: TName;

  readonly name: TName;
  schema: TSchema;

  constructor({ name, schema }: { name: TName; schema: TSchema }) {
    this.event = name;
    this.name = name;
    this.schema = schema;
  }

  /**
   * Creates an event to send.
   *
   * The returned event object includes a `validate()` method that can be called
   * to validate the event data against the schema (if one was provided). The
   * `validate()` method returns a new event object with the validated data,
   * including any transforms defined in the schema.
   *
   * Validation is not performed within this method because validation may be async.
   *
   * @param params - Event parameters including data, id, timestamp, etc.
   */
  create(
    params: EventCreateParams<ExtractSchemaInput<TSchema>>
  ): UnvalidatedCreatedEvent<
    ExtractSchemaInput<TSchema>,
    ExtractSchemaOutput<TSchema>
  > {
    const event: UnvalidatedCreatedEvent<
      ExtractSchemaInput<TSchema>,
      ExtractSchemaOutput<TSchema>
    > = {
      name: this.name,
      data: params.data as ExtractSchemaInput<TSchema>,
      id: params.id,
      ts: params.ts,
      v: params.v,

      // Method for validating and transforming the event data against the
      // schema
      validate: async (): Promise<
        ValidatedCreatedEvent<ExtractSchemaOutput<TSchema>>
      > => {
        let data = params.data;

        if (this.schema) {
          // Only perform validation if a schema was provided

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
                .join(", ")
            );
          }
          data = check.value;
        }

        return {
          ...event,
          data: data as ExtractSchemaOutput<TSchema>,
        };
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

  /**
   * Add a schema to the event type.
   *
   * @param schema - StandardSchema for type-safe event data validation
   * @returns New event type with schema applied
   */
  withSchema<
    TSchema extends StandardSchemaV1<
      Record<string, unknown>,
      Record<string, unknown>
    >,
  >(schema: TSchema): EventType<TName, TSchema> {
    return new EventType({
      name: this.name,
      schema,
    });
  }
}

/**
 * Create an event type definition that can be used as a trigger and for
 * creating events.
 *
 * This is the primary way to define typed events in Inngest. It creates an
 * EventType instance that provides type safety and optional runtime validation.
 *
 * @param name - The event name (e.g., "user.created")
 * @returns EventType instance that can be used as a trigger or for creating events
 */
export function eventType<TName extends string>(
  name: TName
): EventType<TName, undefined> {
  return new EventType({ name, schema: undefined });
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
  schema: StandardSchemaV1<TData>
) {
  return {
    event: "inngest/function.invoked",
    schema,
  } as const;
}
