import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  type CreateDeferInput,
  createDefer,
  type DeferContext,
  type DeferredFunction,
} from "./DeferredFunction.ts";
import type { Inngest } from "./Inngest.ts";
import type { ScoreOptions } from "./InngestScore.ts";
import type { Middleware } from "./middleware/index.ts";

type ScorerResult =
  | (Omit<ScoreOptions, "runId"> & { runId?: string })
  | null
  | undefined;

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Create a typed scorer function. Wraps `createDefer`: the handler's
 * return value is forwarded to `client.score(...)` inside a durable
 * `step.run("score", ...)`. `runId` defaults to the parent run's id (from
 * `event.data.parent.runId`) when the handler omits it. A nullish return
 * is a no-op.
 */
export function createScorer<
  TClient extends Inngest.Any,
  TSchema extends
    | StandardSchemaV1<Record<string, unknown>>
    | undefined = undefined,
  const TFnMiddleware extends Middleware.Class[] | undefined = undefined,
>(
  client: TClient,
  options: CreateDeferInput<TFnMiddleware, TSchema>,
  handler: (
    ctx: DeferContext<TClient, TFnMiddleware, TSchema>,
  ) => ScorerResult | Promise<ScorerResult>,
): DeferredFunction<TSchema> {
  return createDefer<TClient, TSchema, TFnMiddleware>(
    client,
    options,
    async (ctx) => {
      const result = await handler(ctx);
      if (result) {
        await ctx.step.run("score", async () => {
          await client.score({
            runId: ctx.parents[0].runId,
            ...result,
          });
        });
      }
      return result;
    },
  );
}
