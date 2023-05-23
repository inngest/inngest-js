import { type Await } from "./types";

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
export const waterfall = <TFns extends ((arg: any) => any)[]>(
  fns: TFns
): ((
  ...args: Parameters<TFns[number]>["length"] extends 0
    ? []
    : Parameters<TFns[number]>[0]
) => Promise<Await<TFns[number]>>) => {
  return (...args) => {
    const chain = fns.reduce(async (acc, fn) => {
      return fn(await acc) as Promise<Await<TFns[number]>>;
    }, Promise.resolve(args[0]));

    return chain;
  };
};
