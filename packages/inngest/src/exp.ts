import { type ZodSchema } from "zod";
import { type Simplify } from "./helpers/types.js";
import { type Logger } from "./middleware/logger.js";

// can we use import type to only import server-side inngest types and eat the schema?
export const createInngest = <TOptions extends Inngest.Args>(
  ...[opts]: TOptions
): Inngest<TOptions> => {
  return new InngestImpl();
};

// only public props
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Inngest<_TOptions = any> {
  createFunction: Inngest.CreateFunctionFn;
  serve: Inngest.ServeFn;
  sendEvent: Inngest.SendEventFn<this>;
  connect: Inngest.ConnectFn;
  event: Inngest.EventFn;
}

export namespace Inngest {
  export type Args = [
    opts?: {
      appId?: string;
      fetch?: typeof fetch;
      logger?: Logger;
      middleware?: null;

      events?: Trigger[];
    },
  ];

  export type CreateFunctionFn = <const TTriggers extends Trigger[]>(
    opts: CreateFunctionFn.Args<TTriggers>
  ) => void;

  export namespace CreateFunctionFn {
    export interface Args<TTriggers extends Trigger[], TOutput = unknown> {
      id: string;
      name?: string;
      description?: string;
      concurrency?: null;
      batchEvents?: null;
      idempotency?: null;
      rateLimit?: null;
      throttle?: null;
      debounce?: null;
      priority?: null;
      timeouts?: null;
      cancelOn?: null;
      maxRetries?: null;
      onFailure?: null;
      middleware?: null;

      triggers: TTriggers;
      handler: (ctx: HandlerCtx<TTriggers>) => TOutput;
    }

    export type HandlerCtx<TEvent extends Trigger[]> = {
      event: Trigger.AsEvents<TEvent>[number];
    };
  }

  export type ServeFn = (...[opts]: ServeFn.Args) => void;

  export namespace ServeFn {
    export type Args = [
      {
        appId?: string;
      },
    ];
  }

  export type SendEventFn<TInngest extends Inngest> = <
    TName extends TriggerNames<TInngest>,
  >(
    ...opts: [name: TName, data: TriggersByName<TInngest, TName>["data"]]
  ) => void;

  export type TriggerNames<TInngest extends Inngest> = TInngest extends Inngest<
    infer _IOptions extends [{ events: Trigger[] }]
  >
    ? _IOptions[0]["events"][number]["name"]
    : never;

  export type TriggersByName<
    TInngest extends Inngest,
    TName extends string,
  > = TInngest extends Inngest<infer _IOptions extends [{ events: Trigger[] }]>
    ? Extract<_IOptions[0]["events"][number], { name: TName }>
    : Record<string, unknown>;

  export type ConnectFn = (opts: ConnectFn.Args) => void;

  export namespace ConnectFn {
    export interface Args {}
  }

  export interface Function {
    id: string;
  }

  export type EventFn = (name: string) => Trigger;
}

export type EventSchema<TOutput> = ZodSchema<TOutput>;

export type Trigger<
  T extends Simplify<Pick<Event, "name" | "data">> = Simplify<
    Pick<Event, "name" | "data">
  >,
> = T & {
  __brand: "Inngest.Trigger";
  type: "event" | "cron";
  schema?: EventSchema<T["data"]>;
};

export namespace Trigger {
  export type AsEvent<T extends Trigger> = Simplify<
    Omit<Event, "name" | "data"> & Pick<T, "name" | "data">
  >;

  export type AsEvents<T extends Trigger[]> = {
    [K in keyof T]: AsEvent<T[K]>;
  };
}

export interface Event {
  id: string;
  name: string;
  data: Record<string, unknown>;
  ts: number;
}

export class InngestImpl implements Inngest {
  public event() {}
  public createFunction() {}
  public serve() {}
  public send() {}
  public connect() {}
}

export const event = <
  const TName extends string,
  TData extends Trigger["data"],
>(
  name: TName,
  schema?: EventSchema<TData>
): Trigger<{ name: TName; data: TData }> => {
  return {
    __brand: "Inngest.Trigger",
    type: "event",
    name,
    data: {} as TData,
    schema,
  };
};

export const cron = <TCron extends string>(
  cron: TCron
): Trigger<{ name: "inngest/scheduled.timer"; data: { cron: TCron } }> => {
  return {
    __brand: "Inngest.Trigger",
    data: { cron },
    name: "inngest/scheduled.timer",
    type: "cron",
  };
};

export const invoke = <TData extends Trigger["data"]>(
  schema?: EventSchema<TData>
): Trigger<{ name: "inngest/function.invoked"; data: TData }> => {
  return {
    __brand: "Inngest.Trigger",
    data: {} as TData,
    name: "inngest/function.invoked",
    type: "event",
    schema,
  };
};
