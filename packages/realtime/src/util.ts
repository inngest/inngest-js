type DeferredPromiseReturn<T> = {
  promise: Promise<T>;
  resolve: (value: T) => DeferredPromiseReturn<T>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
