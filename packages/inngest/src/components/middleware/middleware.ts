import type { z } from "zod/v3";
import type { stepSchema } from "../../api/schema.ts";
import type { Jsonify } from "../../helpers/jsonify.ts";
import type { MaybePromise } from "../../helpers/types.ts";
import type {
  Context,
  EventPayload,
  SendEventBaseOutput,
  StepOptions,
} from "../../types.ts";
import type { Inngest } from "../Inngest.ts";
import type { createStepTools } from "../InngestStepTools.ts";
import type { OpenStringUnion } from "./types.ts";

/**
 * Default transform. Applies the same transform as `JSON.stringify`.
 */
export interface DefaultStaticTransform extends Middleware.StaticTransform {
  Out: Jsonify<this["In"]>;
}

/**
 * Namespace containing middleware-related types and base class.
 */
export namespace Middleware {
  /**
   * Base interface for output transformers. Extend this and override `Out` to
   * create custom transformers. This is necessary because TypeScript doesn't
   * support higher-kinded types.
   *
   * @example
   * ```ts
   * interface BooleanToStringTransform extends Middleware.StaticTransform {
   *   Out: this["In"] extends boolean ? string : this["In"];
   * }
   * ```
   */
  export type StaticTransform = {
    In: unknown;
    Out: unknown;
  };

  /**
   * The step tools available to middleware for extending step functionality.
   * This is the same type as `step` in the function handler context.
   */
  export type StepTools = ReturnType<typeof createStepTools<Inngest.Any>>;

  // It's be nice to make this statically type safe, but it's unclear how to do
  // that in a way that allows for adding new methods without breaking changes.
  export type TransformSendEventArgs = {
    events: EventPayload<Record<string, unknown>>[];
  };

  /**
   * The argument passed to `transformStepInput`.
   */
  export type TransformStepInputArgs = {
    /** Read-only step metadata. */
    readonly stepInfo: Readonly<
      Pick<StepInfo, "hashedId" | "memoized" | "stepKind">
    >;
    /** Mutable step options (id, name). */
    stepOptions: StepOptions;
    /** Mutable step input args. */
    input: unknown[];
  };

  /**
   * The argument passed to `transformFunctionInput`.
   */
  export type TransformFunctionInputArgs = {
    ctx: Context.Any;
    steps: z.infer<typeof stepSchema>;
  };

  /**
   * The argument passed to the static `onRegister` hook.
   */
  export type OnRegisterArgs = {
    client: Inngest.Any;
  };

  /**
   * Information about the incoming HTTP request that triggered this execution.
   */
  export type Request = {
    body: () => Promise<unknown>;
    headers: Readonly<Record<string, string>>;
    method: string;
    url: URL;
  };

  export type WrapFunctionHandlerArgs = DeepReadonly<{
    ctx: Context.Any;
    next: () => Promise<unknown>;
  }>;

  export type WrapRequestArgs = DeepReadonly<{
    next: () => Promise<Response>;
    requestInfo: Request;
    runId: string;
  }>;

  export type WrapSendEventArgs = DeepReadonly<{
    next: () => Promise<SendEventBaseOutput>;
    events: EventPayload<Record<string, unknown>>[];
  }>;

  export type WrapStepArgs = DeepReadonly<{
    ctx: Context.Any;
    next: () => Promise<unknown>;
    stepInfo: StepInfo;
  }>;

  /**
   * The shape of the HTTP response returned by the middleware chain.
   * This is what `next()` resolves with inside `wrapRequest`.
   */
  export type Response = {
    status: number;
    headers: Record<string, string>;
    body: string;
  };

  /**
   * The argument passed to `onStepStart`.
   */
  export type OnStepStartArgs = DeepReadonly<{
    stepInfo: StepInfo;
    ctx: Context.Any;
  }>;

  /**
   * The argument passed to `onStepError`.
   */
  export type OnStepErrorArgs = DeepReadonly<{
    stepInfo: StepInfo;
    ctx: Context.Any;
    error: Error;

    /**
     * Whether this is the final attempt for the step, meaning retries are
     * exhausted or the error is non-retriable. When `false`, the step will be
     * retried.
     */
    isFinalAttempt: boolean;
  }>;

  /**
   * The argument passed to `onStepComplete`.
   */
  export type OnStepCompleteArgs = DeepReadonly<{
    stepInfo: StepInfo;
    ctx: Context.Any;
    data: unknown;
  }>;

  /**
   * The argument passed to `onRunStart`.
   */
  export type OnRunStartArgs = DeepReadonly<{ ctx: Context.Any }>;

