/**
 * @module
 * EXPERIMENTAL: a counter per execution of a function, so repeated calls such
 * as `agent.invoke()` and `thread.request()` can tell themselves apart.
 */

const counters = new WeakMap<object, Map<string, number>>();

/**
 * Counts the calls of one kind in one execution of a function, starting at 0.
 * An execution runs its function code in the same order every time and the
 * count starts again on every replay, so a replay counts the same.
 */
export const nextCount = (
  /**
   * The execution (`execution.instance`).
   */
  instance: object,
  /**
   * What is counted. Kinds count separately.
   */
  kind: string,
): number => {
  const byKind = counters.get(instance) ?? new Map<string, number>();
  const n = byKind.get(kind) ?? 0;

  byKind.set(kind, n + 1);
  counters.set(instance, byKind);

  return n;
};
