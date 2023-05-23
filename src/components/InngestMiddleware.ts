import { type Simplify } from "type-fest";
import { cacheFn, waterfall } from "../helpers/functions";
import {
  type Await,
  type MaybePromise,
  type ObjectAssign,
  type SendEventPayload,
} from "../helpers/types";
import {
  type BaseContext,
  type ClientOptions,
  type EventPayload,
  type IncomingOp,
  type OutgoingOp,
} from "../types";
import { type Inngest } from "./Inngest";
import { type InngestFunction } from "./InngestFunction";

/**
 * A middleware that can be registered with Inngest to hook into various
 * lifecycles of the SDK and affect input and output of Inngest functionality.
 *
 * TODO Add docs and shortlink.
 *
 * See {@link https://innge.st/middleware}
 *
 * @example
 *
 * ```ts
 * export const inngest = new Inngest({
 *   middleware: [
 *     new InngestMiddleware({
 *       name: "My Middleware",
 *       register: () => {
 *         // ...
 *       }
 *     })
 *   ]
 * });
 * ```
 *
 * @public
 */
export class InngestMiddleware<TOpts extends MiddlewareOptions> {
  /**
   * The name of this middleware. Used primarily for debugging and logging
   * purposes.
   */
  public readonly name: TOpts["name"];

  /**
   * This function is used to initialize your middleware and register any hooks
   * you want to use. It will be called once when the SDK is initialized, and
   * should be used to store any state you want to use in other parts of your
   * middleware.
   *
   * It can be synchronous or asynchronous, in which case the client will wait
   * for it to resolve before continuing to initialize the next middleware.
   *
   * Multiple clients could be used in the same application with differing
   * middleware, so do not store state in global variables or assume that your
   * middleware will only be used once.
   *
   * Must return an object detailing the hooks you want to register.
   */
  public readonly register: TOpts["register"];

  constructor({ name, register }: TOpts) {
    this.name = name;
    this.register = register;
  }
}

type PromisifiedFunctionRecord<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TRecord extends Record<string, (arg: any) => any>
> = Partial<{
  [K in keyof TRecord]: (
    ...args: Parameters<TRecord[K]>
  ) => Promise<Await<TRecord[K]>>;
}>;

export type RunHookStack = PromisifiedFunctionRecord<
  Await<MiddlewareRegisterReturn["run"]>
>;

/**
 * Given some middleware and an entrypoint, runs the initializer for the given
 * `key` and returns functions that will pass arguments through a stack of each
 * given hook in a middleware's lifecycle.
 *
 * Lets the middleware initialize before starting.
 */
export const getHookStack = async <
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TMiddleware extends Record<string, (arg: any) => any>,
  TKey extends keyof TMiddleware,
  TRet extends PromisifiedFunctionRecord<
    Await<TMiddleware[TKey]>
  > = PromisifiedFunctionRecord<Await<TMiddleware[TKey]>>
>(
  /**
   * The stack of middleware that will be used to run hooks.
   */
  middleware: Promise<TMiddleware[]>,

  /**
   * The hook type to initialize.
   */
  key: TKey,

  /**
   * Arguments for the initial hook.
   */
  arg: Parameters<TMiddleware[TKey]>[0]
): Promise<TRet> => {
  // Wait for middleware to initialize
  const mwStack = await middleware;

  // Step through each middleware and get the hook for the given key
  const keyFns = mwStack.reduce((acc, mw) => {
    const fn = mw[key];

    if (fn) {
      return [...acc, fn];
    }

    return acc;
  }, [] as NonNullable<TMiddleware[TKey]>[]);

  // Run each hook found in sequence and collect the results
  const hooksRegistered = await keyFns.reduce<
    Promise<Await<TMiddleware[TKey]>[]>
  >(async (acc, fn) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return [...(await acc), await fn(arg)];
  }, Promise.resolve([]));

  // Prepare the return object - mutating this instead of using reduce as it
  // results in cleaner code.
  const ret = {} as TRet;

  // Step through each hook result and create a waterfall joining each key
  for (const hook of hooksRegistered) {
    const hookKeys = Object.keys(hook) as (keyof TRet)[];

    for (const key of hookKeys) {
      let fns = [hook[key]];

      const existingWaterfall = ret[key];
      if (existingWaterfall) {
        fns = [existingWaterfall, hook[key]];
      }

      ret[key] = waterfall(fns) as TRet[keyof TRet];
    }
  }

  // Cache each function in the stack to ensure each can only be called once
  for (const k of Object.keys(ret)) {
    const key = k as keyof typeof ret;

    ret[key] = cacheFn(
      ret[key] as (...args: unknown[]) => unknown
    ) as unknown as TRet[keyof TRet];
  }

  return ret;
};

