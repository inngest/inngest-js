/**
 * @module
 * EXPERIMENTAL: the runs an agent's run started with `start_agent` and that are
 * still open. A run opened through a handle does not end while any is open: their
 * `agent/finished` messages fold in, and the answer after the last one is the
 * run's output. Code that calls `start()` handles its children itself, so
 * `start()` never lands here.
 *
 * The set is rebuilt on every replay from what the run does again: each
 * `start_agent` call tracks its child, and each `agent/finished` the inbox
 * delivers settles one.
 */

/**
 * How long a run waits for its children after nothing else is left, in
 * milliseconds: 24 hours, so a lost `agent/finished` cannot hold a run for
 * ever. Internal: a test shortens it; it is not public API.
 */
export const childWait = { ms: 24 * 60 * 60 * 1000 };

const open = new WeakMap<object, Set<string>>();

/**
 * Notes a child run started with `start_agent`.
 * @param instance The running execution.
 * @param key The child thread's key.
 */
export const trackChild = (instance: object, key: string): void => {
  const keys = open.get(instance) ?? new Set<string>();

  keys.add(key);
  open.set(instance, keys);
};

/**
 * Notes that a child's `agent/finished` was delivered.
 * @param instance The running execution.
 * @param key The child thread's key.
 */
export const settleChild = (instance: object, key: string): void => {
  open.get(instance)?.delete(key);
};

/**
 * The children still open.
 * @param instance The running execution.
 */
export const openChildren = (instance: object): string[] => {
  return [...(open.get(instance) ?? [])];
};
