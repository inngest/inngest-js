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
type ExtractSchemaData<TData> = TData extends StandardSchemaV1<infer TData>
  ? TData
  : undefined;

/**
 * An event that has been created but not validated.
 * @template TData - The input data type of the event (i.e. before validation)
 * @template TOutputData - The output data type of the event (i.e. after validation)
 */
type UnvalidatedCreatedEvent<
  TName extends string,
  TData,
> = ValidatedCreatedEvent<TName, TData> & {
  validate: () => Promise<ValidatedCreatedEvent<TName, TData>>;
};

/**
 * An event that has been validated.
 * @template TData - The data type of the event.
 */
type ValidatedCreatedEvent<TName extends string, TData> = {
  data: TData;
  name: TName;
  id?: string;
  ts?: number;
  v?: string;
};

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
    | StandardSchemaV1<Record<string, unknown>>
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
  version?: string;

  constructor({
    name,
    schema,
    version,
  }: {
    name: TName;
    schema: TSchema;
    version?: string;
  }) {
    this.event = name;
    this.name = name;
    this.schema = schema;
    this.version = version;
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
    params: EventCreateParams<ExtractSchemaData<TSchema>>,
  ): UnvalidatedCreatedEvent<TName, ExtractSchemaData<TSchema>> {
    const event: UnvalidatedCreatedEvent<TName, ExtractSchemaData<TSchema>> = {
      name: this.name,
      data: params.data as ExtractSchemaData<TSchema>,
      id: params.id,
      ts: params.ts,
      v: params.v ?? this.version,

      // Method for validating and transforming the event data against the
      // schema
      validate: async (): Promise<
        ValidatedCreatedEvent<TName, ExtractSchemaData<TSchema>>
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
                .join(", "),
            );
          }
          data = check.value;
        }

        return {
          ...event,
          data: data as ExtractSchemaData<TSchema>,
        };
      },
    };

    return event;
  }
}

/**
 * This type's only purpose is to clearly highlight static type error messages
 * in our codebase. To end users, it's exactly the same as a normal string.
 */
type StaticTypeError<TMessage extends string> = TMessage;

/**
 * Ensure that users don't use transforms in their schemas, since we don't
 * support transforms.
 */
type AssertNoTransform<TSchema extends StandardSchemaV1 | undefined> =
  TSchema extends undefined
    ? // Undefined schema is OK
      undefined
    : TSchema extends StandardSchemaV1<infer TInput, infer TOutput>
      ? TInput extends TOutput
        ? // Input and output schemas match, so we're good
          TSchema
        : // Return an error message since the input and output schemas don't match
          StaticTypeError<"Transforms not supported: schema input/output types must match">
      : // Return an error message since the schema is not a StandardSchemaV1
        StaticTypeError<"Transforms not supported: schema input/output types must match">;

/**
 * Create an event type definition that can be used as a trigger and for
 * creating events.
 *
 * This is the primary way to define typed events in Inngest. It creates an
 * EventType instance that provides type safety and optional runtime validation.
 *
 * @param name - The event name (e.g., "user.created")
 * @param options - Optional options for the event type
 * @param options.schema - Optional StandardSchema for type-safe event data validation
 * @param options.version - Optional version of the event
 * @returns EventType instance that can be used as a trigger or for creating events
 */
export function eventType<
  TName extends string,
  TSchema extends
    | StandardSchemaV1<Record<string, unknown>>
    | undefined = undefined,
>(
  name: TName,
  {
    schema,
    version,
  }: {
    schema?: AssertNoTransform<TSchema>;
    version?: string;
  } = {},
): EventType<TName, TSchema> {
  return new EventType<TName, TSchema>({
    name,
    schema: schema as TSchema,
    version,
  });
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
