import { test } from "vitest";
import { Inngest } from "../Inngest.ts";
import { Middleware } from "./middleware.ts";

test("stepOutputTransform does not affect step.invoke return type", () => {
  interface PreserveDate extends Middleware.StaticTransform {
    Out: this["In"] extends Date ? Date : this["In"];
  }

  class MW extends Middleware.BaseMiddleware {
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
