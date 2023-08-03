/**
 * Some environments don't allow access to the global queueMicrotask(). While we
 * had assumed this was only true for those powered by earlier versions of Node
 * (<14) that we don't officially support, Vercel's Edge Functions also obscure
 * the function in dev, even though the platform it's based on (Cloudflare
 * Workers) appropriately exposes it. Even worse, production Vercel Edge
 * Functions can see the function, but it immediately blows up the function when
 * used.
 *
 * Therefore, we can fall back to a reasonable alternative of
 * `Promise.resolve().then(fn)` instead. This _may_ be slightly slower in modern
 * environments, but at least we can still work in these environments.
 */
const shimQueueMicrotask = (callback: () => void): void => {
  void Promise.resolve().then(callback);
};

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
      shimQueueMicrotask(() => {
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

type DeferredPromiseReturn<T> = {
  promise: Promise<T>;
  resolve: (value: T) => DeferredPromiseReturn<T>;
};

/**
 * Creates and returns Promise that can be resolved with the returned resolve
 * function.
 *
 * Resolving the function will return a new set of Promise and resolve function.
 * These can be ignored if the original Promise is all that's needed.
 */
export const createDeferredPromise = <T>(): DeferredPromiseReturn<T> => {
  let resolve: (value: T) => DeferredPromiseReturn<T>;

  const promise = new Promise<T>((_resolve) => {
    resolve = (value: T) => {
      _resolve(value);
      return createDeferredPromise<T>();
    };
  });

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return { promise, resolve: resolve! };
};

interface TimeoutPromise extends Promise<void> {
  /**
   * Starts the timeout. If the timer is already started, this does nothing.
   *
   * @returns The promise that will resolve when the timeout expires.
   */
  start: () => TimeoutPromise;

  /**
   * Clears the timeout.
   */
  clear: () => void;

  /**
   * Clears the timeout and starts it again.
   *
   * @returns The promise that will resolve when the timeout expires.
   */
  reset: () => TimeoutPromise;
}

/**
 * Creates a Promise that will resolve after the given duration, along with
 * methods to start, clear, and reset the timeout.
 */
export const createTimeoutPromise = (duration: number): TimeoutPromise => {
  const { promise, resolve } = createDeferredPromise<void>();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let ret: TimeoutPromise;

  const start = () => {
    if (timeout) return ret;

    timeout = setTimeout(() => {
      resolve();
    }, duration);

    return ret;
  };

  const clear = () => {
    clearTimeout(timeout);
    timeout = undefined;
  };

  const reset = () => {
    clear();
    return start();
  };

  ret = Object.assign(promise, { start, clear, reset });

  return ret;
};
