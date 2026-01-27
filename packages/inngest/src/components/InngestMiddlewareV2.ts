interface Hooks {
  transformStep?: (handler: () => unknown) => unknown;
}

export class InngestMiddlewareV2 implements Hooks {
  /**
   * Called before a step method runs. Override this method to wrap step execution
   * with before/after hooks.
   *
   * @param handler - Function that executes the actual step. Call this to run the step.
   * @returns The return value is NOT passed to the caller; the step's return value is used instead.
   */
  transformStep?(handler: () => unknown): unknown;
}
