/**
 * A helper function to create a `Promise` that will never settle.
 *
 * It purposefully creates no references to `resolve` or `reject` so that the
 * returned `Promise` will remain unsettled until it falls out of scope and is
 * garbage collected.
 *
 * This should be used within transient closures to fake asynchronous action, so
 * long as it's guaranteed that they will fall out of scope.
 */
export const createFrozenPromise = (): Promise<unknown> => {
  return new Promise(() => undefined);
};

/**
 * Returns a Promise that resolves after the current event loop's microtasks
 * have finished, but before the next event loop tick.
 */
export const resolveAfterPending = (): Promise<void> => {
  return new Promise((resolve) =>
    /**
     * Testing found that enqueuing a single microtask would sometimes result in
     * the Promise being resolved before the microtask queue was drained.
     *
     * Double enqueueing does not guarantee that the queue will be empty (e.g.
     * if a microtask enqueues another microtask as this does), but this does
     * ensure that step tooling that pushes to this stack intentionally will be
     * correctly detected and supported.
     */
    queueMicrotask(() => queueMicrotask(() => resolve()))
  );
};

/**
 * Returns a Promise that resolve after the current event loop tick.
 */
export const resolveNextTick = (): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve));
};
