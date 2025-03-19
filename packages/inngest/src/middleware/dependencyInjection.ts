import { InngestMiddleware } from "inngest/components/InngestMiddleware";

/**
 * Adds properties to the function input for every function created using this
 * app.
 */
export const dependencyInjectionMiddleware = (
  /**
   * The context to inject into the function input.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: Record<string, any>
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