  /**
   * The argument passed to `onRunComplete`.
   */
  export type OnRunCompleteArgs = DeepReadonly<{
    ctx: Context.Any;
    data: unknown;
  }>;

  /**
   * The argument passed to `onRunError`.
   */
  export type OnRunErrorArgs = DeepReadonly<{
    ctx: Context.Any;
    error: Error;

    /**
     * Whether this is the final attempt for the function, meaning retries are
     * exhausted or the error is non-retriable. When `false`, the function will
     * be retried.
     */
    isFinalAttempt: boolean;
  }>;

  /**
   * The kind of step. This union may be extended in the future, and will not be
   * considered a breaking change.
   */
  export type StepKind = OpenStringUnion<
    | "ai.infer"
    | "ai.wrap"
    | "fetch"
    | "invoke"
    | "realtime.publish"
    | "run"
    | "sendEvent"
    | "sleep"
    | "waitForEvent"
  >;

  export type StepInfo = {
    /**
     * Unique ID for the step. This is a hash of the user-defined step ID,
     * including the implicit index if the user-defined ID is not unique.
     */
    hashedId: string;

    /**
     * The arguments passed to the step function, if any. For `step.run()`,
     * these are the arguments after the id and handler function.
     */
    input?: unknown[];

    /**
     * Whether the step result is being retrieved from memoized state (true)
     * or being executed fresh (false).
     */
    memoized: boolean;

    /**
     * Based on the first argument passed to the `step` method.
     */
    options: StepOptions;

    stepKind: StepKind;
  };

  /**
   * Base class for creating middleware. Extend this class to create custom
   * middleware with hooks for step execution.
   */
  // @privateRemark
  // Methods are nullish instead of noops as a performance optimization. This is
  // primarily because of `wrapStep`. Each defined `wrapStep` method adds 1 more
  // promise to the chain for each step. This chain runs every time the step
  // completes/errors (even when memoized).
  export class BaseMiddleware {
    /**
     * Declare this to specify how function return types are transformed.
     * Used by `GetFunctionOutput` to determine the public output type of a
     * function.
     *
     * Must match the same structure as `StaticTransform` to imitate
     * higher-kinded types.
     *
     * @example
     * ```ts
     * interface PreserveDate extends Middleware.StaticTransform {
     *   Out: this["In"] extends Date ? Date : Jsonify<this["In"]>;
     * }
     *
     * class MyMiddleware extends Middleware.BaseMiddleware {
     *   declare functionOutputTransform: PreserveDate;
     * }
     * ```
     *
     * @default Middleware.DefaultStaticTransform (e.g. Date -> string)
     */
    declare functionOutputTransform: DefaultStaticTransform;

    /**
     * Declare this to specify how `step.run` output types are transformed.
     *
     * Must match the same of `StaticTransform` to imitate higher-kinded types.
     *
     * @example
     * ```ts
     * interface PreserveDate extends Middleware.StaticTransform {
     *   Out: this["In"] extends Date ? Date : Jsonify<this["In"]>;
     * }
     *
     * class MyMiddleware extends Middleware.BaseMiddleware {
     *   declare stepOutputTransform: PreserveDate;
     * }
     * ```
     *
     * @default Middleware.DefaultStaticTransform (e.g. Date -> string)
     */
    declare stepOutputTransform: DefaultStaticTransform;

    /**
     * Called once when the middleware class is added to an Inngest client or
     * Inngest function. Use this for one-time setup that needs a reference to
     * the client instance (e.g. registering processors, setting feature flags).
     */
    static onRegister?(args: Middleware.OnRegisterArgs): void;

    /**
     * Called once per request, after memoization completes.
     *
     * If all memoized steps have been resolved/rejected, then this hook calls.
     * This is at the top of the function handler when there are 0 memoized
     * steps.
     *
     * If a new step is found before resolving/rejecting all memoized steps,
     * then this is calls.
     */
    onMemoizationEnd?(): MaybePromise<void>;

    /**
     * Called when the function completes successfully. Receives the return
     * value (after `wrapFunctionHandler` transformations). Does NOT fire when
     * the function errors — `onRunError` fires instead.
     */
    onRunComplete?(arg: Middleware.OnRunCompleteArgs): MaybePromise<void>;

    /**
     * Called when the function throws an error. Receives the error instance.
     * Does NOT fire when the function succeeds — `onRunComplete` fires instead.
     */
    onRunError?(arg: Middleware.OnRunErrorArgs): MaybePromise<void>;

