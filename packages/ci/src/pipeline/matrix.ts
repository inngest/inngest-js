/**
 * Matrix jobs: `ci.matrix()`, expanding axes into combinations, and running
 * them with an optional concurrency limit.
 *
 * @module
 */

import type { Matrix, MatrixCombo, MatrixConfig, JobConfig } from "../types.ts";
import type { Ci } from "./createCi.ts";
import { countApi } from "./scope.ts";

/**
 * Expand a matrix into its combinations and run them as jobs.
 */
export const createMatrix = <TAxes extends Record<string, readonly unknown[]>>(
  ci: Ci,
  config: MatrixConfig<TAxes>,
  handler: (combo: MatrixCombo<TAxes>) => Promise<void>,
): Matrix<TAxes> => {
  const matrix = (async (only?: Partial<MatrixCombo<TAxes>>) => {
    countApi("matrix");

    const combos = expandMatrix(config).filter((combo) => {
      return only
        ? Object.entries(only).every(([key, value]) => {
            return combo[key as keyof MatrixCombo<TAxes>] === value;
          })
        : true;
    });

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

        const from: JobConfig["from"] =
          typeof config.from === "function" && !("kind" in config.from)
            ? config.from({ input: combo })
            : (config.from as JobConfig["from"]);

        const job = ci.job<void>(
          {
            id: matrixJobId(config.id, combo),
            ...(from ? { from } : {}),
            ...(machine ? { machine } : {}),
            ...(cache ? { cache } : {}),
            ...(config.check === undefined ? {} : { check: config.check }),
          },
          () => {
            return handler(combo);
          },
        );

        await job();
      };
    });

    await runPool(tasks, config.concurrency, config.failFast ?? false);
  }) as Matrix<TAxes>;

  Object.defineProperty(matrix, "id", { value: config.id, enumerable: true });

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
 * and their outcomes are ignored.
 */
export const runPool = async (
  tasks: Array<() => Promise<void>>,
  concurrency: number | undefined,
  failFast: boolean,
): Promise<void> => {
  const limit = concurrency && concurrency > 0 ? concurrency : tasks.length;
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
        await task();
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
};
