export interface StepInfo {
  /**
   * Whether the step result is being retrieved from memoized state (true)
   * or being executed fresh (false).
   */
  memoized: boolean;
}

export class InngestMiddlewareV2 {
  /**
   * Called 1 or more times per step, each time the step is "reached"
   * (regardless of whether it's already memoized). This gives an opportunity to
   * modify step inputs and outputs.
   */
  transformStep?(handler: () => unknown, stepInfo: StepInfo): unknown;
}
