import { createClient, createFnRunner, testClientId } from "../test/helpers.ts";
import { InngestMiddlewareV2 } from "./InngestMiddlewareV2.ts";

test("no hooks", async () => {
  const state = { outputFromStep: "" };

  class TestMiddleware extends InngestMiddlewareV2 {}

  const client = createClient({
    id: testClientId,
    middlewareV2: [new TestMiddleware()],
  });

  const fn = client.createFunction(
    { id: "fn" },
    { event: "evt" },
    async ({ step }) => {
      state.outputFromStep = await step.run("step", () => {
        return "original";
      });
    },
  );

  const run = createFnRunner(fn, { event: { data: {}, name: "evt" } });

  // 1st request
  const { assertStepData } = await run();
  assertStepData("original");
  expect(state).toEqual({ outputFromStep: "" });

  // 2nd request
  await run();
  expect(state).toEqual({ outputFromStep: "original" });
});

describe("transformStep", () => {
  test("success", async () => {
    const state = {
      logs: [] as string[],
      outputInsideMiddleware: undefined as unknown,
      outputFromStep: "",
    };

    class TestMiddleware extends InngestMiddlewareV2 {
      override async transformStep(handler: () => unknown) {
        state.logs.push("mw handler: before");
        state.outputInsideMiddleware = await handler();
        state.logs.push("mw handler: after");
        return "transformed";
      }
    }

    const client = createClient({
      id: testClientId,
      middlewareV2: [new TestMiddleware()],
    });

    const fn = client.createFunction(
      { id: "fn" },
      { event: "evt" },
      async ({ step }) => {
        state.outputFromStep = await step.run("step", () => {
          state.logs.push("step handler");
          return "original";
        });
      },
    );

    const run = createFnRunner(fn, { event: { data: {}, name: "evt" } });

    // 1st request
    const { assertStepData } = await run();
    // Returned transformed data to Inngest Server
    assertStepData("transformed");
    expect(state).toEqual({
      logs: ["mw handler: before", "step handler", "mw handler: after"],
      // Middleware got the pre-transformed data from the step handler
      outputInsideMiddleware: "original",
      outputFromStep: "",
    });

    // 2nd request
    await run();
    expect(state).toEqual({
      logs: [
        "mw handler: before",
        "step handler",
        "mw handler: after",
        "mw handler: before",
        "mw handler: after",
      ],
      // Middleware got the already-transformed data from the step handler
      outputInsideMiddleware: "transformed",
      // Inngest function handler got the already-transformed memoized data
      outputFromStep: "transformed",
    });
  });

  test.only("error", async () => {
    const state = {
      errorInsideFn: undefined as unknown,
      errorsInsideMiddleware: [] as unknown[],
      logs: [] as string[],
    };

    class MyError extends Error {
      constructor(message: string) {
        super(message);
        this.name = this.constructor.name;
      }
    }

    class OtherError extends Error {
      constructor(...args: ConstructorParameters<typeof Error>) {
        super(...args);
        this.name = this.constructor.name;
      }
    }

    class TestMiddleware extends InngestMiddlewareV2 {
      override async transformStep(handler: () => unknown) {
        try {
        state.logs.push("mw handler: before");
          const output = await handler();
          state.logs.push("mw handler: after");
          return output;
        } catch (error) {
          state.logs.push("mw handler: error");
          state.errorsInsideMiddleware.push(error);
          if (error instanceof MyError) {
            error = new OtherError("other error", { cause: error });
          }
          throw error;
        }
      }
    }

    const client = createClient({
      id: testClientId,
      middlewareV2: [new TestMiddleware()],
    });

    const fn = client.createFunction(
      { id: "fn", retries: 1 },
      { event: "evt" },
      async ({ step }) => {
        try {
          await step.run("step", () => {
            state.logs.push("step handler");
            throw new MyError("test error");
          });
          state.logs.push("step handler: after");
        } catch (error) {
          state.logs.push("step handler: error");
          state.errorInsideFn = error;
        }
      },
    );

    const run = createFnRunner(fn, { event: { data: {}, name: "evt" } });

    // 1st request
    const { assertStepError, result } = await run();
    // Returned transformed data to Inngest Server
    assertStepError({
      cause: {
        __serialized: true,
        message: "test error",
        name: "MyError",
        stack: expect.any(String),
      },
      message: "other error",
      name: "OtherError",
    });
    expect(state.logs).toEqual([
      "mw handler: before",
      "step handler",
      "mw handler: error",
    ]);
    // expect(state).toEqual({
    //   // Middleware got the pre-transformed data from the step handler
    //   outputInsideMiddleware: "original",
    //   outputFromStep: "",
    // });

    // 2nd request
    await run();
    expect(state.logs).toEqual([
      "mw handler: before",
      "step handler",
      "mw handler: error",
      "step handler: error",
    ]);
    // expect(state).toEqual({
    //   // Middleware got the already-transformed data from the step handler
    //   outputInsideMiddleware: "transformed",
    //   // Inngest function handler got the already-transformed memoized data
    //   outputFromStep: "transformed",
    // });
    // console.log(state.errorsInsideMiddleware);
    // assert.isTrue(false);
  });
});
