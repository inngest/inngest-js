import type {
  ExperimentOptions,
  GroupExperiment,
  StepOptionsOrId,
} from "../types.ts";
import {
  type AsyncContext,
  getAsyncCtxSync,
  getAsyncLocalStorage,
  isALSFallback,
} from "./execution/als.ts";
import { getStepOptions } from "./InngestStepTools.ts";

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

  experiment: GroupExperiment;
}

/**
 * Create the `experiment` function that uses the injected run tool for
 * memoized variant selection.
 */
const experiment = (
  experimentRun: (...args: unknown[]) => Promise<unknown>,
) => {
  return async (
    idOrOptions: StepOptionsOrId,
    options: ExperimentOptions<
      Record<string, (...args: unknown[]) => unknown>
    > & {
      withVariant?: boolean;
    },
  ) => {
    const stepOptions = getStepOptions(idOrOptions);

    const variantNames = Object.keys(options.variants);
    if (variantNames.length === 0) {
      throw new Error("`group.experiment()` requires at least one variant");
    }

    const selectedVariant = (await experimentRun(stepOptions, () =>
      options.select(),
    )) as string;

    if (!options.variants[selectedVariant]) {
      throw new Error(
        `group.experiment() selected variant "${selectedVariant}" ` +
          `which is not in the variants record. Available: ${variantNames.join(", ")}`,
      );
    }

    const result = await options.variants[selectedVariant]!();

    if (options.withVariant) {
      return { result, variant: selectedVariant };
    }
    return result;
  };
};

/**
 * Create the `group` tools object provided on the function execution context.
 *
 * @public
 */
export const createGroupTools = (
  experimentRun?: (...args: unknown[]) => Promise<unknown>,
): GroupTools => {
  return {
    parallel,
    ...(experimentRun ? { experiment: experiment(experimentRun) } : {}),
  } as GroupTools;
};
