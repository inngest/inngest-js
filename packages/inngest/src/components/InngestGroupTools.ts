import {
  type AsyncContext,
  getAsyncCtxSync,
  getAsyncLocalStorage,
  isALSFallback,
} from "./execution/als.ts";
import type {
  DeferCallback,
  DeferHandle,
} from "./execution/InngestExecution.ts";

/**
 * Options for the `group.parallel()` helper.
 */
export interface ParallelOptions {
  /**
   * The parallel mode to apply to all steps created within the callback.
   *
   * - `"race"`: Steps will be executed with race semantics, meaning the first
   *   step to complete will "win" and remaining steps may be cancelled.
   */
  mode?: "race";
}

/**
 * A helper that sets the parallel mode for all steps created within the
 * callback. This allows you to use native `Promise.race()` with cleaner syntax.
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
const parallel = async <T>(
  optionsOrCallback: ParallelOptions | (() => Promise<T>),
  maybeCallback?: () => Promise<T>,
): Promise<T> => {
  const options: ParallelOptions =
    typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
  const callback =
    typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;

  if (!callback) {
    throw new Error("`group.parallel()` requires a callback function");
  }

  const currentCtx = getAsyncCtxSync();

  if (!currentCtx?.execution) {
    throw new Error(
      "`group.parallel()` must be called within an Inngest function execution",
    );
  }

  const als = await getAsyncLocalStorage();

  if (isALSFallback()) {
    throw new Error(
      "`group.parallel()` requires AsyncLocalStorage support, which is not available in this runtime. " +
        "Workaround: Pass `parallelMode` directly to each step:\n" +
        '  step.run({ id: "my-step", parallelMode: "race" }, fn)',
    );
  }

  // Create a new context with the parallelMode set
  const nestedCtx: AsyncContext = {
    ...currentCtx,
    execution: {
      ...currentCtx.execution,
      parallelMode: options.mode ?? "race",
    },
  };

  // Run the callback inside the nested context
  return als.run(nestedCtx, callback);
};

/**
 * Register a deferred group callback that will be executed after the function
 * completes. Returns a handle that can be used to cancel the defer before the
 * function finishes.
 *
 * @example
 * ```ts
 * const handle = group.defer("cleanup", async ({ result, error }) => {
 *   await step.run("cleanup-step", () => doCleanup());
 * });
 *
 * // Optionally cancel it before the function ends
 * handle.cancel();
 * ```
 */
const defer = (name: string, callback: DeferCallback): DeferHandle => {
  const currentCtx = getAsyncCtxSync();

  if (!currentCtx?.execution) {
    throw new Error(
      "`group.defer()` must be called within an Inngest function execution",
    );
  }

  const instance = currentCtx.execution.instance;
  instance.registerDefer(name, callback);

  return {
    cancel: () => {
      instance.cancelDefer(name);
    },
  };
};

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

  /**
   * Register a deferred callback that runs after the function completes.
   * Returns a handle with a `cancel()` method to prevent execution.
   *
   * @example
   * ```ts
   * const handle = group.defer("cleanup", async ({ result, error }) => {
   *   await step.run("cleanup-step", () => doCleanup());
   * });
   *
   * // Optionally cancel before the function ends
   * handle.cancel();
   * ```
   */
  defer: (name: string, callback: DeferCallback) => DeferHandle;
}

/**
 * Create the `group` tools object provided on the function execution context.
 *
 * @public
 */
export const createGroupTools = (): GroupTools => {
  return { parallel, defer };
};
