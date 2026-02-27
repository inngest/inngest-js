import type { IsNever } from "../helpers/types.ts";
import type { StepOptionsOrId } from "../types.ts";
import {
  type AsyncContext,
  getAsyncCtxSync,
  getAsyncLocalStorage,
  isALSFallback,
} from "./execution/als.ts";
import { getStepOptions } from "./InngestStepTools.ts";
import { NonRetriableError } from "./NonRetriableError.ts";

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
 * Configuration for how the experiment selects a variant.
 */
export interface ExperimentStrategyConfig {
  strategy: string;
  weights?: Record<string, number>;
  nullishBucket?: boolean;
}

/**
 * A callable selection function that also carries strategy metadata.
 */
export interface ExperimentSelectFn {
  (variantNames?: string[]): Promise<string> | string;
  __experimentConfig: ExperimentStrategyConfig;
}

/**
 * Options for `group.experiment()`.
 */
export interface ExperimentOptions<
  TVariants extends Record<string, () => unknown>,
> {
  /**
   * A map of variant names to callbacks. The selected variant's callback will
   * be executed at the top level so that any `step.*` calls inside it go
   * through normal step discovery.
   */
  variants: TVariants;

  /**
   * A selection function that returns the name of the variant to execute.
   * The result is memoized via a step so the same variant is used on retries.
   */
  select: ExperimentSelectFn;
}

/**
 * Options for `group.experiment()` when `withVariant` is true, which causes
 * the return type to include both the result and the selected variant name.
 */
export interface ExperimentOptionsWithVariant<
  TVariants extends Record<string, () => unknown>,
> extends ExperimentOptions<TVariants> {
  /**
   * When true, the return value includes the variant name alongside the result.
   */
  withVariant: true;
}

/**
 * Computes the return type of an experiment based on variant callbacks.
 *
 * When `TConstraint` is `never`, the return type is inferred as the union of
 * all variant callback return types. Otherwise `TConstraint` is used directly.
 */
export type VariantResult<
  TConstraint,
  TVariants extends Record<string, () => unknown>,
> = IsNever<TConstraint> extends true
  ? Awaited<ReturnType<TVariants[keyof TVariants]>>
  : TConstraint;

/**
 * Metadata values stored alongside the experiment step for UI rendering.
 */
export interface ExperimentMetadataValues {
  experiment_name: string;
  variant_selected: string;
  selection_strategy: string;
  available_variants: string[];
  variant_weights?: Record<string, number>;
}

/**
 * Overloaded interface for `group.experiment()`.
 */
export interface GroupExperiment {
  /**
   * Run an A/B experiment that selects and executes a variant. Returns both
   * the result and the selected variant name.
   */
  <TVariants extends Record<string, () => unknown>>(
    idOrOptions: StepOptionsOrId,
    options: ExperimentOptionsWithVariant<TVariants>,
  ): Promise<{
    result: VariantResult<never, TVariants>;
    variant: string;
  }>;

  /**
   * Run an A/B experiment that selects and executes a variant. Returns only
   * the variant callback's result.
   */
  <TVariants extends Record<string, () => unknown>>(
    idOrOptions: StepOptionsOrId,
    options: ExperimentOptions<TVariants>,
  ): Promise<VariantResult<never, TVariants>>;
}

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
   * Run an A/B experiment within a function. Selects a variant via a memoized
   * step, then executes the selected variant's callback at the top level so
   * its `step.*` calls go through normal step discovery.
   *
   * @example
   * ```ts
   * const result = await group.experiment("checkout-flow", {
   *   variants: {
   *     control: () => step.run("control-checkout", () => oldCheckout()),
   *     new_flow: () => step.run("new-checkout", () => newCheckout()),
   *   },
   *   select: Object.assign(() => "control", {
   *     __experimentConfig: { strategy: "weighted", weights: { control: 80, new_flow: 20 } },
   *   }),
   * });
   * ```
   */
  experiment: GroupExperiment;
}

/**
 * Dependencies injected into `createGroupTools` from the execution engine.
 */
export interface GroupToolsDeps {
  /**
   * A `step.run` variant with `opts.type = "group.experiment"`, extracted from
   * step tools via the experiment symbol. Undefined when not available.
   */
  // biome-ignore lint/suspicious/noExplicitAny: internal plumbing
  experimentStepRun?: (...args: any[]) => Promise<any>;
}

