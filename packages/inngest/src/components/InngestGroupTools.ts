import { type ParallelOptions, parallel } from "./InngestStepTools.ts";

/**
 * Tools for grouping and coordinating steps.
 *
 * @public
 */
export interface GroupTools {
  /**
   * Run a callback where all steps automatically receive a `parallelMode`
   * option, removing the need to tag each step individually. Defaults to
   * `"race"` mode.
   *
   * @example
   * ```ts
   * // Defaults to "race" mode
   * const winner = await group.parallel(async () => {
   *   return Promise.race([
   *     step.run("a", () => "a"),
   *     step.run("b", () => "b"),
   *     step.run("c", () => "c"),
   *   ]);
   * });
   *
   * // Or explicitly specify the mode
   * const winner = await group.parallel({ mode: "race" }, async () => {
   *   return Promise.race([
   *     step.run("a", () => "a"),
   *     step.run("b", () => "b"),
   *   ]);
   * });
   * ```
   */
  parallel: <T>(
    optionsOrCallback: ParallelOptions | (() => Promise<T>),
    maybeCallback?: () => Promise<T>,
  ) => Promise<T>;
}

/**
 * Create the `group` tools object provided on the function execution context.
 *
 * @public
 */
export const createGroupTools = (): GroupTools => {
  return { parallel };
};
