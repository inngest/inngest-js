/**
 * @module
 * EXPERIMENTAL: helpers for tests that drive thread handles.
 */
import type { ThreadHandle } from "../thread.ts";

/**
 * A thread handle whose `state()` returns only the keys the agent set.
 */
export interface ThreadHandleWithKeys extends Omit<ThreadHandle, "state"> {
  /**
   * The keys the agent set in the thread's KV scope, for tests that assert on
   * those.
   */
  state(): Promise<Record<string, unknown>>;
}

/**
 * The handle, with `state()` returning only the keys the agent set, for
 * tests that assert on those.
 */
export const withKeys = (
  /**
   * The thread handle.
   */
  thread: ThreadHandle,
): ThreadHandleWithKeys => {
  return {
    ...thread,
    state: async () => {
      return (await thread.state()).keys;
    },
  };
};
