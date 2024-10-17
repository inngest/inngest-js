import { cacheFn, waterfall } from "../helpers/functions";
import {
  type Await,
  type MaybePromise,
  type ObjectAssign,
  type PartialK,
  type Simplify,
} from "../helpers/types";
import {
  type BaseContext,
  type EventPayload,
  type IncomingOp,
  type OutgoingOp,
  type SendEventBaseOutput,
  type TriggersFromClient,
} from "../types";
import { type Inngest } from "./Inngest";
import { type InngestFunction } from "./InngestFunction";

/**
 * A middleware that can be registered with Inngest to hook into various
 * lifecycles of the SDK and affect input and output of Inngest functionality.
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
 *       init: () => {
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
  public readonly init: TOpts["init"];

  constructor({ name, init }: TOpts) {
    this.name = name;
    this.init = init;
  }
}

export namespace InngestMiddleware {
  export type Any = InngestMiddleware<MiddlewareOptions>;
  export type Stack = [InngestMiddleware.Any, ...InngestMiddleware.Any[]];
}

type FnsWithSameInputAsOutput<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TRecord extends Record<string, (arg: any) => any>,
> = {
  [K in keyof TRecord as Await<TRecord[K]> extends Parameters<TRecord[K]>[0]
    ? K
    : Await<TRecord[K]> extends void | undefined
      ? Parameters<TRecord[K]>[0] extends void | undefined
        ? K
        : never
      : never]: TRecord[K];
};

type PromisifiedFunctionRecord<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TRecord extends Record<string, (arg: any) => any>,
> = Pick<
  Partial<{
    [K in keyof TRecord]: (
      ...args: Parameters<TRecord[K]>
    ) => Promise<Await<TRecord[K]>>;
  }>,
  keyof FnsWithSameInputAsOutput<TRecord>
> &
  Omit<
    Partial<{
      [K in keyof TRecord]: (
        ...args: Parameters<TRecord[K]>
      ) => Promise<Parameters<TRecord[K]>[0]>;
    }>,
    keyof FnsWithSameInputAsOutput<TRecord>
  >;

export type RunHookStack = PromisifiedFunctionRecord<
  Await<MiddlewareRegisterReturn["onFunctionRun"]>
>;

export type SendEventHookStack = PromisifiedFunctionRecord<
  Await<MiddlewareRegisterReturn["onSendEvent"]>
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
  TResult extends Await<TMiddleware[TKey]>,
  TRet extends
    PromisifiedFunctionRecord<TResult> = PromisifiedFunctionRecord<TResult>,
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
  arg: Parameters<TMiddleware[TKey]>[0],

  transforms: PartialK<
    {
      [K in keyof TResult]-?: (
        prev: Parameters<TResult[K]>[0],
        output: Await<TResult[K]>
      ) => Parameters<TResult[K]>[0];
    },
    keyof {
      [K in keyof TResult as Await<TResult[K]> extends Parameters<TResult[K]>[0]
        ? K
        : Await<TResult[K]> extends void | undefined
          ? K
          : never]: void;
    }
  >
): Promise<TRet> => {
  // Wait for middleware to initialize
  const mwStack = await middleware;

  // Step through each middleware and get the hook for the given key
  const keyFns = mwStack.reduce(
    (acc, mw) => {
      const fn = mw[key];

      if (fn) {
        return [...acc, fn];
      }

      return acc;
    },
    [] as NonNullable<TMiddleware[TKey]>[]
  );

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

      const transform = transforms[key as keyof typeof transforms] as (
        arg: Await<(typeof fns)[number]>
      ) => Parameters<(typeof fns)[number]>;

      ret[key] = waterfall(fns, transform) as TRet[keyof TRet];
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
  init: MiddlewareRegisterFn;
}

/**
 * @public
 */
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
  onFunctionRun?: (ctx: InitialRunInfo) => MaybePromise<{
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
    transformInput?: MiddlewareRunInput;

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
    transformOutput?: MiddlewareRunOutput;

    /**
     * The `finished` hook is called when the function has finished executing
     * and has returned a final response that will end the run, either a
     * successful or error response. In the case of an error response, further
     * retries may be attempted and call this hook again.
     *
     * The output provided will be after `transformOutput` has been applied.
     *
     * This is not guaranteed to be called on every execution, and may be called
     * multiple times if many parallel executions reach the end of the function;
     * for a guaranteed single execution, create a function with an event
     * trigger of `"inngest/function.finished"`.
     */
    finished?: MiddlewareRunFinished;

    /**
     * The `beforeResponse` hook is called after the output has been set and
     * before the response is sent back to Inngest. This is where you can
     * perform any final actions before the response is sent back to Inngest and
     * is the final hook called.
     */
    beforeResponse?: BlankHook;
  }>;

  /**
   * The `sendEvent` hook is called every time an event is sent to Inngest.
   */
  onSendEvent?: () => MaybePromise<{
    /**
     * The `input` hook is called before the event is sent to Inngest. This
     * is where you can modify the event before it's sent to Inngest by
     * returning an object containing changes.
     */
    transformInput?: MiddlewareSendEventInput;

    /**
     * The `output` hook is called after the event has been sent to Inngest.
     * This is where you can perform any final actions after the event has
     * been sent to Inngest and can modify the output the SDK sees.
     */
    transformOutput?: MiddlewareSendEventOutput;
  }>;
};