/**
 * Options passed to new {@link InngestMiddleware} instance.
 *
 * @public
 */
export interface MiddlewareOptions {
  /**
   * The name of this middleware. Used primarily for debugging and logging
   * purposes.
   */
  name: string;

  /**
   * This function is used to initialize your middleware and register any hooks
   * you want to use. It will be called once when the SDK is initialized, and
   * should be used to store any state you want to use in other parts of your
   * middleware.
   *
   * It can be synchronous or asynchronous, in which case the client will wait
   * for it to resolve before continuing to initialize the next middleware.
   *
   * Multiple clients could be used in the same application with differing
   * middleware, so do not store state in global variables or assume that your
   * middleware will only be used once.
   *
   * Must return an object detailing the hooks you want to register.
   */
  register: MiddlewareRegisterFn;
}

export type MiddlewareRegisterReturn = {
  /**
   * This hook is called for every function execution and allows you to hook
   * into various stages of a run's lifecycle. Use this to store any state you
   * want to use for the entirety of a particular run.
   *
   * It can be synchronous or asynchronous, in which case the client will wait
   * for it to resolve before continuing to initialize the next middleware.
   *
   * Must return an object detailing the hooks you want to register.
   */
  run?: (ctx: InitialRunInfo) => MaybePromise<{
    /**
     * The `input` hook is called once the input for the function has been
     * properly set up. This is where you can modify the input before the
     * function starts to memoize or execute by returning an object containing
     * changes to the context.
     *
     * For example, to add `foo` to the context, you'd return
     * `{ ctx: { foo: "bar" } }`.
     *
     * @param ctx - The context for the incoming request.
     * @param steps - The step data in state. Does not include internal IDs.
     */
    input?: MiddlewareRunInput;

    /**
     * The `beforeMemoization` hook is called before the function starts to
     * memoize.
     */
    beforeMemoization?: BlankHook;

    /**
     * The `afterMemoization` hook is called after the function has finished
     * memoizing.
     */
    afterMemoization?: BlankHook;

    /**
     * The `beforeExecution` hook is called before the function starts to
     * execute. Execution here means that new code is being seen/run for the
     * first time.
     */
    beforeExecution?: BlankHook;

    /**
     * The `afterExecution` hook is called after the function has finished
     * executing.
     */
    afterExecution?: BlankHook;

    /**
     * The `output` hook is called after the function has finished executing
     * and before the response is sent back to Inngest. This is where you
     * can modify the output before it's sent back to Inngest by returning
     * an object containing changes.
     *
     * @param err - The raw error that was thrown by the function, if any, so
     * that you can capture exact error messages and stack traces.
     *
     * @param data - The prepared-but-unserialized data that was returned by
     * the function, if any, so that you can modify the output.
     */
    output?: MiddlewareRunOutput;

    /**
     * The `beforeResponse` hook is called after the output has been set and
     * before the response is sent back to Inngest. This is where you can
     * perform any final actions before the response is sent back to Inngest.
     */
    beforeResponse?: BlankHook;
  }>;

  /**
   * The `sendEvent` hook is called every time an event is sent to Inngest.
   */
  sendEvent?: () => MaybePromise<{
    /**
     * The `input` hook is called before the event is sent to Inngest. This
     * is where you can modify the event before it's sent to Inngest by
     * returning an object containing changes.
     */
    input?: MiddlewareSendEventInput;

    /**
     * The `output` hook is called after the event has been sent to Inngest.
     * This is where you can perform any final actions after the event has
     * been sent to Inngest and can modify the output the SDK sees.
     */
    output?: () => MaybePromise<void | unknown>;
  }>;
};

