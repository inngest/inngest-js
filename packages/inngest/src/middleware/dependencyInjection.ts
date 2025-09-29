import { InngestMiddleware } from "../components/InngestMiddleware.ts";

/**
 * Adds properties to the function input for every function created using this
 * app.
 */
// We can use `const` here yet due to TS constraints.

// biome-ignore lint/suspicious/noExplicitAny: unknown can be troublesome here
export const dependencyInjectionMiddleware = <TCtx extends Record<string, any>>(
  /**
   * The context to inject into the function input.
   */
  ctx: TCtx,
) => {
  return new InngestMiddleware({
    name: "Inngest: Dependency Injection",
    init() {
      return {
        onFunctionRun() {
          return {
            transformInput() {
              return {
                ctx,
              };
            },
          };
        },
      };
    },
  });
};
