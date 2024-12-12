import { type Context } from "../../types.js";

export interface AsyncContext {
  ctx: Context.Any;
}

/**
 * A type that represents a partial, runtime-agnostic interface of
 * `AsyncLocalStorage`.
 */
type AsyncLocalStorageIsh = {
  getStore: () => AsyncContext | undefined;
  run: <R>(store: AsyncContext, fn: () => R) => R;
};

/**
 * A local-only variable to store the async local storage instance.
 */
let als: Promise<AsyncLocalStorageIsh> | undefined;

/**
 * Retrieve the async context for the current execution.
 */
export const getAsyncCtx = async (): Promise<AsyncContext | undefined> => {
  return getAsyncLocalStorage().then((als) => als.getStore());
};

/**
 * Get a singleton instance of `AsyncLocalStorage` used to store and retrieve
 * async context for the current execution.
 */
export const getAsyncLocalStorage = async (): Promise<AsyncLocalStorageIsh> => {
  // eslint-disable-next-line @typescript-eslint/no-misused-promises, no-async-promise-executor
  als ??= new Promise<AsyncLocalStorageIsh>(async (resolve) => {
    try {
      const { AsyncLocalStorage } = await import("node:async_hooks");

      resolve(new AsyncLocalStorage<AsyncContext>());
    } catch (err) {
      console.warn(
        "node:async_hooks is not supported in this runtime. Experimental async context is disabled."
      );

      resolve({
        getStore: () => undefined,
        run: (_, fn) => fn(),
      });
    }
  });

  return als;
};
