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

test("transformStep", async () => {
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
