import type { Context, StepOptions } from "../../types.ts";
import type { Inngest } from "../Inngest.ts";
import type { IInngestExecution } from "./InngestExecution.ts";

/**
 * Note - this structure can be used by other libraries, so cannot have breaking changes.
 */
export interface AsyncContext {
  /**
   * The Inngest App that is currently being used to execute the function.
   *
   * If this is defined, we are in the context of an Inngest function execution,
   * or a possible one.
   */
  app: Inngest.Like;

  /**
   * Details of the current function execution context. If this doesn't exist,
   * then we're not currently in a function execution context.
   */
  execution?: {
    /**
     * The execution instance that is currently running the function.
     */
    instance: IInngestExecution;

    /**
     * The `ctx` object that has been passed in to this function execution,
     * including values such as `step` and `event`.
     */
    ctx: Context.Any;

    /**
     * If present, this indicates we are currently executing a `step.run()` step's
     * callback. Useful to understand whether we are in the context of a step
     * execution or within the main function body.
     */
    executingStep?: StepOptions;

    /**
     * If present, indicates the parallel mode that should be applied to steps
     * created within this context. Set by `group.parallel()`.
     */
    parallelMode?: "race";
  };
}

/**
 * A local-only symbol used as a key in global state to store the async local
 * storage instance.
 */
const alsSymbol = Symbol.for("inngest:als");

/**
 * Cache structure that stores both the promise and resolved ALS instance.
 * This allows synchronous access after initialization.
 */
type ALSCache = {
  promise: Promise<AsyncLocalStorageIsh>;
  resolved?: AsyncLocalStorageIsh;
  isFallback?: boolean;
};

/**
 * A type that represents a partial, runtime-agnostic interface of
 * `AsyncLocalStorage`.
 */
type AsyncLocalStorageIsh = {
  getStore: () => AsyncContext | undefined;
  run: <R>(store: AsyncContext, fn: () => R) => R;
};

const getCache = (): ALSCache => {
  const g = globalThis as Record<symbol, ALSCache | undefined>;

  if (!g[alsSymbol]) {
    g[alsSymbol] = createCache();
  }

  return g[alsSymbol];
};

const createCache = (): ALSCache => {
  const cache = {} as ALSCache;
  cache.promise = initializeALS(cache);
  return cache;
};

const initializeALS = async (
  cache: ALSCache,
): Promise<AsyncLocalStorageIsh> => {
  try {
    const { AsyncLocalStorage } = await import("node:async_hooks");
    const als = new AsyncLocalStorage<AsyncContext>();
    cache.resolved = als;
    cache.isFallback = false;
    return als;
  } catch {
    const fallback: AsyncLocalStorageIsh = {
      getStore: () => undefined,
      run: (_, fn) => fn(),
    };
    cache.resolved = fallback;
    cache.isFallback = true;
    console.warn(
      "node:async_hooks is not supported in this runtime. Async context is disabled.",
    );
    return fallback;
  }
};

/**
 * Check if AsyncLocalStorage is unavailable and we're using the fallback.
 * Returns `undefined` if ALS hasn't been initialized yet.
 */
export const isALSFallback = (): boolean | undefined => {
  return getCache().isFallback;
};

/**
 * Retrieve the async context for the current execution.
 */
export const getAsyncCtx = async (): Promise<AsyncContext | undefined> => {
  return getAsyncLocalStorage().then((als) => als.getStore());
};

/**
 * Retrieve the async context for the current execution synchronously.
 * Returns undefined if ALS hasn't been initialized yet.
 */
export const getAsyncCtxSync = (): AsyncContext | undefined => {
  return getCache().resolved?.getStore();
};

/**
 * Get a singleton instance of `AsyncLocalStorage` used to store and retrieve
 * async context for the current execution.
 */
export const getAsyncLocalStorage = async (): Promise<AsyncLocalStorageIsh> => {
  return getCache().promise;
};
