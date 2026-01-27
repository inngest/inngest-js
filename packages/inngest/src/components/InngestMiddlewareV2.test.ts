import { createClient, runFnWithStack, testClientId } from "../test/helpers.ts";
import { InngestMiddlewareV2 } from "./InngestMiddlewareV2.ts";

test("execution order: transformStep is called before step.run executes", async () => {
  const state = {
    logs: [] as string[],
    outputInsideMiddleware: undefined as unknown,
    outputFromStep: "" as string,
  }

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
    { id: "test-fn" },
    { event: "test/event" },
    async ({ step }) => {
      state.outputFromStep = await step.run("step", () => {
        state.logs.push("step handler");
        return "original";
      });
    },
  );

  // 1st request
  const result = await runFnWithStack(
    fn,
    {},
    { event: { data: {}, name: "test/event" } },
  );
  expect(state).toEqual({
    logs: ["mw handler: before", "step handler", "mw handler: after"],
    outputInsideMiddleware: "original",
    outputFromStep: "",
  });


  // Verify the step result contains the transformed value
  if (result.type !== "step-ran") {
    throw new Error(`Expected step-ran, got ${result.type}`);
  }
  expect(result.step.data).toEqual("transformed");

  // 2nd request
  await runFnWithStack(
    fn,
    { [result.step.id]: { id: result.step.id, data: result.step.data } },
    { event: { data: {}, name: "test/event" } },
  );
  expect(state).toEqual({
    logs: [
      "mw handler: before",
      "step handler",
      "mw handler: after",
      "mw handler: before",
      "mw handler: after",
    ],
    // On memoized replay, handler() returns the memoized data ("transformed")
    outputInsideMiddleware: "transformed",
    outputFromStep: "transformed",
  });

});

// describe("InngestMiddlewareV2", () => {
//   describe("transformStep", () => {
//     test("execution order: transformStep is called before step.run executes", async () => {
//       const logs: string[] = [];

//       class TestMiddleware extends InngestMiddlewareV2 {
//         override async transformStep(handler: () => unknown) {
//           logs.push("before running");
//           const output = await handler();
//           logs.push("after running");
//           return output;
//         }
//       }

//       const client = createClient({
//         id: testClientId,
//         middlewareV2: [new TestMiddleware()],
//       });

//       const fn = client.createFunction(
//         { id: "test-fn" },
//         { event: "test/event" },
//         async ({ step }) => {
//           await step.run("step", () => {
//             logs.push("running step");
//             return "Hello, world!";
//           });
//         },
//       );

//       await runFnWithStack(fn, {}, { event: { data: {}, name: "test/event" } });

//       expect(logs).toEqual(["before running", "running step", "after running"]);
//     });

//     test("return value: step output is returned to caller, not middleware return value", async () => {
//       const logs: string[] = [];

//       class TestMiddleware extends InngestMiddlewareV2 {
//         override async transformStep(handler: () => unknown) {
//           logs.push("before running");
//           await handler();
//           logs.push("after running");
//           return "Transformed"; // This should NOT be returned to the caller
//         }
//       }

//       const client = createClient({
//         id: testClientId,
//         middlewareV2: [new TestMiddleware()],
//       });

//       const fn = client.createFunction(
//         { id: "test-fn" },
//         { event: "test/event" },
//         async ({ step }) => {
//           const output = await step.run("step", () => {
//             logs.push("running step");
//             return "Hello, world!";
//           });
//           return output;
//         },
//       );

//       // First run: execute the step
//       const result = await runFnWithStack(
//         fn,
//         {},
//         { event: { data: {}, name: "test/event" } },
//       );

//       // Verify middleware was called
//       expect(logs).toEqual(["before running", "running step", "after running"]);

//       // The step result should be "Hello, world!", not "Transformed"
//       if (result.type === "step-ran") {
//         expect(result.step.data).toBe("Hello, world!");
//       } else {
//         throw new Error(`Unexpected result type: ${result.type}`);
//       }
//     });

//     test("logging/side effects: can log before and after step execution", async () => {
//       const logs: string[] = [];