/**
 * @public
 */
export type MiddlewareRegisterFn = (ctx: {
  /**
   * The client this middleware is being registered on.
   */
  client: Inngest.Any;

  /**
   * If defined, this middleware has been applied directly to an Inngest
   * function rather than on the client.
   */
  fn?: InngestFunction.Any;
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
    Readonly<BaseContext<Inngest.Any, TriggersFromClient<Inngest.Any>>>; // TODO Acceptable?

  /**
   * The step data that will be passed to the function.
   */
  steps: Readonly<IncomingOp>[];

  /**
   * The function that is being executed.
   */
  fn: InngestFunction.Any;

  /**
   * The raw arguments given to serve handler being used to execute the
   * function.
   */
  reqArgs: Readonly<unknown[]>;
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
      ctx: Readonly<{
        event: EventPayload;
        runId: string;
      }>;
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
 * Arguments for the SendEventInput hook
 *
 * @internal
 */
type MiddlewareSendEventInputArgs = Readonly<{
  payloads: ReadonlyArray<EventPayload>;
}>;

/**
 * The shape of an `input` hook within a `sendEvent`, optionally returning
 * change to the payloads.
 *
 * @internal
 */
type MiddlewareSendEventInput = (
  ctx: MiddlewareSendEventInputArgs
) => MaybePromise<{
  payloads?: EventPayload[];
} | void>;

/**
 * Arguments for the SendEventOutput hook
 *
 * @internal
 */
type MiddlewareSendEventOutputArgs = { result: Readonly<SendEventBaseOutput> };

/**
 * The shape of an `output` hook within a `sendEvent`, optionally returning a
 * change to the result value.
 */
type MiddlewareSendEventOutput = (
  ctx: MiddlewareSendEventOutputArgs
) => MaybePromise<{ result?: Record<string, unknown> } | void>;

/**
 * @internal
 */
type MiddlewareRunOutput = (ctx: {
  result: Readonly<Pick<OutgoingOp, "error" | "data">>;
  step?: Readonly<Omit<OutgoingOp, "id">>;
}) => MaybePromise<{
  result?: Partial<Pick<OutgoingOp, "data" | "error">>;
} | void>;

type MiddlewareRunFinished = (ctx: {
  result: Readonly<Pick<OutgoingOp, "error" | "data">>;
}) => MaybePromise<void>;

/**
 * @internal
 */
type GetMiddlewareRunInputMutation<
  TMiddleware extends InngestMiddleware<MiddlewareOptions>,
> = TMiddleware extends InngestMiddleware<infer TOpts>
  ? TOpts["init"] extends MiddlewareRegisterFn
    ? Await<
        Await<Await<TOpts["init"]>["onFunctionRun"]>["transformInput"]
      > extends {
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
type GetMiddlewareSendEventOutputMutation<
  TMiddleware extends InngestMiddleware<MiddlewareOptions>,
> = TMiddleware extends InngestMiddleware<infer TOpts>
  ? TOpts["init"] extends MiddlewareRegisterFn
    ? Await<
        Await<Await<TOpts["init"]>["onSendEvent"]>["transformOutput"]
      > extends {
        result: infer TResult;
      }
      ? {
          [K in keyof TResult]: TResult[K];
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
export type MiddlewareStackSendEventOutputMutation<
  TContext,
  TMiddleware extends InngestMiddleware.Stack,
> = ObjectAssign<
  {
    [K in keyof TMiddleware]: GetMiddlewareSendEventOutputMutation<
      TMiddleware[K]
    >;
  },
  TContext
>;

export type ExtendWithMiddleware<
  TMiddlewareStacks extends InngestMiddleware.Stack[],
  // eslint-disable-next-line @typescript-eslint/ban-types
  TContext = {},
> = ObjectAssign<
  {
    [K in keyof TMiddlewareStacks]: MiddlewareStackRunInputMutation<
      // eslint-disable-next-line @typescript-eslint/ban-types
      {},
      TMiddlewareStacks[K]
    >;
  },
  TContext
>;

export type ExtendSendEventWithMiddleware<
  TMiddlewareStacks extends InngestMiddleware.Stack[],
  // eslint-disable-next-line @typescript-eslint/ban-types
  TContext = {},
> = ObjectAssign<
  {
    [K in keyof TMiddlewareStacks]: MiddlewareStackSendEventOutputMutation<
      // eslint-disable-next-line @typescript-eslint/ban-types
      {},
      TMiddlewareStacks[K]
    >;
  },
  TContext
>;

/**
 * @internal
 */
export type MiddlewareStackRunInputMutation<
  TContext,
  TMiddleware extends InngestMiddleware.Stack,
> = ObjectAssign<
  {
    [K in keyof TMiddleware]: GetMiddlewareRunInputMutation<TMiddleware[K]>;
  },
  TContext
>;
