/**
 * Matrix jobs: a `ci.job()` with a `matrix`, expanding its axes into combinations,
 * and running them with an optional limit on how many run at once.
 *
 * @module
 */

import { NonRetriableError } from "inngest";
import { checkCache } from "../cache/cache.ts";
import { CiUsageError } from "../errors.ts";
import type { CheckReporter } from "../github/checks.ts";
import { checkStaticFrom } from "../machine/from.ts";
import type {
  JobConfig,
  MatrixJob,
  MatrixAxes,
  MatrixCombo,
  MatrixJobConfig,
  MatrixOptions,
  MatrixContext,
} from "../types.ts";
import type { Ci } from "./createCi.ts";
import type { RegisteredJob } from "./job.ts";
import { ciRun } from "./metadata.ts";
import { steps } from "./names.ts";
import {
  countApi,
  getRunScope,
  inlineKey,
  matrixOriginKey,
  requireRunScope,
  rootRunIdOf,
} from "./scope.ts";

/**
 * Where a matrix keeps the function that runs exactly the combinations it's
 * given, which is how a build runs the one combination it was asked for.
 */
export const runCombosKey = Symbol("inngest/ci.matrixCombos");

/**
 * A string that is the same for equal values however they were built, with
 * object keys in sorted order. A combination that went through an invoke has
 * the same values as the original, but never the same object references.
 */
const stableKey = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableKey).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => {
        return `${JSON.stringify(key)}:${stableKey((value as Record<string, unknown>)[key])}`;
      })
      .join(",")}}`;
  }

  return JSON.stringify(value) ?? "undefined";
};

/** Whether two combinations have the same axes and values. */
export const sameCombo = (
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean => {
  return stableKey(a) === stableKey(b);
};

/**
 * Expand a job's matrix into its combinations and run them as jobs.
 */
export const createMatrix = <TAxes extends MatrixAxes>({
  ci,
  jobs,
  config,
  handler,
}: {
  ci: Ci;
  /** The client's job registry, which a static `from` is checked against. */
  jobs: Map<string, RegisteredJob>;
  config: MatrixJobConfig<TAxes>;
  handler: (ctx: MatrixContext<TAxes>) => Promise<void>;
}): MatrixJob<TAxes> => {
  // A matrix made inside a run is gone with it, and so are its combinations.
  const inline = Boolean(getRunScope());

  checkStaticFrom(jobs, config);

  const options = config.matrix;

  const given = options.axes;

  if (typeof given !== "function") {
    checkAxes(config.id, given);
  }

  /**
   * The axes to expand: the given ones, or what the `matrix` function made of
   * them, which is the same for every combination of the run.
   */
  /** Checked outside the step, so a bad result isn't retried as a step error. */
  const checkedAxes = (axes: MatrixAxes): MatrixAxes => {
    checkAxes(config.id, axes);

    return axes;
  };

  const axesOf = (): Promise<TAxes> | TAxes => {
    if (typeof given !== "function") {
      return given;
    }

    const run = requireRunScope("matrix");
    const resolved = run.matrixAxes.get(config.id);

    if (resolved) {
      return resolved.then(checkedAxes) as Promise<TAxes>;
    }

    const made = ciRun(run, steps.matrixAxes(config.id), async () => {
      return given({
        repo: run.repo,
        run: { id: rootRunIdOf(run) },
      });
    });

    run.matrixAxes.set(config.id, made);

    return made.then(checkedAxes) as Promise<TAxes>;
  };

  if (typeof config.cache !== "function") {
    checkCache(config.id, config.cache);
  }

  const run = async (combos: MatrixCombo<TAxes>[]): Promise<void> => {
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

        // A function of the combination runs inside the combination's own
        // job, like any job's `from`, so if it throws, that job fails with
        // its own check.
        const pick = config.from;

        const from: JobConfig["from"] =
          typeof pick === "function" && !("kind" in pick)
            ? () => {
                return pick({ input: combo });
              }
            : (pick as JobConfig["from"]);

        const job = ci.job(
          {
            id: matrixJobId(config.id, combo),
            ...(from ? { from } : {}),
            ...(machine ? { machine } : {}),
            ...(cache ? { cache } : {}),
            ...(config.check === undefined ? {} : { check: config.check }),
            [matrixOriginKey]: { id: config.id, combo },
            [inlineKey]: inline,
          } as JobConfig,
          (ctx) => {
            return handler({
              ...ctx,
              matrix: combo,
            } as unknown as MatrixContext<TAxes>);
          },
        );

        await job();
      };
    });

    // Every combination shows as queued now, not once the pool reaches it.
    if (config.check !== false) {
      const checks = requireRunScope("matrix").ci.checks as CheckReporter;

      const name = config.check ? config.check.name : undefined;
      const scope = requireRunScope("matrix");

      await Promise.all(
        combos.map((combo) => {
          const jobPath = matrixJobId(config.id, combo);

          scope.openChecks.set(jobPath, name);

          return checks.jobQueued({
            run: scope,
            jobPath,
            ...(name ? { name } : {}),
          });
        }),
      );
    }

    await runPool(tasks, options.concurrency, options.failFast ?? false);
  };

  const matrix = ((only?: Partial<MatrixCombo<TAxes>>) => {
    return (async () => {
      const combos = expandMatrix(options, await axesOf());

      return run(
        combos.filter((combo) => {
          return only
            ? Object.entries(only).every(([key, value]) => {
                return combo[key as keyof MatrixCombo<TAxes>] === value;
              })
            : true;
        }),
      );
    })();
  }) as MatrixJob<TAxes>;

  Object.defineProperties(matrix, {
    id: { value: config.id, enumerable: true },
    [runCombosKey]: {
      value: async (combos: Record<string, unknown>[]) => {
        // The combinations come from the run that resolved the axes, so a
        // function is not called again.
        if (typeof given === "function") {
          return run(combos as MatrixCombo<TAxes>[]);
        }

        const matching = expandMatrix(options, given).filter((combo) => {
          return combos.some((wanted) => {
            return sameCombo(wanted, combo);
          });
        });

        if (matching.length === 0) {
          throw new NonRetriableError(
            `No combination of the matrix "${config.id}" matches the one asked for, so nothing would run. The worker's code may be out of date.`,
          );
        }

        return run(matching);
      },
    },
  });

  return matrix;
};

/** Fail an axis with no values, since a matrix over it would run nothing. */
const checkAxes = (id: string, axes: MatrixAxes): void => {
  for (const [axis, values] of Object.entries(axes)) {
    if (values.length === 0) {
      throw new CiUsageError(
        `The \`${axis}\` axis of matrix "${id}" has no values.`,
      );
    }
  }
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
export const expandMatrix = <TAxes extends MatrixAxes>(
  config: Pick<MatrixOptions<TAxes>, "exclude" | "include">,
  axes: TAxes,
): MatrixCombo<TAxes>[] => {
  const keys = Object.keys(axes);

  let combos: Record<string, unknown>[] = [{}];

  for (const key of keys) {
    const values = axes[key] ?? [];

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
