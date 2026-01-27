interface Hooks {
  transformStep?: (handler: () => unknown) => unknown;
}

/**
 * A new middleware class that provides simpler hooks for common operations.
 *
 * @example
 * ```ts
 * class MyMiddleware extends InngestMiddlewareV2 {
 *   async transformStep(handler: () => unknown) {
 *     console.log("before running");
 *     const output = await handler();
 *     console.log("after running");
 *     return output;
 *   }
 * }
 * ```
 */
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