    /**
     * Called once per run on the very first request (0 memoized steps,
     * attempt 0). Does NOT fire on subsequent requests where steps are
     * being replayed.
     */
    onRunStart?(arg: Middleware.OnRunStartArgs): MaybePromise<void>;

    /**
     * Called each time a step successfully completes. Only called for `step.run`
     * and `step.sendEvent`. Never called for memoized step outputs.
     *
     * Calls after the `wrapStep` chain resolves, so `data` reflects any
     * transformations applied by `wrapStep` middleware.
     */
    onStepComplete?(arg: Middleware.OnStepCompleteArgs): MaybePromise<void>;

    /**
     * Called each time a step errors. Only called for `step.run` and
     * `step.sendEvent`. Never called for memoized errors.
     */
    onStepError?(arg: Middleware.OnStepErrorArgs): MaybePromise<void>;

    /**
     * Called 1 time per step before running its handler. Only called for
     * `step.run` and `step.sendEvent`.
     */
    onStepStart?(arg: Middleware.OnStepStartArgs): MaybePromise<void>;

    /**
     * Called once per run before execution. Use this to modify the function's
     * input context (event data, step tools, custom properties) and memoized
     * step data.
     *
     * Return the (potentially modified) arg object. Each middleware builds on
     * the previous middleware's result.
     */
    // @privateRemark
    // Input transformation can't happen in `wrapFunctionHandler` because that
    // prevents static type inference for the transformation. For example, if
    // the user added `ctx.db` in `wrapFunctionHandler` then the static types
    // wouldn't show `ctx.db` in the function handler.
    transformFunctionInput?(
      arg: Middleware.TransformFunctionInputArgs,
    ): MaybePromise<Middleware.TransformFunctionInputArgs>;

    /**
     * Called when passing input to a client method. Currently, this is only for
     * the `send` method.
     *
     * Return the transformed input. The returned value will be passed to the
     * next middleware and ultimately used as the input.
     */
    transformSendEvent?(
      arg: Middleware.TransformSendEventArgs,
    ): MaybePromise<EventPayload<Record<string, unknown>>[]>;

    /**
     * Called once per step before the `wrapStep` chain. Use this to modify step
     * options (e.g. the step ID) or step input args.
     *
     * Return the (potentially modified) arg object. Each middleware builds on
     * the previous middleware's result (forward order).
     */
    // @privateRemark
    // Step input transformation could happen in `wrapStep`, but we chose not to
    // for the following reasons:
    // 1. `wrapStep` may have a negative performance impact under certain
    //    workloads.
    // 2. `wrapStep` is a little more complicated to use.
    // 3. Since `transformFunctionInput` must exist, having this hook
    //    establishes a consistent pattern for input transformation.
    transformStepInput?(
      arg: TransformStepInputArgs,
    ): MaybePromise<TransformStepInputArgs>;

    /**
     * Called once per run. Use this to wrap the handler for:
     * - AsyncLocalStorage context
     * - Output/error transformation
     * - Logging, timing, or other cross-cutting concerns
     *
     * Must call `args.next()` to continue processing.
     *
     * **Important:** `next()` only resolves when the function completes. On
     * requests where a fresh step is discovered, control flow is interrupted
     * and `next()` never resolves. Use `try/finally` for cleanup that must
     * run on every request.
     */
    wrapFunctionHandler?(args: WrapFunctionHandlerArgs): Promise<unknown>;

    /**
     * Called once per request before any other hooks. Use this to validate
     * or inspect the incoming HTTP request (headers, method, URL, body).
     *
     * Must call `args.next()` to continue processing.
     */
    wrapRequest?(args: WrapRequestArgs): Promise<Response>;

    /**
     * Called once per `client.send()` and `step.sendEvent()` call. Use this to
     * wrap the outgoing HTTP request to the Inngest API.
     *
     * Must call `args.next()` to continue processing.
     */
    wrapSendEvent?(args: WrapSendEventArgs): Promise<SendEventBaseOutput>;

    /**
     * Called many times per step, when finding it.
     *
     * Use to:
     * - Modify step output/error
     * - Run arbitrary code before/after the step
     *
     * Must call `args.next()` to continue processing.
     */
    wrapStep?(args: WrapStepArgs): Promise<unknown>;
  }
}

/**
 * A no-arg constructor for a BaseMiddleware subclass. Used in client options
 * so that fresh instances are created per-request.
 */
export type MiddlewareClass = (new () => Middleware.BaseMiddleware) & {
  // Static methods aren't captured by `new () => ...`, so we repeat it here.
  onRegister?(arg: Middleware.OnRegisterArgs): void;
};

type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends Function
    ? T
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;
