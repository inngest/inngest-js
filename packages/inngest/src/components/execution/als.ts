import type { Context, StepOptions } from "../../types.ts";
import type { Inngest } from "../Inngest.ts";
import type { InngestStream } from "../InngestStreamTools.ts";
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
     * The stream tools instance for this execution, used to push SSE frames to
     * clients during durable endpoint execution.
     */
    stream?: InngestStream;
  };
}

/**
 * A local-only symbol used as a key in global state to store the async local
 * storage instance.
 */
const alsSymbol = Symbol.for("inngest:als");

/**
 * Symbol for the synchronous ALS cache. Once the async import resolves, we
 * store the instance here so that callers can access the store without going
 * through a promise chain (critical for fire-and-forget paths like
 * `stream.push()`).
 */
const alsSyncSymbol = Symbol.for("inngest:als:sync");

/**
 * A type that represents a partial, runtime-agnostic interface of
 * `AsyncLocalStorage`.
 */
type AsyncLocalStorageIsh = {
  getStore: () => AsyncContext | undefined;
  run: <R>(store: AsyncContext, fn: () => R) => R;
};

/**
 * Retrieve the async context for the current execution.
 */
export const getAsyncCtx = async (): Promise<AsyncContext | undefined> => {
  return getAsyncLocalStorage().then((als) => als.getStore());
};

/**
 * Synchronously retrieve the async context. Returns `undefined` if the ALS
 * hasn't been initialized yet (first import not resolved).
 */
export const getAsyncCtxSync = (): AsyncContext | undefined => {
  const als = (globalThis as Record<string | symbol | number, unknown>)[
    alsSyncSymbol
  ] as AsyncLocalStorageIsh | undefined;
  return als?.getStore();
};

/**
 * Get a singleton instance of `AsyncLocalStorage` used to store and retrieve
 * async context for the current execution.
 */
export const getAsyncLocalStorage = async (): Promise<AsyncLocalStorageIsh> => {
  (globalThis as Record<string | symbol | number, unknown>)[alsSymbol] ??=
    new Promise<AsyncLocalStorageIsh>(async (resolve) => {
      try {
        const { AsyncLocalStorage } = await import("node:async_hooks");

        const als = new AsyncLocalStorage<AsyncContext>();
        (globalThis as Record<string | symbol | number, unknown>)[
          alsSyncSymbol
        ] = als;
        resolve(als);
      } catch (_err) {
        console.warn(
          "node:async_hooks is not supported in this runtime. Experimental async context is disabled.",
        );

        const fallback: AsyncLocalStorageIsh = {
          getStore: () => undefined,
          run: (_, fn) => fn(),
        };
        (globalThis as Record<string | symbol | number, unknown>)[
          alsSyncSymbol
        ] = fallback;
        resolve(fallback);
      }
    });

  return (globalThis as Record<string | symbol | number, unknown>)[
    alsSymbol
  ] as Promise<AsyncLocalStorageIsh>;
};
