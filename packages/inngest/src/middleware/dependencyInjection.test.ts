import { Inngest } from "@local/components/Inngest";
import { assertType } from "../test/helpers";
import { dependencyInjectionMiddleware } from "./dependencyInjection";

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

    const _fn = inngest.createFunction({ id: "test" }, { event: "" }, (ctx) => {
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

    const _fn = inngest.createFunction({ id: "test" }, { event: "" }, (ctx) => {
      assertType<"bar">(ctx.foo);
    });
  });
});
