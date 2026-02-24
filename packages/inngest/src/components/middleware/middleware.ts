import type { Jsonify } from "../../helpers/jsonify.ts";
import type { MaybePromise } from "../../helpers/types.ts";
import type {
  Context,
  EventPayload,
  JsonError,
  SendEventBaseOutput,
  StepOptions,
} from "../../types.ts";
import type { Inngest } from "../Inngest.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import type { createStepTools } from "../InngestStepTools.ts";
import type { OpenStringUnion } from "./types.ts";

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
   * Default transform. Applies the same transform as `JSON.stringify`.
   */
  export interface DefaultStaticTransform extends StaticTransform {
    Out: Jsonify<this["In"]>;
  }

  /**
   * The step tools available to middleware for extending step functionality.
   * This is the same type as `step` in the function handler context.
   */
  export type StepTools = ReturnType<typeof createStepTools<Inngest.Any>>;

  /**
   * The argument passed to `transformSendEvent`.
   */
  export type TransformSendEventArgs = {
    events: EventPayload<Record<string, unknown>>[];
    readonly fn: DeepReadonly<InngestFunction.Any> | null;
  };

  /**
   * The argument passed to `transformStepInput`.
   */
  export type TransformStepInputArgs = {
    readonly fn: DeepReadonly<InngestFunction.Any>;
    readonly stepInfo: Readonly<
      Pick<StepInfo, "hashedId" | "memoized" | "stepType">
    >;
    stepOptions: StepOptions;
    input: unknown[];
  };

  /** The argument passed to `wrapStepHandler`. */
  export type WrapStepHandlerArgs = DeepReadonly<{
    ctx: Context.Any;
    fn: InngestFunction.Any;
    next: () => Promise<unknown>;
    stepInfo: StepInfo;
  }>;

  /**
   * A single memoized step entry received in `transformFunctionInput`.
   */
  type MemoizedStep =
    | { type: "data"; data: unknown }
    | { type: "error"; error: JsonError }
    | { type: "input"; input: unknown };

  /**
   * Memoized step state keyed by hashed step ID.
   */
  type MemoizedSteps = Record<string, MemoizedStep>;

  /**
   * The argument passed to `transformFunctionInput`.
   */
  export type TransformFunctionInputArgs = {
    ctx: Context.Any;
    readonly fn: DeepReadonly<InngestFunction.Any>;
    steps: MemoizedSteps;
  };

  /**
   * The argument passed to the static `onRegister` hook.
   */
  export type OnRegisterArgs = Readonly<{
    client: Inngest.Any;
    fn: InngestFunction.Any | null;
  }>;

  /**
   * Information about the incoming HTTP request that triggered this execution.
   */
  export type Request = {
    body: () => Promise<unknown>;
    headers: Readonly<Record<string, string>>;
    method: string;
    url: URL;
  };

  /** The argument passed to `wrapFunctionHandler`. */
  export type WrapFunctionHandlerArgs = DeepReadonly<{
    ctx: Context.Any;
    fn: InngestFunction.Any;
    next: () => Promise<unknown>;
  }>;

  /** The argument passed to `wrapRequest`. */
  export type WrapRequestArgs = DeepReadonly<{
    fn: InngestFunction.Any | null;
    next: () => Promise<Response>;
    requestInfo: Request;
    runId: string;
  }>;

  /** The argument passed to `wrapSendEvent`. */
  export type WrapSendEventArgs = DeepReadonly<{
    events: EventPayload<Record<string, unknown>>[];
    fn: InngestFunction.Any | null;
    next: () => Promise<SendEventBaseOutput>;
  }>;

  /** The argument passed to `wrapStep`. */
  export type WrapStepArgs = DeepReadonly<{
    ctx: Context.Any;
    fn: InngestFunction.Any;
    next: () => Promise<unknown>;
    stepInfo: StepInfo;
  }>;

  /**
   * The shape of the HTTP response returned by the middleware chain.
   * This is what `next()` resolves with inside `wrapRequest`.
   */
  export type Response = {
    body: string;
    headers: Record<string, string>;
    status: number;
  };

  /**
   * The argument passed to `onMemoizationEnd`.
   */
  export type OnMemoizationEndArgs = DeepReadonly<{
    ctx: Context.Any;
    fn: InngestFunction.Any;
  }>;

  /**
   * The argument passed to `onStepStart`.
   */
  export type OnStepStartArgs = DeepReadonly<{
    ctx: Context.Any;
    fn: InngestFunction.Any;
    stepInfo: StepInfo;
  }>;

  /**
   * The argument passed to `onStepError`.
   */
  export type OnStepErrorArgs = DeepReadonly<{
    ctx: Context.Any;
    error: Error;
    fn: InngestFunction.Any;

    /**
     * Whether this is the final attempt for the step, meaning retries are
     * exhausted or the error is non-retriable. When `false`, the step will be
     * retried.
     */
    isFinalAttempt: boolean;

    stepInfo: StepInfo;
  }>;

  /**
   * The argument passed to `onStepComplete`.
   */
  export type OnStepCompleteArgs = DeepReadonly<{
    ctx: Context.Any;
    fn: InngestFunction.Any;
    output: unknown;
    stepInfo: StepInfo;
  }>;

  /**
   * The argument passed to `onRunStart`.
   */
  export type OnRunStartArgs = DeepReadonly<{
    ctx: Context.Any;
    fn: InngestFunction.Any;
  }>;

  /**
   * The argument passed to `onRunComplete`.
   */
  export type OnRunCompleteArgs = DeepReadonly<{
    ctx: Context.Any;
    fn: InngestFunction.Any;
    output: unknown;
  }>;

  /**
   * The argument passed to `onRunError`.
   */
  export type OnRunErrorArgs = DeepReadonly<{
    ctx: Context.Any;
    error: Error;
    fn: InngestFunction.Any;

    /**
     * Whether this is the final attempt for the function, meaning retries are
     * exhausted or the error is non-retriable. When `false`, the function will
     * be retried.
     */
    isFinalAttempt: boolean;
  }>;

  /**
   * The type of step. This union may be extended in the future, and will not be
   * considered a breaking change.
   */
  export type StepType = OpenStringUnion<
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

    stepType: StepType;
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
  export abstract class BaseMiddleware {
    readonly client: Inngest.Any;

    /**
     * Used to identify the middleware instance in logs. Uniqueness is not
     * required, though using multiple middleware with the same ID in the same
     * app may cause confusion when debugging.
     */
    abstract readonly id: string;

    /**
     * Declare this to statically specify how function return types are
     * transformed. By default, the function return type is Jsonified.
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
     * Declare this to statically specify how step output types are transformed.
     * By default, the step output type is Jsonified.
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
     *   declare stepOutputTransform: PreserveDate;
     * }
     * ```
     *
     * @default Middleware.DefaultStaticTransform (e.g. Date -> string)
     */
    declare stepOutputTransform: DefaultStaticTransform;

    constructor({ client }: { client: Inngest.Any }) {
      this.client = client;
    }

    /**
     * Called when the middleware class is added to an Inngest client or Inngest
     * function. Use this for one-time setup that needs a reference to the
     * client instance (e.g. registering processors, setting feature flags).
     *
     * Do not mutate arguments.
     */
    static onRegister?(args: Middleware.OnRegisterArgs): void;

    /**
     * Called 1 time per request, after memoization completes.
     *
     * If all memoized steps have been resolved/rejected, then this hook calls.
     * This is at the top of the function handler when there are 0 memoized
     * steps.
     *
     * If a new step is found before resolving/rejecting all memoized steps,
     * then this calls.
     *
     * Do not mutate arguments.
     */
    onMemoizationEnd?(arg: Middleware.OnMemoizationEndArgs): MaybePromise<void>;

    /**
     * Called when the run completes successfully. Does NOT call when the run
     * errors: `onRunError` calls instead.
     *
     * Do not mutate arguments.
     */
    onRunComplete?(arg: Middleware.OnRunCompleteArgs): MaybePromise<void>;

    /**
     * Called when the function throws an error.
     *
     * Do not mutate arguments.
     */
    onRunError?(arg: Middleware.OnRunErrorArgs): MaybePromise<void>;

    /**
     * Called 1 time per run on the very first request (0 memoized steps,
     * attempt 0). Does NOT call on subsequent requests where steps are being
     * replayed.
     *
     * Do not mutate arguments.
     */
    onRunStart?(arg: Middleware.OnRunStartArgs): MaybePromise<void>;

    /**
     * Called when a step successfully completes. Only called for `step.run`
     * and `step.sendEvent`. Never called for memoized step outputs. Does NOT
     * call when the step errors: `onStepError` calls instead.
     *
     * Do not mutate arguments.
     */
    onStepComplete?(arg: Middleware.OnStepCompleteArgs): MaybePromise<void>;

    /**
     * Called each time a step errors. Only called for `step.run` and
     * `step.sendEvent`. Never called for memoized errors.
     *
     * Do not mutate arguments.
     */
    onStepError?(arg: Middleware.OnStepErrorArgs): MaybePromise<void>;

    /**
     * Called 1 time per step before running its handler. Only called for
     * `step.run` and `step.sendEvent`.
     *
     * Do not mutate arguments.
     */
    onStepStart?(arg: Middleware.OnStepStartArgs): MaybePromise<void>;

    /**
     * Called 1 time per request (likely multiple times per run). Return the
     * (potentially modified) arg object.
     *
     * Use cases:
     * - Dependency injection.
     * - Deserialize events before passing it to the function handler.
     *
     * Do not mutate arguments.
     */
    // @privateRemark
    // This hook exists because `wrapFunctionHandler` can't be used for the
    // transformation's static type inference. For example, if the user added
    // `ctx.db` in `wrapFunctionHandler` then the static types wouldn't show
    // `ctx.db` in the function handler.
    transformFunctionInput?(
      arg: Middleware.TransformFunctionInputArgs,
    ): MaybePromise<Middleware.TransformFunctionInputArgs>;

    /**
     * Called when sending events. This is either `step.sendEvent` or
     * `client.send`. Return the (potentially modified) arg object.
     *
     * Use cases:
     * - Serialize event data before sending it to the Inngest Server.
     *
     * Do not mutate arguments.
     */
    transformSendEvent?(
      arg: Middleware.TransformSendEventArgs,
    ): MaybePromise<Middleware.TransformSendEventArgs>;

    /**
     * Called 1 time per step per request (likely multiple times per step).
     * Return the (potentially modified) arg object.
     *
     * Use cases:
     * - Modify step options (e.g. the step ID).
     * - Modify step input args.
     *
     * Do not mutate arguments.
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
     * Called 1 time per request.
     *
     * Use cases:
     * - AsyncLocalStorage context.
     * - Function-level output/error transformation.
     * - Prepend/append steps around the function handler.
     *
     * Must call `next()` to continue processing. Do not mutate arguments.
     *
     * **Important:** `next()` only resolves when the function completes. On
     * requests where a fresh step is discovered, control flow is interrupted
     * and `next()` never resolves.
     */
    wrapFunctionHandler?(args: WrapFunctionHandlerArgs): Promise<unknown>;

    /**
     * Called 1 time per request.
     *
     * Use cases:
     * - Custom auth.
     * - Expose request data to the Inngest function handler.
     * - Metrics.
     *
     * Must call `next()` to continue processing. Do not mutate arguments.
     */
    wrapRequest?(args: WrapRequestArgs): Promise<Response>;

    /**
     * Called each time events are sent (either `client.send` or
     * `step.sendEvent`).
     *
     * Use cases:
     * - Backup events (e.g. blob store) when they fail to send.
     * - Metrics.
     *
     * Must call `next()` to continue processing. Do not mutate arguments.
     */
    wrapSendEvent?(args: WrapSendEventArgs): Promise<SendEventBaseOutput>;

    /**
     * Called 1 time per step per request. Called for all step kinds. Depending
     * on your use case, you may want `wrapStepHandler` instead.
     *
     * Use cases:
     * - Deserialize step output before returning it to the function handler.
     * - Handle step failure errors (after exhausting retries).
     * - Prepend/append steps around a step.
     *
     * Must call `next()` to continue processing. Do not mutate arguments.
     *
     * NOTE: `next()` only resolves when the step completes/fails. On requests
     * where a fresh step is discovered, control flow is interrupted and
     * `next()` never resolves.
     */
    wrapStep?(args: WrapStepArgs): Promise<unknown>;

    /**
     * Called 1 time per step attempt. Wraps the step's handler. Only called for
     * `step.run` and `step.sendEvent`. Use this to modify the handler's
     * returned output or thrown error before it's sent to the Inngest Server.
     *
     * Use cases:
     * - Serialize step output before sending it to the Inngest Server.
     * - Handle step attempt errors (before exhausting retries).
     *
     * Must call `next()` to continue processing. Do not mutate arguments.
     */
    // @privateRemark
    // This hook exists because of checkpointing. For serialization middleware
    // to work with checkpointing, we need to both:
    // 1. Serialize the step output before sending it to the Inngest Server.
    // 2. Deserialize the step output before returning it to the function handler.
    //
    // We initially solved this by calling `wrapStep` twice per step per
    // request. But this breaks the "prepend with step" logic since we'd
    // encounter the prepended step twice; this caused us to run the prepended
    // step twice.
    //
    // Now that we have `wrapStepHandler`, it can be responsible for
    // serialization and `wrapStep` can be responsible for deserialization.
    wrapStepHandler?(args: WrapStepHandlerArgs): Promise<unknown>;
  }

  /**
   * A no-arg constructor for a BaseMiddleware subclass. Used in client and
   * function options so that fresh instances are created per-request.
   */
  export type Class = (new (args: {
    client: Inngest.Any;
  }) => BaseMiddleware) & {
    // Static methods aren't captured by `new () => ...`, so we repeat it here.
    onRegister?(arg: OnRegisterArgs): void;
  };
}

type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends Date | Function
    ? T
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;