export type MiddlewareRegisterFn = (ctx: {
  /**
   * The client this middleware is being registered on.
   *
   * TODO This should not use `any`, but the generic type expected.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: Inngest<any>;

  /**
   * If defined, this middleware has been applied directly to an Inngest
   * function rather than on the client.
   *
   * TODO This should not use `any`, but the generic type expected.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn?: InngestFunction<any, any, any, any>;
}) => MaybePromise<MiddlewareRegisterReturn>;

/**
 * A blank, no-op hook that passes nothing and expects nothing in return.
 *
 * @internal
 */
type BlankHook = () => MaybePromise<void>;

/**
 * Arguments sent to some `run` lifecycle hooks of a middleware.
 *
 * @internal
 */
type MiddlewareRunArgs = Readonly<{
  /**
   * The context object that will be passed to the function. This contains
   * event data, some contextual data such as the run's ID, and step tooling.
   */
  ctx: Record<string, unknown> &
    Readonly<
      BaseContext<
        ClientOptions,
        string,
      Record<string, (...args: unknown[]) => unknown>
    >
  >;

  /**
   * The step data that will be passed to the function.
   */
  steps: Readonly<Omit<IncomingOp, "id">>[];

  /**
   * The function that is being executed.
   *
   * TODO This should not use `any`, but the generic type expected.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: InngestFunction<any, any, any, any>;
}>;

/**
 * The specific arguments sent to the `run` hook when an execution has begun.
 * Differs from {@link MiddlewareRunArgs} in that we don't have a complete
 * context yet.
 *
 * @internal
 */
type InitialRunInfo = Readonly<
  Simplify<
    Omit<MiddlewareRunArgs, "ctx"> & {
      /**
       * A partial context object that will be passed to the function. Does not
       * necessarily contain all the data that will be passed to the function.
       */
      ctx: Pick<MiddlewareRunArgs["ctx"], "event" | "runId">;
    }
  >
>;

/**
 * The shape of an `input` hook within a `run`, optionally returning change to
 * the context or steps.
 *
 * @internal
 */
type MiddlewareRunInput = (ctx: MiddlewareRunArgs) => MaybePromise<{
  ctx?: Record<string, unknown>;
  steps?: Pick<IncomingOp, "data">[];
  // We need these in the future to allow users to specify their own complex
  // types for transforming data above using just inference. e.g. every field
  // ending with "_at" is transformed to a Date.
  //
  // transformEvent?: (event: EventPayload) => unknown;
  // transformStep?: (data: unknown) => unknown;
} | void>;

/**
 * Arguments sent to some `sendEvent` lifecycle hooks of a middleware.
 *
 * @internal
 */
type MiddlewareSendEventArgs = Readonly<{
  payloads: ReadonlyArray<SendEventPayload<Record<string, EventPayload>>>;
}>;

/**
 * The shape of an `input` hook within a `sendEvent`, optionally returning
 * change to the payloads.
 *
 * @internal
 */
type MiddlewareSendEventInput = (ctx: MiddlewareSendEventArgs) => {
  payloads?: SendEventPayload<Record<string, EventPayload>>[];
} | void;

/**
 * @internal
 */
type MiddlewareRunOutput = (ctx: {
  result: Readonly<Pick<OutgoingOp, "error" | "data">>;
  step?: Readonly<Omit<OutgoingOp, "id">>;
}) => { result?: Partial<Pick<OutgoingOp, "data">> } | void;

/**
 * @internal
 */
type GetMiddlewareRunInputMutation<
  TMiddleware extends InngestMiddleware<MiddlewareOptions>
> = TMiddleware extends InngestMiddleware<infer TOpts>
  ? TOpts["register"] extends MiddlewareRegisterFn
    ? Await<Await<Await<TOpts["register"]>["run"]>["input"]> extends {
        ctx: infer TCtx;
      }
      ? {
          [K in keyof TCtx]: TCtx[K];
        }
      : // eslint-disable-next-line @typescript-eslint/ban-types
        {}
    : // eslint-disable-next-line @typescript-eslint/ban-types
      {}
  : // eslint-disable-next-line @typescript-eslint/ban-types
    {};

/**
 * @internal
 */
export type MiddlewareStackRunInputMutation<
  TContext,
  TMiddleware extends MiddlewareStack
> = ObjectAssign<
  {
    [K in keyof TMiddleware]: GetMiddlewareRunInputMutation<TMiddleware[K]>;
  },
  TContext
>;
