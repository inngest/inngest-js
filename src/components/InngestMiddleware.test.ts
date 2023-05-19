/* eslint-disable @typescript-eslint/no-explicit-any */
import { type BaseContext } from "inngest/types";
import { assertType, type IsEqual } from "type-plus";
import {
  InngestMiddleware,
  type MiddlewareStackRunInputMutation,
} from "./InngestMiddleware";

describe("types: stacking and inference", () => {
  describe("run", () => {
    describe("input", () => {
      describe("can add a value to input context", () => {
        const mw = new InngestMiddleware({
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

        test("input context has value", () => {
          assertType<IsEqual<Result["foo"], string>>(true);
        });
      });

      describe("can add a literal value to input context", () => {
        const mw = new InngestMiddleware({
          name: "mw",
          register() {
            return {
              run() {
                return {
                  input() {
                    return {
                      ctx: { foo: "bar" },
                    } as const;
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

        test("input context has value", () => {
          assertType<IsEqual<Result["foo"], "bar">>(true);
        });
      });

      describe("can mutate an existing input context value", () => {
        const mw1 = new InngestMiddleware({
          name: "mw1",
          register() {
            return {
              run() {
                return {
                  input() {
                    return {
                      ctx: { event: true },
                    };
                  },
                };
              },
            };
          },
        });

        type Result = MiddlewareStackRunInputMutation<
          BaseContext<any, any, any>,
          [typeof mw1]
        >;

        test("input context has new value", () => {
          assertType<IsEqual<Result["event"], boolean>>(true);
        });
      });

      describe("can add multiple input context values via stacking", () => {
        const mw1 = new InngestMiddleware({
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

        const mw2 = new InngestMiddleware({
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

        test("input context has foo value", () => {
          assertType<IsEqual<Result["foo"], string>>(true);
        });

        test("input context has bar value", () => {
          assertType<IsEqual<Result["bar"], boolean>>(true);
        });
      });

      describe("can overwrite a new value in input context", () => {
        const mw1 = new InngestMiddleware({
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

        const mw2 = new InngestMiddleware({
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

        test("input context has new value", () => {
          assertType<IsEqual<Result["foo"], boolean>>(true);
        });
      });
    });
  });
});
