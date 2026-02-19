import { Middleware } from "../components/middleware/middleware.ts";

/**
 * Adds properties to the function input for every function created using this
 * app.
 */
// biome-ignore lint/suspicious/noExplicitAny: unknown can be troublesome here
export const dependencyInjectionMiddleware = <TCtx extends Record<string, any>>(
  /**
   * The context to inject into the function input.
   */
  ctx: TCtx,
) => {
  class DependencyInjectionMiddleware extends Middleware.BaseMiddleware {
    override transformFunctionInput(
      arg: Middleware.TransformFunctionInputArgs,
    ): Middleware.TransformFunctionInputArgs & { ctx: TCtx } {
      return {
        ...arg,
        ctx: {
          ...arg.ctx,
          ...ctx,
        },
      };
    }
  }

  return DependencyInjectionMiddleware;
};
