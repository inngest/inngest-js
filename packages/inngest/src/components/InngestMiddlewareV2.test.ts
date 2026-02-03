import type { IsEqual } from "../helpers/types.ts";
import type { Jsonify } from "../types.ts";
import { Inngest } from "./Inngest.ts";
import { Middleware } from "./InngestMiddlewareV2.ts";

describe("staticTransform", () => {
  test("custom staticTransform", () => {
    // Normal generic type the way someone might write it irrespective of
    // Inngest
    type PreserveDate<T> = T extends Date ? Date : Jsonify<T>;

    // Turn the above type into an Inngest-compatible Middleware.StaticTransform
    interface PreserveDateTransform extends Middleware.StaticTransform {
      Out: PreserveDate<this["In"]>;
    }

    class DatePreservingMiddleware extends Middleware.BaseMiddleware {
      declare staticTransform: PreserveDateTransform;
    }

    const inngest = new Inngest({
      id: "test",
      middlewareV2: [new DatePreservingMiddleware()],
    });

    inngest.createFunction(
      { id: "test-fn" },
      { event: "test/event" },
      async ({ step }) => {
        const result = await step.run("get-date", () => new Date());
        expectTypeOf(result).not.toBeAny();
        expectTypeOf(result).toEqualTypeOf<Date>();
      },
    );
  });

  test("no middleware", () => {
    // Jsonify: Date -> string
    const inngest = new Inngest({ id: "test" });

    inngest.createFunction(
      { id: "test-fn" },
      { event: "test/event" },
      async ({ step }) => {
        const result = await step.run("get-date", () => new Date());
        expectTypeOf(result).not.toBeAny();
        expectTypeOf(result).toEqualTypeOf<string>();
      },
    );
  });

  test("middleware without staticTransform", () => {
    // Jsonify: Date -> string

    class RegularMiddleware extends Middleware.BaseMiddleware {}

    const inngest = new Inngest({
      id: "test",
      middlewareV2: [new RegularMiddleware()],
    });

    inngest.createFunction(
      { id: "test-fn" },
      { event: "test/event" },
      async ({ step }) => {
        const result = await step.run("get-date", () => new Date());

        // Regular middleware without staticTransform uses Jsonify
        type Actual = typeof result;
        type Expected = string;
        assertType<IsEqual<Actual, Expected>>(true);
      },
    );
  });

  test("multiple staticTransform", () => {
    // Test that multiple middleware transforms are composed together

    interface BooleanToStringTransform extends Middleware.StaticTransform {
      Out: this["In"] extends boolean ? string : this["In"];
    }

    class BooleanToString extends Middleware.BaseMiddleware {
      declare staticTransform: BooleanToStringTransform;
    }

    interface NumberToStringTransform extends Middleware.StaticTransform {
      Out: this["In"] extends number ? string : this["In"];
    }

    class NumberToString extends Middleware.BaseMiddleware {
      declare staticTransform: NumberToStringTransform;
    }

    const inngest = new Inngest({
      id: "test",
      middlewareV2: [new BooleanToString(), new NumberToString()],
    });

    inngest.createFunction(
      { id: "test-fn" },
      { event: "test/event" },
      async ({ step }) => {
        // Boolean -> string via BooleanToString middleware
        const boolResult = await step.run("get-bool", () => true);
        expectTypeOf(boolResult).not.toBeAny();
        expectTypeOf(boolResult).toEqualTypeOf<string>();

        // Number -> string via NumberToString middleware
        const numResult = await step.run("get-num", () => 42);
        expectTypeOf(numResult).not.toBeAny();
        expectTypeOf(numResult).toEqualTypeOf<string>();

        // String stays string (no transform applies)
        const strResult = await step.run("get-str", () => "hello");
        expectTypeOf(strResult).not.toBeAny();
        expectTypeOf(strResult).toEqualTypeOf<string>();
      },
    );
  });
});
