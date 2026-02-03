import type z from "zod";
import type { stepsSchemas } from "../api/schema.ts";
import type { ExecutionVersion } from "../helpers/consts.ts";
import type { Jsonify } from "../helpers/jsonify.ts";
import type { EventPayload } from "../types.ts";

type StepKind = "run" | "sendEvent";

/**
 * Default transform. Applies the same transform as `JSON.stringify`.
 */
export interface DefaultStaticTransform extends Middleware.StaticTransform {
  Out: Jsonify<this["In"]>;
}

/**
 * Base class for creating middleware. Extend this class to create custom
 * middleware with hooks for step execution.
 *
 * @example
 * ```ts
 * class MyMiddleware extends Middleware.BaseMiddleware {
 *   onStepStart(runInfo: Middleware.RunInfo, stepInfo: Middleware.StepInfo) {
 *     console.log(`Starting step: ${stepInfo.id}`);
 *   }
 * }
 * ```
 */
class BaseMiddlewareImpl {
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
   * Called 1 time per step before running its handler. Only called for
   * `step.run` and `step.sendEvent`.
   */
  onStepStart?(
    runInfo: Middleware.RunInfo,
    stepInfo: Middleware.StepInfo,
  ): void;

  /**
   * Called 1 or more times per step, each time the step is "reached"
   * (regardless of whether it's already memoized). This gives an opportunity to
   * modify step inputs and outputs.
   */
  transformStep?(
    runInfo: Middleware.RunInfo,
    stepInfo: Middleware.StepInfo,
    handler: () => unknown,
  ): unknown;

  /**
   * Called each time a step errors. Only called for `step.run` and
   * `step.sendEvent`. Never called for memoized errors.
   */
  onStepError?(
    runInfo: Middleware.RunInfo,
    stepInfo: Middleware.StepInfo,
    error: Error,
  ): void;
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

  export type RunInfo = {
    attempt: number;
    event: EventPayload;
    events: EventPayload[];
    runId: string;
    steps: Record<string, z.infer<(typeof stepsSchemas)[ExecutionVersion.V2]>>;
  };

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

  export const BaseMiddleware = BaseMiddlewareImpl;
  export type BaseMiddleware = BaseMiddlewareImpl;
}
