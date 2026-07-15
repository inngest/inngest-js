import { test } from "vitest";
import type { Jsonify } from "../../helpers/jsonify.ts";
import type { IsEqual } from "../../helpers/types.ts";
import type { ApplyAllMiddlewareTransforms } from "../../types.ts";
import { Inngest } from "../Inngest.ts";
import { Middleware } from "./middleware.ts";

test("default middleware output transforms are applied only once", () => {
  class MW1 extends Middleware.BaseMiddleware {
    readonly id = "test-1";
  }

  class MW2 extends Middleware.BaseMiddleware {
    readonly id = "test-2";
  }

  type StepResult = {
    passed: boolean;
    checks: { name: string; passed: boolean; message: string }[];
  };

  type StepOutput = ApplyAllMiddlewareTransforms<
    [typeof MW1, typeof MW2],
    StepResult
  >;
  type FunctionOutput = ApplyAllMiddlewareTransforms<
    [typeof MW1, typeof MW2],
    StepResult,
    "functionOutputTransform"
  >;

  assertType<IsEqual<StepOutput, Jsonify<StepResult>>>(true);
  assertType<IsEqual<FunctionOutput, Jsonify<StepResult>>>(true);
});

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

// stacked default output transforms apply `Jsonify` repeatedly,
// which used to collapse objects with optional properties to `{}`.
test("multiple middleware preserve step.run output with optional properties", () => {
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
      expectTypeOf(widget.media[0]!.mediaId).toEqualTypeOf<string>();
    },
  );
});

// a handler returning a `step.run` result already has `Jsonify` in its return type,
// so `step.invoke` applies it a second time.
test("step.invoke preserves optional properties in invoked step.run output", () => {
  type Widget = { media: { mediaId: string; label?: string }[] };

  const client = new Inngest({ id: "test" });

  const childFn = client.createFunction(
    { id: "child", triggers: [{ event: "any" }] },
    async ({ step }) =>
      step.run("load", async (): Promise<Widget> => ({ media: [] })),
  );

  client.createFunction(
    { id: "parent", triggers: [{ event: "any" }] },
    async ({ step }) => {
      const widget = await step.invoke("invoke-child", { function: childFn });

      expectTypeOf(widget.media).not.toBeAny();
      expectTypeOf(widget.media[0]!.mediaId).toEqualTypeOf<string>();
    },
  );
});
