/**
 * @module
 * EXPERIMENTAL: the sessions of the running function, read the same way by KV
 * scopes and `agent.invoke()`.
 */
import { reduceEventsToPropagatedSessions } from "../../helpers/sessions.ts";
import type { Context } from "../../types.ts";

/**
 * The sessions a run is in. `ctx.sessions` is only set while session
 * propagation is on, so the trigger events' sessions are read too.
 */
export const currentSessions = (
  /**
   * The running function's context.
   */
  ctx: Pick<Context.Any, "event" | "events" | "sessions">,
): Record<string, string> => {
  return {
    ...reduceEventsToPropagatedSessions(ctx.events ?? [ctx.event]),
    ...ctx.sessions,
  };
};
