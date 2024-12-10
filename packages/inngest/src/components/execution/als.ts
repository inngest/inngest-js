import { type Context } from "../../types.js";
import { AsyncLocalStorage } from "node:async_hooks";

export interface AsyncContext {
  ctx: Context.Any;
}

/**
 * A singleton instance of AsyncLocalStorage used to store and retrieve async
 * context for the current execution.
 */
export const als = new AsyncLocalStorage<AsyncContext>();

/**
 * Retrieve the async context for the current execution.
 */
export const getAsyncCtx = () => {
  return als.getStore();
};
