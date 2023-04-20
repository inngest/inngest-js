/**
 * Some environments don't allow access to the global queueMicrotask(). While we
 * had assumed this was only true for those powered by earlier versions of Node
 * (<14) that we don't officially support, Vercel's Edge Functions also obscure
 * the function, even though the platform it's based on (Cloudflare Workers)
 * appropriately exposes it.
 *
 * Therefore, we can fall back to a reasonable alternative of
 * `Promise.resolve().then(fn)` instead. This will be slightly slower, but at
 * least we can still work in these environments.
 *
 * This package does exactly that, enabling us to use `queueMicrotask()` in all
 * modern JS engines.
 *
 * See {@link https://www.npmjs.com/package/queue-microtask}.
 */
import queueMicrotask from "queue-microtask";

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
  /**
   * This uses a brute force implementation that will continue to enqueue
   * microtasks 1000 times before resolving. This is to ensure that the
   * microtask queue is drained, even if the microtask queue is being
   * manipulated by other code.
   *
   * While this still doesn't guarantee that the microtask queue is drained,
   * it's our best bet for giving other non-controlled promises a chance to
   * resolve before we continue without resorting to falling in to the next
   * tick.
   */
  return new Promise((resolve) => {
    let i = 0;

    const iterate = () => {
      queueMicrotask(() => {
        if (i++ > 1000) {
          return resolve();
        }

        iterate();
      });
    };

    iterate();
  });
};

/**
 * Returns a Promise that resolve after the current event loop tick.
 */
export const resolveNextTick = (): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve));
};
