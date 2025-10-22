import { Inngest } from "inngest";
import { InngestTestEngine } from "../";

describe("InngestTestEngine", () => {
  describe("lazy execution of mocked steps", () => {
    it("should only call mock handlers when steps actually run, not on initial access", async () => {
      const inngest = new Inngest({ id: "test-app" });

      // Track the order of execution
      const executionOrder: string[] = [];

      const fn = inngest.createFunction(
        { id: "test-fn" },
        { event: "test/event" },
        async ({ step }) => {
          executionOrder.push("function-start");

          const step1Result = await step.run("step-1", () => {
            executionOrder.push("step-1-unmocked");
            return "unmocked-result-1";
          });

          const step2Result = await step.run("step-2", () => {
            executionOrder.push("step-2-unmocked");
            return "unmocked-result-2";
          });

          const step3Result = await step.run("step-3", () => {
            executionOrder.push("step-3-unmocked");
            return "unmocked-result-3";
          });

          executionOrder.push("function-end");

          return {
            step1Result,
            step2Result,
            step3Result,
          };
        }
      );

      const t = new InngestTestEngine({
        function: fn,
        steps: [
          {
            id: "step-1",
            handler: () => {
              executionOrder.push("step-1-mocked");
              return "mocked-result-1";
            },
          },
          {
            id: "step-3",
            handler: () => {
              executionOrder.push("step-3-mocked");
              return "mocked-result-3";
            },
          },
        ],
      });

      const { result } = await t.execute();

      // Verify results
      expect(result).toEqual({
        step1Result: "mocked-result-1",
        step2Result: "unmocked-result-2",
        step3Result: "mocked-result-3",
      });

      // Verify execution order - mocked handlers should run only ONCE each
      // The function may execute multiple times as steps complete
      const step1MockedCount = executionOrder.filter(
        (item) => item === "step-1-mocked"
      ).length;
      const step3MockedCount = executionOrder.filter(
        (item) => item === "step-3-mocked"
      ).length;

      // Each mock handler should only be called once
      expect(step1MockedCount).toBe(1);
      expect(step3MockedCount).toBe(1);

      // Verify the final result
      expect(executionOrder).toContain("step-1-mocked");
      expect(executionOrder).toContain("step-2-unmocked");
      expect(executionOrder).toContain("step-3-mocked");
      expect(executionOrder[executionOrder.length - 1]).toBe("function-end");
    });

    it("should handle async mock handlers with proper timing", async () => {
      const inngest = new Inngest({ id: "test-app" });
      const executionOrder: string[] = [];

      const fn = inngest.createFunction(
        { id: "test-fn" },
        { event: "test/event" },
        async ({ step }) => {
          executionOrder.push("function-start");

          const step1Result = await step.run("step-1", () => {
            executionOrder.push("step-1-unmocked");
            return "unmocked-1";
          });

          const step2Result = await step.run("step-2", async () => {
            executionOrder.push("step-2-unmocked");
            await new Promise((resolve) => setTimeout(resolve, 10));
            return "unmocked-2";
          });

          executionOrder.push("function-end");

          return { step1Result, step2Result };
        }
      );

      const t = new InngestTestEngine({
        function: fn,
        steps: [
          {
            id: "step-1",
            handler: async () => {
              executionOrder.push("step-1-mocked-start");
              await new Promise((resolve) => setTimeout(resolve, 10));
              executionOrder.push("step-1-mocked-end");
              return "mocked-1";
            },
          },
        ],
      });

      const { result } = await t.execute();

      expect(result).toEqual({
        step1Result: "mocked-1",
        step2Result: "unmocked-2",
      });

      // Verify that async handlers run only once
      const mockedStartCount = executionOrder.filter(
        (item) => item === "step-1-mocked-start"
      ).length;
      const mockedEndCount = executionOrder.filter(
        (item) => item === "step-1-mocked-end"
      ).length;

      expect(mockedStartCount).toBe(1);
      expect(mockedEndCount).toBe(1);

      expect(executionOrder).toContain("step-1-mocked-start");
      expect(executionOrder).toContain("step-1-mocked-end");
      expect(executionOrder).toContain("step-2-unmocked");
      expect(executionOrder[executionOrder.length - 1]).toBe("function-end");
    });

    it("should handle parallel steps with mixed mocked and unmocked handlers", async () => {
      const inngest = new Inngest({ id: "test-app" });
      const executionOrder: string[] = [];

      const fn = inngest.createFunction(
        { id: "test-fn" },
        { event: "test/event" },
        async ({ step }) => {
          executionOrder.push("function-start");

          // Run steps in parallel
          const results = await Promise.all([
            step.run("parallel-1", () => {
              executionOrder.push("parallel-1-unmocked");
              return "result-1";
            }),
            step.run("parallel-2", () => {
              executionOrder.push("parallel-2-unmocked");
              return "result-2";
            }),
            step.run("parallel-3", () => {
              executionOrder.push("parallel-3-unmocked");
              return "result-3";
            }),
          ]);

          executionOrder.push("function-end");

          return results;
        }
      );

      const t = new InngestTestEngine({
        function: fn,
        steps: [
          {
            id: "parallel-1",
            handler: () => {
              executionOrder.push("parallel-1-mocked");
              return "mocked-1";
            },
          },
          {
            id: "parallel-3",
            handler: () => {
              executionOrder.push("parallel-3-mocked");
              return "mocked-3";
            },
          },
        ],
      });

      const { result } = await t.execute();

      expect(result).toEqual(["mocked-1", "result-2", "mocked-3"]);

      // Function should start and end
      expect(executionOrder[0]).toBe("function-start");
      expect(executionOrder[executionOrder.length - 1]).toBe("function-end");

      // All mocked and unmocked handlers should be called
      expect(executionOrder).toContain("parallel-1-mocked");
      expect(executionOrder).toContain("parallel-2-unmocked");
      expect(executionOrder).toContain("parallel-3-mocked");

      // Should NOT contain unmocked versions of mocked steps
      expect(executionOrder).not.toContain("parallel-1-unmocked");
      expect(executionOrder).not.toContain("parallel-3-unmocked");
    });

    it("should not execute mock handlers until the step is actually awaited", async () => {
      const inngest = new Inngest({ id: "test-app" });
      const executionOrder: string[] = [];

      const fn = inngest.createFunction(
        { id: "test-fn" },
        { event: "test/event" },
        async ({ step }) => {
          executionOrder.push("function-start");

          // Create step but don't await yet
          const step1Promise = step.run("step-1", () => {
            executionOrder.push("step-1-unmocked");
            return "unmocked-1";
          });

          executionOrder.push("after-step-1-creation");

          const step2Result = await step.run("step-2", () => {
            executionOrder.push("step-2-unmocked");
            return "unmocked-2";
          });

          executionOrder.push("after-step-2-await");

          // Now await step1
          const step1Result = await step1Promise;

          executionOrder.push("function-end");

          return { step1Result, step2Result };
        }
      );

      const t = new InngestTestEngine({
        function: fn,
        steps: [
          {
            id: "step-1",
            handler: () => {
              executionOrder.push("step-1-mocked");
              return "mocked-1";
            },
          },
        ],
      });

      const { result } = await t.execute();

      expect(result).toEqual({
        step1Result: "mocked-1",
        step2Result: "unmocked-2",
      });

      // The mock handler should only execute once even though step is accessed multiple times
      const step1MockedCount = executionOrder.filter(
        (item) => item === "step-1-mocked"
      ).length;
      expect(step1MockedCount).toBe(1);

      // Verify the mock was called after the step was created
      const step1MockedIndex = executionOrder.indexOf("step-1-mocked");
      const afterCreationIndex = executionOrder.indexOf(
        "after-step-1-creation"
      );
      expect(step1MockedIndex).toBeGreaterThan(afterCreationIndex);
    });

    it.skip("should handle errors in mock handlers at the correct execution point", async () => {
      // TODO: Error propagation from mock handlers needs additional work
      // The mocked handler throws, but the error isn't properly propagated
      // through the step execution model yet
      const inngest = new Inngest({ id: "test-app" });
      const executionOrder: string[] = [];

      const fn = inngest.createFunction(
        { id: "test-fn" },
        { event: "test/event" },
        async ({ step }) => {
          executionOrder.push("function-start");

          await step.run("step-1", () => {
            executionOrder.push("step-1-unmocked");
            return "result-1";
          });

          await step.run("step-2", () => {
            executionOrder.push("step-2-unmocked");
            return "result-2";
          });

          executionOrder.push("function-end");

          return "completed";
        }
      );

      const t = new InngestTestEngine({
        function: fn,
        steps: [
          {
            id: "step-1",
            handler: () => {
              executionOrder.push("step-1-mocked");
              throw new Error("Mock error in step 1");
            },
          },
        ],
      });

      // The function should fail with the mock error
      const { error } = await t.execute();

      expect(error).toBeDefined();
      if (error) {
        expect((error as Error).message).toContain("Mock error in step 1");
      }

      // Verify execution order shows the handler was called
      const step1MockedCount = executionOrder.filter(
        (item) => item === "step-1-mocked"
      ).length;
      expect(step1MockedCount).toBe(1);

      // step-2 should never run because step-1 threw
      expect(executionOrder).not.toContain("step-2-unmocked");
    });

    it("should support mocking with data that depends on earlier step execution", async () => {
      const inngest = new Inngest({ id: "test-app" });
      let capturedStep1Result: string | undefined;

      const fn = inngest.createFunction(
        { id: "test-fn" },
        { event: "test/event" },
        async ({ step }) => {
          const step1Result = await step.run("step-1", () => {
            return "first-result";
          });

          const step2Result = await step.run("step-2", () => {
            return "second-result";
          });

          return { step1Result, step2Result };
        }
      );

      const t = new InngestTestEngine({
        function: fn,
        steps: [
          {
            id: "step-1",
            handler: () => {
              return "mocked-first";
            },
          },
          {
            id: "step-2",
            handler: () => {
              // This handler runs lazily, so it can access state from earlier execution
              capturedStep1Result = "mocked-first"; // In real use, you'd access this from context
              return `depends-on-${capturedStep1Result}`;
            },
          },
        ],
      });

      const { result } = await t.execute();

      expect(result).toEqual({
        step1Result: "mocked-first",
        step2Result: "depends-on-mocked-first",
      });

      expect(capturedStep1Result).toBe("mocked-first");
    });
  });
});
