import hashjs from "hash.js";
import { getAsyncCtxSync } from "./execution/als.ts";
import type { ExperimentSelectFn } from "./InngestGroupTools.ts";

const { sha256 } = hashjs;

/**
 * Hash a string to a float in [0, 1) using SHA-256.
 */
const hashToFloat = (str: string): number => {
  const hex = sha256().update(str).digest("hex").slice(0, 8);
  return Number.parseInt(hex, 16) / 0x100000000;
};

/**
 * Given a float in [0, 1) and a weights map, select the variant whose bucket
 * the float falls into. Entries are sorted alphabetically for determinism.
 */
const selectByWeight = (
  hash01: number,
  weights: Record<string, number>,
): string => {
  const entries = Object.entries(weights).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const total = entries.reduce((sum, [, w]) => sum + w, 0);

  let cursor = 0;
  for (const [name, weight] of entries) {
    cursor += weight / total;
    if (hash01 < cursor) {
      return name;
    }
  }

  // Fallback to last entry (floating-point edge case)
  return entries[entries.length - 1]![0]!;
};

/**
 * Build equal weights from variant names: `{ a: 1, b: 1, ... }`.
 */
const equalWeights = (variantNames: string[]): Record<string, number> => {
  return Object.fromEntries(variantNames.map((name) => [name, 1]));
};

/**
 * Throw if all weights are zero.
 */
const validateWeights = (weights: Record<string, number>): void => {
  const total = Object.values(weights).reduce((sum, w) => sum + w, 0);
  if (total <= 0) {
    throw new Error(
      "experiment.weighted(): all weights are zero; at least one weight must be positive",
    );
  }
};

/**
 * Attach `__experimentConfig` to a select function, producing an
 * `ExperimentSelectFn`.
 */
const createSelectFn = (
  fn: (variantNames?: string[]) => Promise<string> | string,
  config: ExperimentSelectFn["__experimentConfig"],
): ExperimentSelectFn => {
  return Object.assign(fn, { __experimentConfig: config });
};

/**
 * Factory functions for creating experiment selection strategies.
 *
 * Each factory returns an `ExperimentSelectFn` — a callable function with an
 * `__experimentConfig` property carrying strategy metadata.
 *
 * @example
 * ```ts
 * import { experiment, group, step } from "inngest";
 *
 * const result = await group.experiment("checkout-flow", {
 *   variants: {
 *     control: () => step.run("old", () => oldCheckout()),
 *     new_flow: () => step.run("new", () => newCheckout()),
 *   },
 *   select: experiment.weighted({ control: 80, new_flow: 20 }),
 * });
 * ```
 *
 * @public
 */
export const experiment = {
  /**
   * Always selects the specified variant.
   *
   * @example
   * ```ts
   * select: experiment.fixed("control")
   * ```
   */
  fixed(variantName: string): ExperimentSelectFn {
    return createSelectFn(() => variantName, { strategy: "fixed" });
  },

  /**
   * Weighted random selection, seeded with the current run ID for
   * determinism — the same run always gets the same variant.
   *
   * @example
   * ```ts
   * select: experiment.weighted({ gpt4: 50, claude: 50 })
   * ```
   *
   * @throws If all weights are zero (validated at creation time).
   */
  weighted(weights: Record<string, number>): ExperimentSelectFn {
    validateWeights(weights);

    return createSelectFn(
      () => {
        const runId =
          getAsyncCtxSync()?.execution?.ctx.runId ?? crypto.randomUUID();
        return selectByWeight(hashToFloat(runId), weights);
      },
      { strategy: "weighted", weights },
    );
  },

  /**
   * Consistent hashing — the same value always maps to the same variant.
   *
   * When `value` is `null` or `undefined`, an empty string is hashed instead.
   *
   * @example
   * ```ts
   * select: experiment.bucket(userId)
   * select: experiment.bucket(userId, { weights: { a: 70, b: 30 } })
   * ```
   */
  bucket(
    value: unknown,
    options?: { weights?: Record<string, number> },
  ): ExperimentSelectFn {
    if (options?.weights) {
      validateWeights(options.weights);
    }

    const str = value == null ? "" : String(value);

    return createSelectFn(
      (variantNames?: string[]) => {
        const weights =
          options?.weights ??
          (variantNames ? equalWeights(variantNames) : undefined);

        if (!weights) {
          throw new Error(
            "experiment.bucket() requires either explicit weights or variant " +
              "names from group.experiment()",
          );
        }

        return selectByWeight(hashToFloat(str), weights);
      },
      { strategy: "bucket", weights: options?.weights },
    );
  },

  /**
   * User-provided selection function. The function is called inside the
   * memoized step, so it only runs once per run.
   *
   * @example
   * ```ts
   * select: experiment.custom(async () => {
   *   const flag = await getFeatureFlag("checkout-variant");
   *   return flag;
   * })
   * ```
   */
  custom(fn: () => Promise<string> | string): ExperimentSelectFn {
    return createSelectFn(fn, { strategy: "custom" });
  },
};
