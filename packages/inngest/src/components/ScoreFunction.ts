import { createDefer } from "./DeferredFunction.ts";

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Create a typed scorer function. Thin wrapper around `createDefer` with
 * an identical signature.
 */
export const createScorer: typeof createDefer = (client, options, handler) => {
  return createDefer(client, options, handler);
};
