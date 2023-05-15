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
