import { metadataSymbol } from "../components/InngestMetadata";
import type { ExperimentalStepTools } from "../components/InngestStepTools";
import { Middleware } from "../components/middleware/middleware.ts";
import type { MaybePromise } from "../helpers/types";

/**
 * Adds `step.score` to the function input. Used to score variants in
 * experiments created via `group.experiment()`.
 *
 * `step.score` is currently a no-op stub — the implementation will be filled in
 * later.
 */
export const experimentScoreMiddleware = () => {
  class ExperimentScoreMiddleware extends Middleware.BaseMiddleware {
    readonly id = "inngest:experiment-score";

    override transformFunctionInput(
      arg: Middleware.TransformFunctionInputArgs,
    ): Middleware.TransformFunctionInputArgs & {
      ctx: {
        step: {
          /**
           * EXPERIMENTAL
           *
           * An initial scoring implementation that just uses `step.run()` to
           * execute the scoring inline; it MUST be awaited in this form.
           *
           * This will be replaced with a more robust, ergonomic implemenetation
           * in the future, but this allows us to start testing and iterating on
           * the API now.
           *
           * @deprecated Experimental - use at your own risk.
           */
          score: (
            key: string,
            handler:
              | MaybePromise<number | boolean>
              | (() => MaybePromise<number | boolean>),
          ) => Promise<void>;
        };
      };
    } {
      return {
        ...arg,
        ctx: {
          ...arg.ctx,
          step: {
            ...arg.ctx.step,
            score: async (key, handler) => {
              const stepMetadata = (
                arg.ctx.step as unknown as ExperimentalStepTools
              )[metadataSymbol];

              const value = await (typeof handler === "function"
                ? handler()
                : handler);

              return stepMetadata(key).update({
                [`score::${key}`]: value,
              });
            },
          },
        },
      };
    }
  }

  return ExperimentScoreMiddleware;
};
