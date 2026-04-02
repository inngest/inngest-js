import type { Context } from "inngest";
import { NonRetriableError } from "inngest";

/**
 * Returns a `transformCtx` function that replaces disallowed step tools with
 * error-throwing stubs.
 */
export function createStepToolFilter(allowed: string[]) {
  const allowedSet = new Set(allowed);

  return (ctx: Readonly<Context.Any>): Context.Any => {
    const step = ctx.step as Record<string, unknown>;
    const filtered: Record<string, unknown> = {};

    for (const key of Object.keys(step)) {
      if (allowedSet.has(key)) {
        filtered[key] = step[key];
      } else {
        filtered[key] = () => {
          throw new NonRetriableError(
            `Step tool "${key}" is not available in this workflow. Allowed: ${allowed.join(", ")}`
          );
        };
      }
    }

    return { ...ctx, step: filtered as Context.Any["step"] };
  };
}