//       class TestMiddleware extends InngestMiddlewareV2 {
//         override async transformStep(handler: () => unknown) {
//           logs.push("middleware: before");
//           await handler();
//           logs.push("middleware: after");
//         }
//       }

//       const client = createClient({
//         id: testClientId,
//         middlewareV2: [new TestMiddleware()],
//       });

//       const fn = client.createFunction(
//         { id: "test-fn" },
//         { event: "test/event" },
//         async ({ step }) => {
//           await step.run("step", () => {
//             logs.push("step: executing");
//           });
//         },
//       );

//       await runFnWithStack(fn, {}, { event: { data: {}, name: "test/event" } });

//       expect(logs).toEqual([
//         "middleware: before",
//         "step: executing",
//         "middleware: after",
//       ]);
//     });

//     test("multiple steps: transformStep is called for the executed step", async () => {
//       const logs: string[] = [];

//       class TestMiddleware extends InngestMiddlewareV2 {
//         override async transformStep(handler: () => unknown) {
//           logs.push("transform start");
//           await handler();
//           logs.push("transform end");
//         }
//       }

//       const client = createClient({
//         id: testClientId,
//         middlewareV2: [new TestMiddleware()],
//       });

//       const fn = client.createFunction(
//         { id: "test-fn" },
//         { event: "test/event" },
//         async ({ step }) => {
//           await step.run("step1", () => {
//             logs.push("step1");
//           });
//           await step.run("step2", () => {
//             logs.push("step2");
//           });
//           await step.run("step3", () => {
//             logs.push("step3");
//           });
//         },
//       );

//       // First run: executes step1, transformStep is called
//       await runFnWithStack(fn, {}, { event: { data: {}, name: "test/event" } });
//       expect(logs).toEqual(["transform start", "step1", "transform end"]);
//     });

//     test("async behavior: works with async transformStep", async () => {
//       const logs: string[] = [];

//       class TestMiddleware extends InngestMiddlewareV2 {
//         override async transformStep(handler: () => unknown) {
//           logs.push("async before");
//           await Promise.resolve(); // Simulate async operation
//           const output = await handler();
//           await Promise.resolve(); // Simulate async operation
//           logs.push("async after");
//           return output;
//         }
//       }

//       const client = createClient({
//         id: testClientId,
//         middlewareV2: [new TestMiddleware()],
//       });

//       const fn = client.createFunction(
//         { id: "test-fn" },
//         { event: "test/event" },
//         async ({ step }) => {
//           await step.run("step", () => {
//             logs.push("step running");
//             return "result";
//           });
//         },
//       );

//       await runFnWithStack(fn, {}, { event: { data: {}, name: "test/event" } });

//       expect(logs).toEqual(["async before", "step running", "async after"]);
//     });

//     test("async behavior: works with async step.run functions", async () => {
//       const logs: string[] = [];

//       class TestMiddleware extends InngestMiddlewareV2 {
//         override async transformStep(handler: () => unknown) {
//           logs.push("before");
//           const output = await handler();
//           logs.push("after");
//           return output;
//         }
//       }

//       const client = createClient({
//         id: testClientId,
//         middlewareV2: [new TestMiddleware()],
//       });

//       const fn = client.createFunction(
//         { id: "test-fn" },
//         { event: "test/event" },
//         async ({ step }) => {
//           const output = await step.run("step", async () => {
//             logs.push("async step start");
//             await Promise.resolve(); // Simulate async operation
//             logs.push("async step end");
//             return "async result";
//           });
//           return output;
//         },
//       );

//       const result = await runFnWithStack(
//         fn,
//         {},
//         { event: { data: {}, name: "test/event" } },
//       );

//       expect(logs).toEqual([
//         "before",
//         "async step start",
//         "async step end",
//         "after",
//       ]);

//       // Verify the step result is correct
//       if (result.type === "step-ran") {
//         expect(result.step.data).toBe("async result");
//       } else {
//         throw new Error(`Unexpected result type: ${result.type}`);
//       }
//     });
//   });
// });
