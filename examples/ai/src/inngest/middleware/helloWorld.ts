import { Middleware } from "inngest";

/**
 * A trivial middleware used to check that a user's own middleware still
 * composes with the `aiMiddleware()` bundle, both at runtime and in the types.
 */
export class HelloWorldMiddleware extends Middleware.BaseMiddleware {
  readonly id = "hello-world";

  override onRunStart({ ctx }: Middleware.OnRunStartArgs) {
    console.log(`[hello-world] run start ${ctx.runId}`);
  }

  override transformFunctionInput(arg: Middleware.TransformFunctionInputArgs) {
    return {
      ...arg,
      ctx: {
        ...arg.ctx,
        greet: (name: string) => console.log(`[hello-world] hello, ${name}!`),
      },
    };
  }
}
