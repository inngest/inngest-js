import { type Await } from "./types";
import { prettyError } from "./errors";
import { fnDataSchema, type FnData, type Result, Ok, Err } from "../types";
import { type InngestAPI } from "../api/api";

/**
 * Wraps a function with a cache. When the returned function is run, it will
 * cache the result and return it on subsequent calls.
 */
export const cacheFn = <T extends (...args: unknown[]) => unknown>(
  fn: T
): T => {
  const key = "value";
  const cache = new Map<typeof key, unknown>();

  return ((...args) => {
    if (!cache.has(key)) {
      cache.set(key, fn(...args));
    }

    return cache.get(key);
  }) as T;
};

/**
 * Given an array of functions, return a new function that will run each
 * function in series and return the result of the final function. Regardless of
 * if the functions are synchronous or asynchronous, they'll be made into an
 * async promise chain.
 *
 * If an error is thrown, the waterfall will stop and return the error.
 *
 * Because this needs to support both sync and async functions, it only allows
 * functions that accept a single argument.
 *
 * TODO Add a second function that decides how to merge results from prev and current results.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const waterfall = <TFns extends ((arg?: any) => any)[]>(
  fns: TFns,

  /**
   * A function that transforms the result of each function in the waterfall,
   * ready for the next function.
   *
   * Will not be called on the final function.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transform?: (prev: any, output: any) => any
): ((...args: Parameters<TFns[number]>) => Promise<Await<TFns[number]>>) => {
  return (...args) => {
    const chain = fns.reduce(async (acc, fn) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const prev = await acc;
      const output = (await fn(prev)) as Promise<Await<TFns[number]>>;

      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return transform ? await transform(prev, output) : output;
    }, Promise.resolve(args[0]));

    return chain;
  };
};

type ParseErr = string;
export const parseFnData = async (
  data: unknown,
  api: InngestAPI
): Promise<Result<FnData, ParseErr>> => {
  try {
    const result = fnDataSchema.parse(data);

    if (result.use_api) {
      if (!result.ctx?.run_id) {
        return Err(
          prettyError({
            whatHappened: "failed to attempt retrieving data from API",
            consequences: "function execution can't continue",
            why: "run_id is missing from context",
            stack: true,
          })
        );
      }

      const [evtResp, stepResp] = await Promise.all([
        api.getRunBatch(result.ctx.run_id),
        api.getRunSteps(result.ctx.run_id),
      ]);

      if (evtResp.ok) {
        result.events = evtResp.value;
      } else {
        return Err(
          prettyError({
            whatHappened: "failed to retrieve list of events",
            consequences: "function execution can't continue",
            why: evtResp.error?.error,
            stack: true,
          })
        );
      }

      if (stepResp.ok) {
        result.steps = stepResp.value;
      } else {
        return Err(
          prettyError({
            whatHappened: "failed to retrieve steps for function run",
            consequences: "function execution can't continue",
            why: stepResp.error?.error,
            stack: true,
          })
        );
      }
    }

    return Ok(result);
  } catch (err) {
    // print it out for now.
    // move to something like protobuf so we don't have to deal with this
    console.error(err);

    return Err(
      prettyError({
        whatHappened: "failed to parse data from executor",
        consequences: "function execution can't continue",
        stack: true,
      })
    );
  }
};
