import { expect, expectTypeOf, test } from "vitest";
import { Inngest } from "../Inngest.ts";
import { Middleware } from "./middleware.ts";

test("isStepType narrows stepInfo to the matching step type", () => {
  const stepInfo = {
    stepType: "invoke" as Middleware.StepType,
  };

  if (Middleware.isStepType(stepInfo, "invoke")) {
    expect(stepInfo.stepType).toBe("invoke");
    expectTypeOf(stepInfo.stepType).toEqualTypeOf<"invoke">();
  } else {
    throw new Error("expected isStepType to match");
  }

  expect(Middleware.isStepType(stepInfo, "sendEvent")).toBe(false);
});

test("isStepType accepts open-union members not declared on StepType", () => {
  // `StepType` is an open union; the guard must work for step types that do
  // not yet exist as declared members, without a breaking change.
  const stepInfo = { stepType: "group.parallel" as Middleware.StepType };

  expect(Middleware.isStepType(stepInfo, "group.parallel")).toBe(true);

  if (Middleware.isStepType(stepInfo, "group.parallel")) {
    expectTypeOf(stepInfo.stepType).toEqualTypeOf<"group.parallel">();
  }
});

test("isStepType preserves extra fields on the narrowed type", () => {
  const stepInfo = {
    stepType: "invoke" as Middleware.StepType,
    hashedId: "abc",
  };

  if (Middleware.isStepType(stepInfo, "invoke")) {
    expectTypeOf(stepInfo.hashedId).toEqualTypeOf<string>();
    expectTypeOf(stepInfo.stepType).toEqualTypeOf<"invoke">();
  }
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
