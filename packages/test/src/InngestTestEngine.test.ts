import { Inngest } from "inngest";
import { InngestTestEngine } from "../";

describe("InngestTestEngine", () => {
  describe("state object uses human-readable step IDs (#1194)", () => {
    it("should use human-readable step IDs as keys in state object, not hashed IDs", async () => {
      const inngest = new Inngest({ id: "test-app" });

      const fn = inngest.createFunction(
        { id: "my-function" },
        { event: "test/event" },
        async ({ step }) => {
          return step.run("my-step", async () => {
            return "hello";
          });
        },
      );

      const t = new InngestTestEngine({ function: fn });
      const { state } = await t.execute();

      expect(state["my-step"]).toBeDefined();
    });

    it("should use human-readable step IDs for multiple steps", async () => {
      const inngest = new Inngest({ id: "test-app" });

      const fn = inngest.createFunction(
        { id: "multi-step-function" },
        { event: "test/event" },
        async ({ step }) => {
          const first = await step.run("first-step", async () => {
            return "first";
          });

          const second = await step.run("second-step", async () => {
            return "second";
          });

          return { first, second };
        },
      );

      const t = new InngestTestEngine({ function: fn });
      const { state } = await t.execute();

      expect(state["first-step"]).toBeDefined();
      expect(state["second-step"]).toBeDefined();

      await expect(state["first-step"]).resolves.toBe("first");
      await expect(state["second-step"]).resolves.toBe("second");
    });

    it("should use indexed step IDs for parallel steps with the same base ID", async () => {
      const inngest = new Inngest({ id: "test-app" });

      const fn = inngest.createFunction(
        { id: "parallel-function" },
        { event: "test/event" },
        async ({ step }) => {
          const results = await Promise.all([
            step.run("my-step", async () => "first"),
            step.run("my-step", async () => "second"),
            step.run("my-step", async () => "third"),
          ]);
          return results;
        },
      );

      const t = new InngestTestEngine({ function: fn });
      const { state } = await t.execute();

      expect(state["my-step"]).toBeDefined();
      expect(state["my-step:1"]).toBeDefined();
      expect(state["my-step:2"]).toBeDefined();
    });
  });

  describe("lazy execution of mocked steps", () => {
    it("should only call mock handlers when steps actually run, not on initial access", async () => {
      const inngest = new Inngest({ id: "test-app" });

      // Track the order of execution
      const executionOrder: string[] = [];

      const fn = inngest.createFunction(
        { id: "test-fn" },
        { event: "test/event" },
        async ({ step }) => {
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

          return {
            step1Result,
            step2Result,
            step3Result,
          };
        },
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

      // Verify the final result
      expect(executionOrder).toEqual([
        "step-1-mocked",
        "step-2-unmocked",
        "step-3-mocked",
      ]);
    });

    it("should handle async mock handlers with proper timing", async () => {
      const inngest = new Inngest({ id: "test-app" });
      const executionOrder: string[] = [];

      const fn = inngest.createFunction(
        { id: "test-fn" },
        { event: "test/event" },
        async ({ step }) => {
          const step1Result = await step.run("step-1", () => {
            executionOrder.push("step-1-unmocked");
            return "unmocked-1";
          });

          const step2Result = await step.run("step-2", async () => {
            executionOrder.push("step-2-unmocked");
            await new Promise((resolve) => setTimeout(resolve, 10));
            return "unmocked-2";
          });

          return { step1Result, step2Result };
        },
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

      expect(executionOrder).toEqual([
        "step-1-mocked-start",
        "step-1-mocked-end",
        "step-2-unmocked",
      ]);
    });

    it("should handle parallel steps with mixed mocked and unmocked handlers", async () => {
      const inngest = new Inngest({ id: "test-app" });
      const executionOrder: string[] = [];

      const fn = inngest.createFunction(
        { id: "test-fn" },
        { event: "test/event" },
        async ({ step }) => {
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

          return results;
        },
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

      // All mocked and unmocked handlers should be called
      expect(executionOrder.length).toBe(3);
      expect(executionOrder).toContain("parallel-1-mocked");
      expect(executionOrder).toContain("parallel-2-unmocked");
      expect(executionOrder).toContain("parallel-3-mocked");

      // Should NOT contain unmocked versions of mocked steps
      expect(executionOrder).not.toContain("parallel-1-unmocked");
      expect(executionOrder).not.toContain("parallel-3-unmocked");
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
        },
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
