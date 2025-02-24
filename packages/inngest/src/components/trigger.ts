import { type StandardSchemaV1 } from "@standard-schema/spec";
import { type Simplify } from "../helpers/types.js";

export type EventSchema<TData extends Event["data"] = Event["data"]> =
  | Type<TData>
  | StandardSchemaV1<TData, TData>;

export type ObjectOnly<T> = T extends Record<string, unknown>
  ? T
  : Record<string, unknown>;

export namespace EventSchema {
  export type Output<TSchema extends EventSchema> = ObjectOnly<
    StandardSchemaV1.InferOutput<Normalized<TSchema>>
  >;

  export type Input<TSchema extends EventSchema> = ObjectOnly<
    StandardSchemaV1.InferInput<Normalized<TSchema>>
  >;

  export type Normalized<TEventSchema extends EventSchema> =
    TEventSchema extends Type<infer IData>
      ? StandardSchemaV1<IData, IData>
      : TEventSchema extends StandardSchemaV1<infer IData, infer _>
        ? StandardSchemaV1<IData, IData>
        : never;
}

export type Type<T> = T & { __brand: "Inngest.Type" };

export interface Event {
  id: string;
  name: string;
  data: Record<string, unknown>;
  ts: number;
}

export namespace Event {
  export type AsInput<T extends Event> = Simplify<
    Partial<T> & { name: T["name"] }
  >;

  export type AsInputs<T extends Event[]> = { [K in keyof T]: AsInput<T[K]> };

  export type Input = AsInput<Event>;

  export type Definition<
    TShape extends Simplify<Pick<Event, "name" | "data">> = Simplify<
      Pick<Event, "name" | "data">
    >,
  > = Definition.Static<TShape> & {
    <
      UData extends TShape["data"],
      const UExtra extends Simplify<Partial<Omit<Event, "name" | "data">>>,
    >(
      data: UData,
      extra?: UExtra
    ): Simplify<
      Partial<Omit<Event, keyof TShape>> &
        Pick<TShape, "name" | "data"> &
        UExtra
    >;
    if: (condition: string) => Definition<TShape>;
  };

  export namespace Definition {
    export type Like =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      | Definition<{ name: string; data: any }>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      | Static<{ name: string; data: any }>;

    export type AsEvent<T extends Definition> = Simplify<
      Omit<Event, "name" | "data"> & Pick<T, "name" | "data">
    >;

    export type AsEvents<T extends Definition[]> = {
      [K in keyof T]: AsEvent<T[K]>;
    };

    export type Static<
      TShape extends Simplify<Pick<Event, "name" | "data">> = Simplify<
        Pick<Event, "name" | "data">
      >,
    > = TShape & {
      __brand: "Inngest.Trigger";
      type: "event" | "cron";
      ifCondition?: string;
      schema?: EventSchema;
    };
  }
}

export const event = <const TName extends string, TSchema extends EventSchema>(
  name: TName,
  opts: { schema?: TSchema } = {}
): Event.Definition<{
  name: TName;
  data: EventSchema.Output<TSchema>;
}> => {
  const toEvent = <const TData extends EventSchema.Input<TSchema>>(
    data: TData,
    extra?: Simplify<Partial<Omit<Event, "name" | "data">>>
  ) => {
    return {
      name,
      data,
      ...extra,
    } satisfies Event.Input;
  };

  toEvent.__brand = "Inngest.Trigger" as const;
  toEvent.type = "event" as const;
  toEvent.name = name;
  toEvent.data = {} as EventSchema.Output<TSchema>;
  toEvent.schema = opts.schema;
  toEvent.if = (condition: string) => {
    const ev = event(name, opts);
    ev.ifCondition = condition;

    return ev;
  };

  return toEvent as Event.Definition<{
    name: TName;
    data: EventSchema.Output<TSchema>;
  }>;
};

export const withType = <T>(): Type<T> => {
  return undefined as unknown as Type<T>;
};

export const cron = <TCron extends string>(
  cron: TCron
): Event.Definition.Static<{
  name: "inngest/scheduled.timer";
  data: { cron: TCron };
}> => {
  return {
    __brand: "Inngest.Trigger",
    data: { cron },
    name: "inngest/scheduled.timer",
    type: "cron",
  } satisfies Event.Definition.Static<{
    name: "inngest/scheduled.timer";
    data: { cron: TCron };
  }>;
};

export const invoke = <TData extends Event.Definition["data"]>(
  opts: { schema?: EventSchema<TData> } = {}
): Event.Definition.Static<{
  name: "inngest/function.invoked";
  data: TData;
}> => {
  return {
    __brand: "Inngest.Trigger",
    data: {} as TData,
    name: "inngest/function.invoked",
    type: "event",
    schema: opts.schema,
  } satisfies Event.Definition.Static<{
    name: "inngest/function.invoked";
    data: TData;
  }>;
};
