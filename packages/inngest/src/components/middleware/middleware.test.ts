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
