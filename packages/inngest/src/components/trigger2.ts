import { type StandardSchemaV1 } from "@standard-schema/spec";

// Create a cron trigger.
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

export class EventType<
  TName extends string,
  // TData extends Record<string, unknown> | undefined,
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
                .join(", ")
            );
          }
        }
      },
    };

    return event;
  }

  withIf<T extends string>(condition: T) {
    return {
      ...this,
      if: condition,
    };
  }
}

// Overload: event without schema. Data is optional.
export function eventType<TName extends string>(
  name: TName
): EventType<TName, undefined>;

// Overload: event with schema. Data is required and typed.
export function eventType<
  TName extends string,
  TData extends Record<string, unknown>,
>(
  name: TName,
  schema: StandardSchemaV1<TData>
): EventType<TName, StandardSchemaV1<TData>>;

/**
 * Create an event type. This can be used as an event trigger and creating an
 * event.
 */
export function eventType<
  TName extends string,
  TData extends Record<string, unknown>,
>(
  name: TName,
  schema?: StandardSchemaV1<TData>
): EventType<TName, StandardSchemaV1<TData>> | EventType<TName, undefined> {
  if (schema) {
    return new EventType<TName, StandardSchemaV1<TData>>({ name, schema });
  }
  return new EventType<TName, undefined>({ name, schema: undefined });
}

/**
 * Create an invoke trigger.
 */
export function invoke<TData extends Record<string, unknown>>(
  schema: StandardSchemaV1<TData>
) {
  return {
    event: "inngest/function.invoked",
    schema,
  } as const;
}
