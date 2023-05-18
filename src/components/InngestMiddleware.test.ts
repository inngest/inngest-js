/* eslint-disable @typescript-eslint/no-explicit-any */
import { type BaseContext } from "inngest/types";
import { assertType, type IsEqual } from "type-plus";
import {
  createMiddleware,
  type MiddlewareStackRunInputMutation,
} from "./InngestMiddleware";

describe("createMiddleware", () => {
  test.todo("todo");
});

describe("stacking and inference", () => {
  describe("run", () => {
    describe("input", () => {
      describe("can add a value to input context", () => {
        const mw = createMiddleware({
          name: "mw",
          register() {
            return {
              run() {
                return {
                  input() {
                    return {
                      ctx: { foo: "bar" },
                    };
                  },
                };
              },
            };
          },
        });

        type Result = MiddlewareStackRunInputMutation<
          BaseContext<any, any, any>,
          [typeof mw]
        >;

        test("types: input context has value", () => {
          assertType<IsEqual<Result["foo"], string>>(true);
        });

        test.todo("runtime: input context has value");
      });

      describe("can mutate an existing input context value", () => {
        const mw1 = createMiddleware({
          name: "mw1",
          register() {
            return {
              run() {
                return {
                  input() {
                    return {
                      ctx: { foo: "bar" },
                    };
                  },
                };
              },
            };
          },
        });

        const mw2 = createMiddleware({
          name: "mw2",
          register() {
            return {
              run() {
                return {
                  input() {
                    return {
                      ctx: { foo: true },
                    };
                  },
                };
              },
            };
          },
        });

        type Result = MiddlewareStackRunInputMutation<
          BaseContext<any, any, any>,
          [typeof mw1, typeof mw2]
        >;

        test("types: input context has new value", () => {
          assertType<IsEqual<Result["foo"], boolean>>(true);
        });

        test.todo("runtime: input context has value");
      });

      describe("can add multiple input context value via stacking", () => {
        const mw1 = createMiddleware({
          name: "mw1",
          register() {
            return {
              run() {
                return {
                  input() {
                    return {
                      ctx: { foo: "foo" },
                    };
                  },
                };
              },
            };
          },
        });

        const mw2 = createMiddleware({
          name: "mw2",
          register() {
            return {
              run() {
                return {
                  input() {
                    return {
                      ctx: { bar: true },
                    };
                  },
                };
              },
            };
          },
        });

        type Result = MiddlewareStackRunInputMutation<
          BaseContext<any, any, any>,
          [typeof mw1, typeof mw2]
        >;

        test("types: input context has foo value", () => {
          assertType<IsEqual<Result["foo"], string>>(true);
        });

        test("types: input context has bar value", () => {
          assertType<IsEqual<Result["bar"], boolean>>(true);
        });

        test.todo("runtime: input context has foo value");
        test.todo("runtime: input context has bar value");
      });

      describe("can overwrite a new value in input context", () => {
        test.todo("types: input context has new value");
        test.todo("runtime: input context has value");
      });
    });
  });
});

createMiddleware({
  name: "Data transformer",
  register() {
    return {
      run() {
        return {
          input(ctx) {
            return {};
          },
        };
      },
    };
  },
});

inngest.use({
  async execution(input, next) {
    const result = await next({
      ...input,
      ctx: {
        ...ctx,
        event: superjson.parse(input.ctx.event),
      },
      steps: input.steps.map((step) => ({
        ...step,
        data: superjson.parse(step.data),
      })),
    });

    return {
      ...result,
      data: superjson.stringify(result.data),
    };
  },

  sendEvent(input, next) {
    return next({
      ...input,
      payloads: input.payloads.map((payload) => ({
        ...payload,
        data: superjson.stringify(payload.data),
      })),
    });
  },
});
