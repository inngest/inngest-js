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

      // All mocked and unmocked handlers should be called
      expect(executionOrder.length).toBe(3);
      expect(executionOrder).toContain("parallel-1-mocked");
      expect(executionOrder).toContain("parallel-2-unmocked");
      expect(executionOrder).toContain("parallel-3-mocked");

      // Should NOT contain unmocked versions of mocked steps
      expect(executionOrder).not.toContain("parallel-1-unmocked");
      expect(executionOrder).not.toContain("parallel-3-unmocked");
    });

    describe("should support mocking with data that depends on earlier step execution", () => {
      const inngest = new Inngest({ id: "test-app" });

      const fn = inngest.createFunction(
        { id: "test-fn" },
        { event: "test/event" },
        async ({ step }) => {
          const step1Result = await step.run("step-1", () => {
            return 1;
          });

          const step2Result = await step.run(
            "step-2",
            (input) => {
              return input + 2;
            },
            step1Result + 1,
          );

          return { step1Result, step2Result };
        },
      );

      it("works without any mocked steps", async () => {
        const t = new InngestTestEngine({
          function: fn,
        });

        const { result } = await t.execute();

        expect(result).toEqual({
          step1Result: 1,
          step2Result: 4,
        });
      });

      it("works when step-1 is mocked (so step-2 reads from a mocked output)", async () => {
        const t = new InngestTestEngine({
          function: fn,
          steps: [
            {
              id: "step-1",
              handler: () => {
                return 4;
              },
            },
          ],
        });

        const { result } = await t.execute();

        expect(result).toEqual({
          step1Result: 4,
          step2Result: 7,
        });
      });

      it("works when step-2 is mocked, reading from the real step-1 ", async () => {
        const t = new InngestTestEngine({
          function: fn,
          steps: [
            {
              id: "step-2",
              handler: (input) => {
                return input + 3;
              },
            },
          ],
        });

        const { result } = await t.execute();

        expect(result).toEqual({
          step1Result: 1,
          step2Result: 5,
        });
      });

      it("when both steps are mocked", async () => {
        const t = new InngestTestEngine({
          function: fn,
          steps: [
            {
              id: "step-1",
              handler: () => {
                return 4;
              },
            },
            {
              id: "step-2",
              handler: (input) => {
                return input + 3;
              },
            },
          ],
        });

        const { result } = await t.execute();

        expect(result).toEqual({
          step1Result: 4,
          step2Result: 8,
        });
      });
    });
  });

  describe("InngestTestEngine state with clone", () => {
    const inngest = new Inngest({
      id: "test",
    });

    it("clone immediately after new doesn't share any state", async () => {
      const myFunction = inngest.createFunction(
        { id: "add-numbers" },
        { event: "test/add" },
        async ({ event, step }) => {
          const firstResult = await step.run("add-one", () => {
            return event.data.value + 1;
          });

          const secondResult = await step.run("add-two", () => {
            return (firstResult as number) + 2;
          });

          return secondResult;
        },
      );

      const t = new InngestTestEngine({
        function: myFunction,
      });
      const t2 = t.clone();

      const { result, error, state } = await t.execute({
        events: [{ name: "test/add", data: { value: 5 } }],
      });

      expect(error).toBeUndefined();
      await expect(state["add-one"]).resolves.toEqual(6); // 5 + 1
      await expect(state["add-two"]).resolves.toEqual(8); // 6 + 2
      expect(result).toEqual(8); // 5 + 1 + 2 = 8

      const {
        result: result2,
        error: error2,
        state: state2,
      } = await t2.execute({
        events: [{ name: "test/add", data: { value: 7 } }],
      });

      expect(error2).toBeUndefined();
      await expect(state2["add-one"]).resolves.toEqual(8); // 7 + 1
      await expect(state2["add-two"]).resolves.toEqual(10); // 8 + 2

      expect(result2).toEqual(10); // 7 + 1 + 2 = 10
    });

    describe("non deterministic steps", () => {
      const myFunction = inngest.createFunction(
        { id: "two-random-numbers" },
        { event: "test/random" },
        async ({ step }) => {
          const firstResult = await step.run("random-one", () => {
            return Math.random();
          });

          const secondResult = await step.run("random-two", () => {
            return Math.random();
          });

          return {
            firstResult,
            secondResult
          };
        },
      );

      it("also doesn't share state", async () => {
        const t = new InngestTestEngine({
          function: myFunction,
        });
        const t2 = t.clone();

        const { result, error, state } = await t.execute()
        expect(error).toBeUndefined();

        const { result: result2, error: error2, state: state2 } = await t2.execute();
        expect(error2).toBeUndefined();

        expect(result2).not.toEqual(result);
        await expect(state2["random-one"]).resolves.not.toEqual(await state["random-one"]);
        await expect(state2["random-two"]).resolves.not.toEqual(await state["random-two"]);
      });

      it("executing a single step before clone shares just the state of that step", async () => {
        const t = new InngestTestEngine({
          function: myFunction,
        });
        // execute a single step before cloning
        await t.executeStep("random-one");
        const t2 = t.clone();

        // resume both test engines to completion
        const { result, error, state } = await t.execute();
        expect(error).toBeUndefined();

        const { result: result2, error: error2, state: state2, } = await t2.execute();
        expect(error2).toBeUndefined();

        expect(result2).not.toEqual(result);
        // First step state (before clone) should be the same, but not the second
        await expect(state2["random-one"]).resolves.toEqual(await state["random-one"]);
        await expect(state2["random-two"]).resolves.not.toEqual(await state["random-two"]);
      });
    });
  });
});
