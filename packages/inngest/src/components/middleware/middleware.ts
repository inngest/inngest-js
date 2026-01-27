import type z from "zod";
import type { stepsSchemas } from "../../api/schema.ts";
import type { ExecutionVersion } from "../../helpers/consts.ts";
import type { Jsonify } from "../../helpers/jsonify.ts";
import type {
  Context,
  EventPayload,
  StepOptions,
  StepOptionsOrId,
} from "../../types.ts";
import type { Inngest } from "../Inngest.ts";
import type { createStepTools } from "../InngestStepTools.ts";

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

  export type TransformClientInputArgs =
    | {
        method: "send";
        input: EventPayload<Record<string, unknown>>[];
      }
    // This type is just to ensure that adding a new method isn't a breaking change
    | {
        method: "other";
        input: unknown;
      };

  /**
   * The argument passed to `transformFunctionInput`.
   */
  export type TransformFunctionInputArgs = {
    ctx: Context.Any;
    steps: z.infer<(typeof stepsSchemas)[ExecutionVersion.V2]>;
  };

  /**
   * The return type from `wrapFunctionHandler`. A callback that receives a `next`
   * function to call the inner handler (or next middleware).
   */
  export type WrapFunctionHandlerReturn = (args: {
    next: () => Promise<unknown>;
    ctx: Context.Any;
  }) => Promise<unknown>;

  export type WrapStepReturn = (args: {
    next: (args: {
      stepOptions: StepOptions;
      input: unknown[];
    }) => Promise<unknown>;
    ctx: Context.Any;
    stepOptions: StepOptions;
    input: unknown[];
  }) => Promise<unknown>;

  /**
   * Information about the incoming HTTP request that triggered this execution.
   */
  export type Request = {
    body: () => Promise<unknown>;
    headers: Readonly<Record<string, string>>;
    method: string;
    url: URL;
  };

  export type WrapRequestArgs = DeepReadonly<{
    requestInfo: Request;
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
   * The return type from `wrapRequest`. A callback that receives a `next`
   * function to call the inner handler (or next middleware).
   */
  export type WrapRequestReturn = (args: {
    next: () => Promise<Response>;
  }) => Promise<Response>;

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
  }>;

  /**
   * The argument passed to `onStepEnd`.
   */
  export type OnStepEndArgs = DeepReadonly<{
    stepInfo: StepInfo;
    ctx: Context.Any;
    data: unknown;
  }>;

  export type StepKind =
    | "invoke"
    | "run"
    | "sendEvent"
    | "sleep"
    | "waitForEvent"
    | "unknown";

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
   *
   * @example
   * ```ts
   * class MyMiddleware extends Middleware.BaseMiddleware {
   *   onStepStart(arg: Middleware.OnStepStartArgs) {
   *     console.log(`Starting step: ${stepInfo.options.id}`);
   *   }
   * }
   * ```
   */
  export class BaseMiddleware {
    /**
     * Declare this to specify how `step.run` output types are transformed.
     *
     * @example
     * ```ts
     * interface PreserveDate extends Middleware.StaticTransform {
     *   Out: this["In"] extends Date ? Date : Jsonify<this["In"]>;
     * }
     *
     * class MyMiddleware extends Middleware.BaseMiddleware {
     *   declare staticTransform: PreserveDate;
     * }
     * ```
     *
     * @default Middleware.DefaultStaticTransform (Date -> string, functions removed, etc.)
     */
    declare staticTransform: DefaultStaticTransform;

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
    onMemoizationEnd?(): void;

    /**
     * Called each time a step successfully completes. Only called for `step.run`
     * and `step.sendEvent`. Never called for memoized step outputs.
     */
    onStepEnd?(arg: Middleware.OnStepEndArgs): void;

    /**
     * Called each time a step errors. Only called for `step.run` and
     * `step.sendEvent`. Never called for memoized errors.
     */
    onStepError?(arg: Middleware.OnStepErrorArgs): void;

    /**
     * Called 1 time per step before running its handler. Only called for
     * `step.run` and `step.sendEvent`.
     */
    onStepStart?(arg: Middleware.OnStepStartArgs): void;

    /**
     * Called when passing input to a client method. Currently, this is only for
     * the `send` method.
     *
     * Return the transformed input. The returned value will be passed to the
     * next middleware and ultimately used as the input.
     */
    transformClientInput?(arg: Middleware.TransformClientInputArgs): unknown;

    /**
     * Called once per run before execution. Use this to modify the function's
     * input context (event data, step tools, custom properties) and memoized
     * step data.
     *
     * Return the (potentially modified) arg object. Each middleware builds on
     * the previous middleware's result.
     */
    transformFunctionInput?(
      arg: Middleware.TransformFunctionInputArgs,
    ): Middleware.TransformFunctionInputArgs;

    /**
     * Called once per run. Use this to wrap the handler for:
     * - AsyncLocalStorage context
     * - Output/error transformation
     * - Logging, timing, or other cross-cutting concerns
     *
     * Returns a callback that receives `{ next }` and must call `next()` to
     * execute the inner handler. Uses onion/callback-chain pattern (same as
     * `wrapStep`).
     */
    wrapFunctionHandler?(): WrapFunctionHandlerReturn;

    /**
     * Called once per request before any other hooks. Use this to validate
     * or inspect the incoming HTTP request (headers, method, URL, body).
     *
     * Returns a callback that receives `{ next }` and must call `next()` to
     * continue processing. Throwing rejects the request.
     *
     * Uses the same onion/callback-chain pattern as `wrapFunctionHandler`.
     */
    wrapRequest?(args: WrapRequestArgs): WrapRequestReturn;

    /**
     * Called many times per step, when finding it.
     *
     * Use to:
     * - Modify step options and input
     * - Modify step output/error
     * - Run arbitrary code before/after the step
     */
    wrapStep?(stepInfo: StepInfo): WrapStepReturn;
  }
}

/**
 * A no-arg constructor for a BaseMiddleware subclass. Used in client options
 * so that fresh instances are created per-request.
 */
export type MiddlewareClass = new () => Middleware.BaseMiddleware;

type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends Function
    ? T
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;
