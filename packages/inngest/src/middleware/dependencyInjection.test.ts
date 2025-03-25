import { Inngest } from "@local/components/Inngest";
import { dependencyInjectionMiddleware } from "@local/middleware/dependencyInjection";
import { assertType } from "../test/helpers";

describe("Mutates ctx", () => {
  test("ctx is injected into the function input", () => {
    const inngest = new Inngest({
      id: "test",
      middleware: [
        dependencyInjectionMiddleware({
          foo: "bar",
        }),
      ],
    });

    inngest.createFunction({ id: "test" }, { event: "" }, (ctx) => {
      assertType<string>(ctx.foo);
    });
  });

  test("can infer const ctx type", () => {
    const inngest = new Inngest({
      id: "test",
      middleware: [
        dependencyInjectionMiddleware({
          foo: "bar",
        } as const),
      ],
    });

    inngest.createFunction({ id: "test" }, { event: "" }, (ctx) => {
      assertType<"bar">(ctx.foo);
    });
  });
});
