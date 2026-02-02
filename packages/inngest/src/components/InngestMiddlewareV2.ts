type StepKind = "run" | "sendEvent";

export interface StepInfo {
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
}

export class InngestMiddlewareV2 {
  /**
   * Called 1 time per step before running its handler. Only called for
   * `step.run` and `step.sendEvent`.
   */
  onStepStart?(stepInfo: StepInfo): void;

  /**
   * Called 1 or more times per step, each time the step is "reached"
   * (regardless of whether it's already memoized). This gives an opportunity to
   * modify step inputs and outputs.
   */
  transformStep?(handler: () => unknown, stepInfo: StepInfo): unknown;
}
