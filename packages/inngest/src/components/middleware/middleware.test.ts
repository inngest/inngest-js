import { test } from "vitest";
import { Inngest } from "../Inngest.ts";
import { Middleware } from "./middleware.ts";

test("stepOutputTransform does not affect step.invoke return type", () => {
  interface PreserveDate extends Middleware.StaticTransform {
    Out: this["In"] extends Date ? Date : this["In"];
  }

  class MW extends Middleware.BaseMiddleware {
    readonly id = "test";
    declare stepOutputTransform: PreserveDate;
  }

  const client = new Inngest({ id: "test", middleware: [MW] });

  client.createFunction(
    { id: "parent", triggers: [{ event: "any" }] },
    async ({ step }) => {
      const output = await step.invoke("invoke-child", {
        function: childFn,
      });

      expectTypeOf(output).not.toBeAny();
      expectTypeOf(output).toEqualTypeOf<{ date: string; value: number }>();
    },
  );

  const childFn = client.createFunction(
    { id: "child", triggers: [{ event: "any" }] },
    async () => {
      return { date: new Date(), value: 42 };
    },
  );
});

test("multiple middleware preserve step.run output with optional properties", () => {
  // Two no-op middleware. Their default `stepOutputTransform` each applies
  // `Jsonify`, so stacking them used to nest `Jsonify<Jsonify<...>>`. With a
  // returned element carrying an optional property, that nesting tripped
  // TypeScript's instantiation guard and silently degraded the element to
  // `JsonifyObject<{}>`, so property access failed. One middleware never did.
  class MiddlewareA extends Middleware.BaseMiddleware {
    readonly id = "a";
  }
  class MiddlewareB extends Middleware.BaseMiddleware {
    readonly id = "b";
  }

  type Widget = { media: { mediaId: string; label?: string }[] };

  const client = new Inngest({
    id: "test",
    middleware: [MiddlewareA, MiddlewareB],
  });

  client.createFunction(
    { id: "fn", triggers: [{ event: "any" }] },
    async ({ step }) => {
      const widget = await step.run(
        "load",
        async (): Promise<Widget> => ({ media: [] }),
      );

      expectTypeOf(widget.media).not.toBeAny();
      expectTypeOf(widget.media).toEqualTypeOf<
        { mediaId: string; label?: string }[]
      >();
    },
  );
});
