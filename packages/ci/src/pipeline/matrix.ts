/**
 * Matrix jobs: `ci.matrix()`, expanding axes into combinations, and running
 * them with an optional concurrency limit.
 *
 * @module
 */

import type { Matrix, MatrixCombo, MatrixConfig } from "../types.ts";
import type { Ci } from "./createCi.ts";

/**
 * Expand a matrix into its combinations and run them as jobs.
 */
export const createMatrix = <
  TAxes extends Record<string, readonly unknown[]>,
  TResult,
>(
  ci: Ci,
  config: MatrixConfig<TAxes>,
  handler: (combo: MatrixCombo<TAxes>) => Promise<TResult>,
): Matrix<TAxes, TResult> => {
  const matrix = (async (only?: Partial<MatrixCombo<TAxes>>) => {
    const combos = expandMatrix(config).filter((combo) =>
      only
        ? Object.entries(only).every(
            ([key, value]) => combo[key as keyof MatrixCombo<TAxes>] === value,
          )
        : true,
    );

    const tasks = combos.map((combo) => async () => {
      const machine =
        typeof config.machine === "function"
          ? config.machine(combo)
          : config.machine;
      const cache =
        typeof config.cache === "function" ? config.cache(combo) : config.cache;

      const job = ci.job<TResult>(
        {
          id: matrixJobId(config.id, combo),
          ...(machine ? { machine } : {}),
          ...(cache ? { cache } : {}),
          ...(config.check === undefined ? {} : { check: config.check }),
        },
        () => handler(combo),
      );

      return job();
    });

    return runPool(tasks, config.concurrency, config.failFast ?? false);
  }) as Matrix<TAxes, TResult>;

  Object.defineProperty(matrix, "id", { value: config.id, enumerable: true });

  return matrix;
};

export const matrixJobId = (
  id: string,
  combo: Record<string, unknown>,
): string =>
  `${id} (${Object.entries(combo)
    .map(([key, value]) => `${key}:${String(value)}`)
    .join(", ")})`;

/**
 * Every combination of the axes, in declaration order, with `exclude` removed
 * and `include` appended.
 */
export const expandMatrix = <TAxes extends Record<string, readonly unknown[]>>(
  config: MatrixConfig<TAxes>,
): MatrixCombo<TAxes>[] => {
  const keys = Object.keys(config.axes);

  let combos: Record<string, unknown>[] = [{}];

  for (const key of keys) {
    const values = config.axes[key] ?? [];
    combos = combos.flatMap((combo) =>
      values.map((value) => ({ ...combo, [key]: value })),
    );
  }

  const excluded = combos.filter(
    (combo) =>
      !(config.exclude ?? []).some((exclusion) =>
        Object.entries(exclusion).every(([key, value]) => combo[key] === value),
      ),
  );

  return [
    ...excluded,
    ...((config.include ?? []) as Record<string, unknown>[]),
  ] as MatrixCombo<TAxes>[];
};

/**
 * Run tasks with an optional in-flight limit.
 *
 * With `failFast` off, everything runs and the failures are thrown together,
 * so one bad combination doesn't hide the rest. With it on, the first failure
 * rejects; the others keep running and their results are ignored.
 */
export const runPool = async <T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number | undefined,
  failFast: boolean,
): Promise<T[]> => {
  const limit = concurrency && concurrency > 0 ? concurrency : tasks.length;
  const results: T[] = new Array(tasks.length);
  const errors: unknown[] = [];
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next++;
      const task = tasks[index];
      if (!task) {
        continue;
      }

      try {
        results[index] = await task();
      } catch (error) {
        if (failFast) {
          throw error;
        }
        errors.push(error);
      }
    }
  };

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () =>
    worker(),
  );

  await Promise.all(workers);

  if (errors.length > 0) {
    throw new AggregateError(errors, `${errors.length} job(s) failed`);
  }

  return results;
};
