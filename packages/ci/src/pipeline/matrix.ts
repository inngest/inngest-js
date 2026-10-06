/**
 * Matrix jobs: `ci.matrix()`, expanding axes into combinations, and running
 * them with an optional concurrency limit.
 *
 * @module
 */

import type { JobConfig, Matrix, MatrixCombo, MatrixConfig } from "../types.ts";
import type { Ci } from "./createCi.ts";
import { countApi, matrixOriginKey } from "./scope.ts";

/**
 * Where a matrix keeps the function that runs exactly the combinations it's
 * given, which is how the CLI runs a hand-picked set.
 */
export const runCombosKey = Symbol("inngest/ci.matrixCombos");

/** Whether two combinations have the same axes and values. */
const sameCombo = (
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean => {
  const keys = Object.keys(a);

  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => {
      return a[key] === b[key];
    })
  );
};

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
  const run = async (combos: MatrixCombo<TAxes>[]): Promise<TResult[]> => {
    countApi("matrix");

    const tasks = combos.map((combo) => {
      return async () => {
        const machine =
          typeof config.machine === "function"
            ? config.machine(combo)
            : config.machine;

        const cache =
          typeof config.cache === "function"
            ? config.cache(combo)
            : config.cache;

        const job = ci.job<TResult>(
          {
            id: matrixJobId(config.id, combo),
            ...(machine ? { machine } : {}),
            ...(cache ? { cache } : {}),
            ...(config.check === undefined ? {} : { check: config.check }),
            [matrixOriginKey]: { id: config.id, combo },
          } as JobConfig,
          () => {
            return handler(combo);
          },
        );

        return job();
      };
    });

    return runPool(tasks, config.concurrency, config.failFast ?? false);
  };

  const matrix = ((only?: Partial<MatrixCombo<TAxes>>) => {
    return run(
      expandMatrix(config).filter((combo) => {
        return only
          ? Object.entries(only).every(([key, value]) => {
              return combo[key as keyof MatrixCombo<TAxes>] === value;
            })
          : true;
      }),
    );
  }) as Matrix<TAxes, TResult>;

  Object.defineProperties(matrix, {
    id: { value: config.id, enumerable: true },
    [runCombosKey]: {
      value: (combos: Record<string, unknown>[]) => {
        return run(
          expandMatrix(config).filter((combo) => {
            return combos.some((wanted) => {
              return sameCombo(wanted, combo);
            });
          }),
        );
      },
    },
  });

  return matrix;
};

export const matrixJobId = (
  id: string,
  combo: Record<string, unknown>,
): string => {
  return `${id} (${Object.entries(combo)
    .map(([key, value]) => {
      return `${key}:${String(value)}`;
    })
    .join(", ")})`;
};

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

    combos = combos.flatMap((combo) => {
      return values.map((value) => {
        return { ...combo, [key]: value };
      });
    });
  }

  const excluded = combos.filter((combo) => {
    return !(config.exclude ?? []).some((exclusion) => {
      return Object.entries(exclusion).every(([key, value]) => {
        return combo[key] === value;
      });
    });
  });

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
 * rejects and no queued combination starts; the ones already running finish
 * and their results are ignored.
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
  let stopped = false;

  const worker = async (): Promise<void> => {
    while (!stopped && next < tasks.length) {
      const index = next++;
      const task = tasks[index];

      if (!task) {
        continue;
      }

      try {
        results[index] = await task();
      } catch (error) {
        if (failFast) {
          stopped = true;

          throw error;
        }

        errors.push(error);
      }
    }
  };

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => {
    return worker();
  });

  await Promise.all(workers);

  if (errors.length > 0) {
    throw new AggregateError(errors, `${errors.length} job(s) failed`);
  }

  return results;
};
