import type { Context, StepOptions } from "../../types.ts";
import type { Inngest } from "../Inngest.ts";
import type {
  ExecutionVersion,
  IInngestExecution,
} from "./InngestExecution.ts";

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
     * The version of the execution that is currently running.
     */
    version: ExecutionVersion;

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
  };
}

/**
 * A local-only symbol used as a key in global state to store the async local
 * storage instance.
 */
const alsSymbol = Symbol.for("inngest:als");

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
 * Get a singleton instance of `AsyncLocalStorage` used to store and retrieve
 * async context for the current execution.
 */
export const getAsyncLocalStorage = async (): Promise<AsyncLocalStorageIsh> => {
  (globalThis as Record<string | symbol | number, unknown>)[alsSymbol] ??=
    new Promise<AsyncLocalStorageIsh>(async (resolve) => {
      try {
        const { AsyncLocalStorage } = await import("node:async_hooks");

        resolve(new AsyncLocalStorage<AsyncContext>());
      } catch (_err) {
        console.warn(
          "node:async_hooks is not supported in this runtime. Experimental async context is disabled.",
        );

        resolve({
          getStore: () => undefined,
          run: (_, fn) => fn(),
        });
      }
    });

  return (globalThis as Record<string | symbol | number, unknown>)[
    alsSymbol
  ] as Promise<AsyncLocalStorageIsh>;
};
