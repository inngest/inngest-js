/**
 * @module
 * Helpers for scenarios that drive thread handles.
 */
import type { ThreadHandle } from "inngest/experimental/agents";

/**
 * The handle, with `state()` returning only the keys the agent set, for
 * scenarios that assert on those.
 * @param thread The thread handle.
 */
export const withKeys = (thread: ThreadHandle) => {
  return {
    ...thread,
    state: async (): Promise<Record<string, unknown>> => {
      return (await thread.state()).keys;
    },
  };
};
