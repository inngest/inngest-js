import type { MaybePromise } from "./types.ts";

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
export const resolveAfterPending = (count = 100): Promise<void> => {
  /**
   * This uses a brute force implementation that will continue to enqueue
   * microtasks 10 times before resolving. This is to ensure that the microtask
   * queue is drained, even if the microtask queue is being manipulated by other
   * code.
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
        if (i++ > count) {
          return resolve();
        }

        iterate();
      });
    };

    iterate();
  });
};

type DeferredPromiseReturn<T> = {
  promise: Promise<T>;
  resolve: (value: T) => DeferredPromiseReturn<T>;
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  reject: (reason: any) => DeferredPromiseReturn<T>;
};

/**
 * Creates and returns Promise that can be resolved or rejected with the
 * returned `resolve` and `reject` functions.
 *
 * Resolving or rejecting the function will return a new set of Promise control
 * functions. These can be ignored if the original Promise is all that's needed.
 */
export const createDeferredPromise = <T>(): DeferredPromiseReturn<T> => {
  let resolve: DeferredPromiseReturn<T>["resolve"];
  let reject: DeferredPromiseReturn<T>["reject"];

  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = (value: T) => {
      _resolve(value);
      return createDeferredPromise<T>();
    };

    reject = (reason) => {
      _reject(reason);
      return createDeferredPromise<T>();
    };
  });

  return { promise, resolve: resolve!, reject: reject! };
};

/**
 * Creates and returns a deferred Promise that can be resolved or rejected with
 * the returned `resolve` and `reject` functions.
 *
 * For each Promise resolved or rejected this way, this will also keep a stack
 * of all unhandled Promises, resolved or rejected.
 *
 * Once a Promise is read, it is removed from the stack.
 */
export const createDeferredPromiseWithStack = <T>(): {
  deferred: DeferredPromiseReturn<T>;
  results: AsyncGenerator<Awaited<T>, void, void>;
} => {
  const settledPromises: Promise<T>[] = [];
  // biome-ignore lint/suspicious/noConfusingVoidType: <explanation>
  let rotateQueue: (value: void) => void = () => {};

  const results = (async function* () {
    while (true) {
      const next = settledPromises.shift();

      if (next) {
        yield next;
      } else {
        await new Promise<void>((resolve) => {
          rotateQueue = resolve;
        });
      }
    }
  })();

  const shimDeferredPromise = (deferred: DeferredPromiseReturn<T>) => {
    const originalResolve = deferred.resolve;
    const originalReject = deferred.reject;

    deferred.resolve = (value: T) => {
      settledPromises.push(deferred.promise);
      rotateQueue();
      return shimDeferredPromise(originalResolve(value));
    };

    deferred.reject = (reason) => {
      settledPromises.push(deferred.promise);
      rotateQueue();
      return shimDeferredPromise(originalReject(reason));
    };

    return deferred;
  };

  const deferred = shimDeferredPromise(createDeferredPromise<T>());

  return { deferred, results };
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
  // biome-ignore lint/style/useConst: <explanation>
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

/**
 * Take any function and safely promisify such that both synchronous and
 * asynchronous errors are caught and returned as a rejected Promise.
 *
 * The passed `fn` can be undefined to support functions that may conditionally
 * be defined.
 */
// biome-ignore lint/suspicious/noExplicitAny: <explanation>
export const runAsPromise = <T extends (() => any) | undefined>(
  fn: T,
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
): Promise<T extends () => any ? Awaited<ReturnType<T>> : T> => {
  return Promise.resolve().then(fn);
};

/**
 * Returns a Promise that resolve after the current event loop tick.
 */
export const resolveNextTick = (): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve));
};

export const retryWithBackoff = async <T>(
  fn: () => MaybePromise<T>,
  opts?: {
    maxAttempts?: number;
    baseDelay?: number;
  },
): Promise<T> => {
  const maxAttempts = opts?.maxAttempts || 5;
  const baseDelay = opts?.baseDelay ?? 100;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts) {
        throw err;
      }

      const jitter = Math.random() * baseDelay;
      const delay = baseDelay * Math.pow(2, attempt - 1) + jitter;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error("Max retries reached; this should be unreachable.");
};
