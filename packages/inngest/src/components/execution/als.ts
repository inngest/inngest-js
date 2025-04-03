import { type Context, type StepOptions } from "../../types.js";

export interface AsyncContext {
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
    import("./als.import.cjs" as string).then(
      ({ als }: { als: AsyncLocalStorageIsh }) => als
    );

  return (globalThis as Record<string | symbol | number, unknown>)[
    alsSymbol
  ] as Promise<AsyncLocalStorageIsh>;
};
