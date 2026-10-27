import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  type CreateDeferInput,
  createDefer,
  type DeferContext,
  type DeferredFunction,
} from "./DeferredFunction.ts";
import { type Inngest, internalLoggerSymbol } from "./Inngest.ts";
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
 * is a no-op. When the parent was deferred with an experiment the score is
 * attributed to it, and any returned `stepId` is ignored since experiment
 * scores are run-scoped.
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
        const parent = ctx.parents[0];
        await ctx.step.run("score", async () => {
          if (parent.experiment) {
            // Experiment scores are run scoped, so a stepId is dropped
            // (score.experiment() would reject it) and the score lands on
            // the run where the experiment view reads it.
            const { stepId, ...runResult } = result;
            if (stepId !== undefined) {
              client[internalLoggerSymbol].warn(
                `createScorer("${options.id}"): ignoring stepId "${stepId}" because the parent was deferred with an experiment; experiment scores are run-scoped`,
              );
            }
            await client.score.experiment({
              experiment: parent.experiment,
              runId: parent.runId,
              ...runResult,
            });
          } else {
            await client.score({ runId: parent.runId, ...result });
          }
        });
      }
      return result;
    },
  );
}
