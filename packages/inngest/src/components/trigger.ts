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

  export class BaseDefinition<
    TShape extends Definition.BaseArgs = Definition.BaseArgs,
  > implements Definition.Like
  {
    public name: TShape["name"];
    public data: TShape["data"];

    constructor(name: TShape["name"]) {
      this.name = name;
      this.data = {} as TShape["data"];
    }

    protected clone(): this {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument
      return Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    }
  }

  export class Definition<
    TShape extends Definition.BaseArgs = Definition.BaseArgs,
  > extends BaseDefinition<TShape> {
    public ifCondition?: string;
    public runtimeSchema?: EventSchema;

    constructor(name: TShape["name"]) {
      super(name);
    }

    public create<
      TData extends TShape["data"],
      const TExtra extends Definition.ExtraArgs,
    >(
      data: TData,
      extra?: TExtra
    ): Simplify<
      Partial<Omit<Event, "name" | "data">> &
        Pick<TShape, "name" | "data"> &
        TExtra
    > {
      return {
        name: this.name,
        data,
        ...extra,
      } as unknown as Event.Input;
    }

    public if(condition: string): this {
      const clone = this.clone();
      clone.ifCondition = condition;

      return clone;
    }

    public schema<T extends EventSchema>(
      schema: T
    ): Definition<{ name: TShape["name"]; data: EventSchema.Output<T> }> {
      const clone = this.clone();
      clone.runtimeSchema = schema;

      return clone as unknown as Definition<{
        name: TShape["name"];
        data: EventSchema.Output<T>;
      }>;
    }

    public type<T extends Record<string, unknown>>(): Definition<{
      name: TShape["name"];
      data: T;
    }> {
      const clone = this.clone();

      return clone as Definition<{
        name: TShape["name"];
        data: T;
      }>;
    }
  }

  export class CronDefinition<
    TShape extends Definition.BaseArgs = Definition.BaseArgs,
  > extends BaseDefinition<{
    name: "inngest/scheduled.timer";
    data: TShape["data"];
  }> {
    constructor(private cron: string) {
      super("inngest/scheduled.timer");
    }
  }

  export class InvokeDefinition<
    TShape extends Definition.BaseArgs = Definition.BaseArgs,
  > extends BaseDefinition<{
    name: "inngest/function.invoked";
    data: TShape["data"];
  }> {
    private runtimeSchema?: EventSchema;

    constructor() {
      super("inngest/function.invoked");
    }

    public schema<T extends EventSchema>(
      schema: T
    ): InvokeDefinition<{
      name: "inngest/function.invoked";
      data: EventSchema.Output<T>;
    }> {
      const clone = this.clone();
      clone.runtimeSchema = schema;

      return clone as unknown as InvokeDefinition<{
        name: "inngest/function.invoked";
        data: EventSchema.Output<T>;
      }>;
    }

    public type<T extends Record<string, unknown>>(): InvokeDefinition<{
      name: TShape["name"];
      data: T;
    }> {
      const clone = this.clone();

      return clone as InvokeDefinition<{
        name: TShape["name"];
        data: T;
      }>;
    }
  }

  export namespace Definition {
    export type Like = {
      name: string;
      data: Record<string, unknown>;
    };

    export type AsEvent<T extends Definition.Like> = Simplify<
      Omit<Event, "name" | "data"> & Pick<T, "name" | "data">
    >;

    export type AsEvents<T extends Definition.Like[]> = {
      [K in keyof T]: AsEvent<T[K]>;
    };

    export type BaseArgs = Simplify<Pick<Event, "name" | "data">>;

    export type ExtraArgs = Simplify<Partial<Omit<Event, "name" | "data">>>;
  }
}

export const event = <const TName extends string>(
  name: TName
): Event.Definition<{
  name: TName;
  data: Record<string, unknown>;
}> => {
  return new Event.Definition<{ name: TName; data: Record<string, unknown> }>(
    name
  );
};

export const cron = <const TCron extends string>(
  cron: TCron
): Event.CronDefinition<{
  name: "inngest/scheduled.timer";
  data: { cron: TCron };
}> => {
  return new Event.CronDefinition(cron);
};

export const invoke = (): Event.InvokeDefinition => {
  return new Event.InvokeDefinition();
};
