import { Inngest } from "../components/Inngest.ts";
import { dependencyInjectionMiddleware } from "./dependencyInjection.ts";

describe("client level", () => {
  // Injections at the client level apply to all of the client's functions

  test("ctx is injected into the function input", () => {
    const inngest = new Inngest({
      id: "test",
      middleware: [
        dependencyInjectionMiddleware({
          foo: "bar",
        }),
      ],
    });

    inngest.createFunction({ id: "test", triggers: [{ event: "" }] }, (ctx) => {
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

    inngest.createFunction({ id: "test", triggers: [{ event: "" }] }, (ctx) => {
      assertType<"bar">(ctx.foo);
    });
  });
});

describe("function level", () => {
  // Injections at the function level apply only to that function

  test("ctx is injected into the function input", () => {
    const inngest = new Inngest({ id: "test" });
    inngest.createFunction(
      {
        id: "test",
        middleware: [
          dependencyInjectionMiddleware({
            foo: "bar",
          }),
        ],
        triggers: [{ event: "" }],
      },
      (ctx) => {
        assertType<string>(ctx.foo);
      },
    );

    // Doesn't leak to other functions
    inngest.createFunction({ id: "test", triggers: [{ event: "" }] }, (ctx) => {
      // @ts-expect-error foo is not in the context
      ctx.foo;
    });
  });

  test("can infer const ctx type", () => {
    const inngest = new Inngest({ id: "test" });
    inngest.createFunction(
      {
        id: "test",
        middleware: [
          dependencyInjectionMiddleware({
            foo: "bar",
          } as const),
        ],
        triggers: [{ event: "" }],
      },
      (ctx) => {
        assertType<"bar">(ctx.foo);
      },
    );
  });
});
