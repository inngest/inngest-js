import { type Logger } from "../middleware/logger.js";
import { type Event } from "./trigger.js";

// can we use import type to only import server-side inngest types and eat the schema?
export const createApp = <const TOptions extends App.Args>(
  ...[opts]: TOptions
): App<TOptions> => {
  return new InngestApp();
};

// only public props
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface App<_TOptions = any> {
  serve: App.ServeFn;
  connect: App.ConnectFn;
  createFunction: App.CreateFunctionFn;
  sendEvent: App.SendEventFn;
  sendEvents: App.SendEventsFn;
}

export namespace App {
  export type Args = [
    opts?: {
      appId?: string;
      fetch?: typeof fetch;
      logger?: Logger;
      middleware?: null;
    },
  ];

  export type CreateFunctionFn = <
    const TTriggers extends Event.Definition.Like[],
  >(
    opts: CreateFunctionFn.Args<TTriggers>
  ) => void;

  export namespace CreateFunctionFn {
    export interface Args<
      TTriggers extends Event.Definition.Like[],
      TOutput = unknown,
    > {
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

    export type HandlerCtx<TEvent extends Event.Definition.Like[]> = {
      event: Event.Definition.AsEvents<TEvent>[number];
    };
  }

  export type ServeFn = (...[opts]: ServeFn.Args) => void;

  export namespace ServeFn {
    export type Args = [
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        adapter: any;
      },
    ];
  }

  export type SendEventFn = (event: Event.Input) => void;

  export type SendEventsFn = (events: Event.Input[]) => void;

  export type ConnectFn = (opts: ConnectFn.Args) => void;

  export namespace ConnectFn {
    export interface Args {}
  }

  export interface Function {
    id: string;
  }
}

export class InngestApp implements App {
  public createFunction() {}
  public serve() {}
  public sendEvent() {}
  public sendEvents() {}
  public connect() {}
}
