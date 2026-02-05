import type z from "zod";
import type { stepsSchemas } from "../../api/schema.ts";
import type { ExecutionVersion } from "../../helpers/consts.ts";
import type { Jsonify } from "../../helpers/jsonify.ts";
import type { EventPayload } from "../../types.ts";
import type { Inngest } from "../Inngest.ts";
import type { createStepTools } from "../InngestStepTools.ts";

type StepKind = "run" | "sendEvent" | "invoke";

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

  /**
   * Information about the current run, passed to middleware hooks.
   */
  export type RunInfo = {
    attempt: number;
    event: EventPayload;
    events: EventPayload[];
    runId: string;
    step: StepTools;
    steps: z.infer<(typeof stepsSchemas)[ExecutionVersion.V2]>;
  };

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
   * The argument passed to `transformRunInput`.
   */
  export type TransformRunInputArgs = {
    handler: () => Promise<unknown>;
    runInfo: RunInfo;
  };

  /**
   * The argument passed to `transformRunOutput`.
   */
  export type TransformRunOutputArgs = {
    output: unknown;
    runInfo: RunInfo;
  };

  /**
   * The argument passed to `transformRunError`.
   */
  export type TransformRunErrorArgs = {
    error: Error;
    runInfo: RunInfo;
  };

  /**
   * The argument passed to `transformStepInput`.
   *
   * **Important:** If you modify `stepInfo.id`, the memoization lookup will
   * use the new ID. This allows middleware to remap step IDs (e.g., for
   * encryption middleware that needs to use a different memoized state).
   *
   * Note that `stepInfo.memoized` reflects the status BEFORE your
   * transformation - it may change if the new ID has different memoized state.
   */
  export type TransformStepInputArgs = {
    handler: () => Promise<unknown>;
    stepInfo: StepInfo;
    runInfo: RunInfo;
  };

  /**
   * The argument passed to `transformStepOutput`.
   */
  export type TransformStepOutputArgs = {
    output: unknown;
    stepInfo: StepInfo;
    runInfo: RunInfo;
  };

  /**
   * The argument passed to `transformStepError`.
   */
  export type TransformStepErrorArgs = {
    error: Error;
    stepInfo: StepInfo;
    runInfo: RunInfo;
  };

  /**
   * The argument passed to `onStepStart`.
   */
  export type OnStepStartArgs = DeepReadonly<{
    stepInfo: StepInfo;
    runInfo: RunInfo;
  }>;

  /**
   * The argument passed to `onStepError`.
   */
  export type OnStepErrorArgs = DeepReadonly<{
    stepInfo: StepInfo;
    runInfo: RunInfo;
    error: Error;
  }>;

  /**
   * The argument passed to `onStepEnd`.
   */
  export type OnStepEndArgs = DeepReadonly<{
    stepInfo: StepInfo;
    runInfo: RunInfo;
    data: unknown;
  }>;

  export type StepInfo = {
    /**
     * Unique ID for the step. This is a hash of the user-defined step ID,
     * including the implicit index if the user-defined ID is not unique.
     */
    hashedId: string;

    /**
     * User-defined step ID.
     */
    id: string;

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
     * User-defined step name. The same as `id` if no explicit user-defined `name`
     * is provided.
     */
    name: string;

    stepKind: StepKind;
  };

  /**
   * Base class for creating middleware. Extend this class to create custom
   * middleware with hooks for step execution.
   *
   * @example
   * ```ts
   * class MyMiddleware extends Middleware.BaseMiddleware {
   *   onStepStart(stepInfo: Middleware.StepInfo, runInfo: Middleware.RunInfo) {
   *     console.log(`Starting step: ${stepInfo.id}`);
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
     * Called when the run throws an error. Use this to transform or wrap the
     * error.
     *
     * Return the transformed error. The returned error will be passed to the
     * next middleware and ultimately used as the run's error.
     */
    transformRunError?(arg: Middleware.TransformRunErrorArgs): Error;

    /**
     * Called once per run before execution. Use this to:
     * - Add properties to `runInfo`
     * - Add methods to `runInfo.step`
     * - Wrap the handler (e.g., for AsyncLocalStorage)
     * - Modify event data
     *
     * Return the (potentially modified) arg object.
     */
    transformRunInput?(
      arg: Middleware.TransformRunInputArgs,
    ): Middleware.TransformRunInputArgs;

    /**
     * Called when the run completes successfully. Use this to transform the
     * output data.
     *
     * Return the transformed output. The returned value will be passed to the
     * next middleware and ultimately used as the run's output.
     */
    transformRunOutput?(arg: Middleware.TransformRunOutputArgs): unknown;

    /**
     * Called when a memoized step has an error. Use this to transform or wrap
     * the step error.
     *
     * Return the transformed error. The returned error will be passed to the
     * next middleware and ultimately thrown from the step.
     */
    transformStepError?(arg: Middleware.TransformStepErrorArgs): Error;

    /**
     * Called when a step is about to be executed (fresh execution only, not
     * for memoized steps). Use this to wrap the step handler, e.g., for
     * AsyncLocalStorage or instrumentation.
     *
     * Return the (potentially modified) arg object.
     */
    transformStepInput?(
      arg: Middleware.TransformStepInputArgs,
    ): Middleware.TransformStepInputArgs;

    /**
     * Called when a step completes successfully (for memoized step data). Use
     * this to transform the step output.
     *
     * Return the transformed output. The returned value will be passed to the
     * next middleware and ultimately returned from the step.
     *
     * @example
     * ```ts
     * class MyMiddleware extends Middleware.BaseMiddleware {
     *   override transformStepOutput(arg: Middleware.TransformStepOutputArg) {
     *     return decrypt(arg.output);
     *   }
     * }
     * ```
     */
    transformStepOutput?(arg: Middleware.TransformStepOutputArgs): unknown;
  }
}

type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;