/**
 * Create the `group` tools object provided on the function execution context.
 *
 * @public
 */
export const createGroupTools = (deps?: GroupToolsDeps): GroupTools => {
  const experiment: GroupExperiment = (async (
    idOrOptions: StepOptionsOrId,
    // biome-ignore lint/suspicious/noExplicitAny: implementation signature for overloaded interface
    options: any,
  ) => {
    if (!deps?.experimentStepRun) {
      throw new Error(
        "`group.experiment()` requires step tools to be available. " +
          "Ensure you are calling this within an Inngest function execution.",
      );
    }

    const { variants, select, withVariant } = options;
    const variantNames = Object.keys(variants);

    if (variantNames.length === 0) {
      throw new Error(
        "`group.experiment()` requires at least one variant to be defined.",
      );
    }

    const stepOpts = getStepOptions(idOrOptions);

    // Use the experiment step run to memoize the variant selection.
    // This creates a StepPlanned opcode with opts.type = "group.experiment".
    let experimentStepHashedId: string | undefined;

    const selectedVariant: string = await deps.experimentStepRun(
      idOrOptions,
      async () => {
        // Capture the hashed step ID so we can propagate it to variant sub-steps.
        experimentStepHashedId =
          getAsyncCtxSync()?.execution?.executingStep?.id;

        const result = await select(variantNames);

        if (!variantNames.includes(result)) {
          throw new NonRetriableError(
            `group.experiment("${stepOpts.id}"): select() returned "${result}" ` +
              `which is not a known variant. Available variants: ${variantNames.join(", ")}`,
          );
        }

        // Attach experiment metadata to this step's OutgoingOp.
        const ctx = getAsyncCtxSync();
        const execInstance = ctx?.execution?.instance;

        if (execInstance && experimentStepHashedId) {
          execInstance.addMetadata(
            experimentStepHashedId,
            "inngest.experiment",
            "step",
            "merge",
            {
              experiment_name: stepOpts.id,
              variant_selected: result,
              selection_strategy: select.__experimentConfig.strategy,
              available_variants: variantNames,
              ...(select.__experimentConfig.weights && {
                variant_weights: select.__experimentConfig.weights,
              }),
            },
          );

          if (select.__experimentConfig.nullishBucket) {
            execInstance.addMetadata(
              experimentStepHashedId,
              "inngest.warning",
              "step",
              "merge",
              {
                message:
                  "experiment.bucket() received a null/undefined value; " +
                  'hashing empty string "" for variant selection',
              },
            );
          }
        }

        return result;
      },
    );

    // Look up and execute the selected variant's callback at the top level
    // so its step.* calls go through normal step discovery.
    const variantFn = variants[selectedVariant];

    if (!variantFn) {
      throw new Error(
        `group.experiment("${stepOpts.id}"): variant "${selectedVariant}" ` +
          `was selected but is not defined. Available variants: ${variantNames.join(", ")}`,
      );
    }

    // Propagate experiment context via ALS so variant sub-steps include
    // experiment fields in their OutgoingOp.opts. Also track whether any
    // step tool is invoked to detect zero-step variants.
    const currentCtx = getAsyncCtxSync();
    const stepTracker = { found: false };
    let result: unknown;

    if (currentCtx?.execution && experimentStepHashedId && !isALSFallback()) {
      const als = await getAsyncLocalStorage();
      const nestedCtx: AsyncContext = {
        ...currentCtx,
        execution: {
          ...currentCtx.execution,
          experimentContext: {
            experimentStepID: experimentStepHashedId,
            experimentName: stepOpts.id,
            variant: selectedVariant,
          },
          experimentStepTracker: stepTracker,
        },
      };
      result = await als.run(nestedCtx, () => variantFn());
    } else {
      result = await variantFn();
    }

    // If the variant returned without invoking any step tools, it will
    // silently re-execute on every replay. Throw a non-retriable error
    // to prevent this.
    if (!stepTracker.found && !isALSFallback()) {
      throw new NonRetriableError(
        `group.experiment("${stepOpts.id}"): variant "${selectedVariant}" ` +
          "did not invoke any step tools. Wrap your variant logic in " +
          "step.run() to ensure it is memoized and not re-executed on replay.",
      );
    }

    if (withVariant) {
      return { result, variant: selectedVariant };
    }

    return result;
  }) as GroupExperiment;

  return { parallel, experiment };
};
