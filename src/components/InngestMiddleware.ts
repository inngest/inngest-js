import {
  type Await,
  type MaybePromise,
  type ObjectAssign,
} from "../helpers/types";
import { type BaseContext, type ClientOptions, type OpStack } from "../types";
import { type EventsFromOpts } from "./Inngest";

/**
 * A helper to force types and infer literal output without requiring
 * `satisfies`.
 *
 * @public
 */
export const createMiddleware = <TMiddleware extends InngestMiddleware>(
  middleware: TMiddleware
): TMiddleware => {
  return middleware;
};

/**
 * - Mutation functions should only return CHANGES. This is because it's
 *   otherwise hard to tell what a middleware is intending to set types to.
 *   Also, this means that middleware can't be destructive and delete, which
 *   feels good.
 *
 *   TODO: Readonly
 *
 *  @public
 */
export interface InngestMiddleware<
  TOpts extends ClientOptions = ClientOptions,
  TEvents extends EventsFromOpts<TOpts> = EventsFromOpts<TOpts>
> {
  name: string;
  register: () => MaybePromise<{
    /**
     * TODO Add readonly { ctx, steps } before adding tools (just event and
     * stack data)
     */
    run?: () => MaybePromise<{
      input?: MiddlewareRunInput<TOpts, TEvents>;
      beforeMemoization?: () => MaybePromise<void>;
      afterMemoization?: () => MaybePromise<void>;
      beforeExecution?: () => MaybePromise<void>;
      afterExecution?: () => MaybePromise<void>;
      output?: () => MaybePromise<void>;
      beforeResponse?: () => MaybePromise<void>;
    }>;
  }>;
}

// /**
//  * Each middleware declared will adhere to this interface, though a helper
//  * method will be provided to make it easier to declare middleware and properly
//  * set the type signature so we can infer as much as possible.
//  *
//  * `MaybePromise<>` is used to display that the return value of function could
//  * be either sync or async. If it's async, the SDK will always wait for it to
//  * resolve before continuing to either the next piece of middleware or
//  *  continuing with the request.
//  */
// interface InngestMiddleware {
//   /**
//    * The name of the middleware. This is primarily used for debugging and
//    * logging purposes.
//    */
//   name: string;

//   /**
//    * A required function that sets up the middleware. This is where you can
//    * register your middleware's hooks and set up any local state that you need.
//    *
//    * This means that you can declare variables within this function that all
//    * future hooks can use, ensuring that you don't need to pin data to the
//    * context and muddy the context's type signature just to pass data between
//    * hooks.
//    */
//   register: () => MaybePromise<{
//     /**
//      * The `run` function is called for every incoming request. This is where
//      * you'll set up any per-request state that you need, and where you'll
//      * register your hooks for the lifetime of the incoming request.
//      */
//     run?: () => MaybePromise<{
//       /**
//        * The `input` hook is called once the input for the function has been
//        * properly set up. This is where you can modify the input before the
//        * function starts to memoize or execute by returning an object containing
//        * changes to the context.
//        *
//        * For example, to add `foo` to the context, you'd return
//        * `{ foo: "bar" }`.
//        *
//        * @param ctx - The context for the incoming request.
//        * @param steps - The step data in state. Does not include internal IDs.
//        */
//       input?: ({ ctx, steps }) => MaybePromise<unknown>;

//       /**
//        * The `beforeMemoization` hook is called before the function starts to
//        * memoize.
//        */
//       beforeMemoization?: () => MaybePromise<void>;

//       /**
//        * The `afterMemoization` hook is called after the function has finished
//        * memoizing.
//        */
//       afterMemoization?: () => MaybePromise<void>;

//       /**
//        * The `beforeExecution` hook is called before the function starts to
//        * execute. Execution here means that new code is being seen/run for the
//        * first time.
//        */
//       beforeExecution?: () => MaybePromise<void>;

//       /**
//        * The `afterExecution` hook is called after the function has finished
//        * executing.
//        */
//       afterExecution?: () => MaybePromise<void>;

//       /**
//        * The `output` hook is called after the function has finished executing
//        * and before the response is sent back to Inngest. This is where you
//        * can modify the output before it's sent back to Inngest by returning
//        * an object containing changes.
//        *
//        * @param err - The raw error that was thrown by the function, if any, so
//        * that you can capture exact error messages and stack traces.
//        *
//        * @param data - The prepared by unserialized data that was returned by
//        * the function, if any, so that you can modify the output.
//        */
//       output?: ({ err, data }) => MaybePromise<unknown>;

//       /**
//        * The `beforeResponse` hook is called after the output has been set and
//        * before the response is sent back to Inngest. This is where you can
//        * perform any final actions before the response is sent back to Inngest.
//        */
//       beforeResponse?: () => MaybePromise<void>;
//     }>;

//     /**
//      * The `sendEvent` hook is called every time an event is sent to Inngest.
//      */
//     sendEvent?: () => MaybePromise<{
//       /**
//        * The `input` hook is called before the event is sent to Inngest. This
//        * is where you can modify the event before it's sent to Inngest by
//        * returning an object containing changes.
//        */
//       input?: ({ payloads }) => MaybePromise<unknown>;

//       /**
//        * The `output` hook is called after the event has been sent to Inngest.
//        * This is where you can perform any final actions after the event has
//        * been sent to Inngest and can modify the output the SDK sees.
//        */
//       output?: () => MaybePromise<unknown>;
//     }>;
//   }>;
// }

/**
 * @internal
 */
type MiddlewareRunInput<
  TOpts extends ClientOptions = ClientOptions,
  TEvents extends EventsFromOpts<TOpts> = EventsFromOpts<TOpts>
> = <
  TContext extends BaseContext<
    TOpts,
    keyof TEvents & string,
    Record<string, (...args: unknown[]) => unknown>
  >
>(ctx: {
  ctx: Readonly<TContext>;

  /**
   * TODO Remove ID
   */
  steps: Readonly<OpStack>;
  /**
   * TODO Enforce `steps` type: OpStack?
   * TODO Enforce `ctx` type: object?
   */
}) => { ctx?: any; steps?: any } | void;

/**
 * @internal
 */
export type GetMiddlewareRunInputMutation<
  TMiddleware extends InngestMiddleware = InngestMiddleware
> = Await<Await<Await<TMiddleware["register"]>["run"]>["input"]> extends {
  ctx: infer TCtx;
}
  ? TCtx
  : never;

/**
 * @internal
 */
export type MiddlewareStackRunInputMutation<
  TContext,
  TMiddleware extends InngestMiddleware[]
> = ObjectAssign<
  {
    [K in keyof TMiddleware]: GetMiddlewareRunInputMutation<TMiddleware[K]>;
  },
  TContext
>;

const mw1 = createMiddleware({
  name: "mw1",
  register() {
    return {
      run() {
        return {
          input() {
            return {
              ctx: { foo: "bar" },
            };
          },
        };
      },
    };
  },
});

type T0 = GetMiddlewareRunInputMutation<typeof mw1>;
//   ^?
