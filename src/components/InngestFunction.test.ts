/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { jest } from "@jest/globals";
import { OpStack, StepOpCode } from "../types";
import { Inngest } from "./Inngest";
import { InngestFunction } from "./InngestFunction";

type TestEvents = {
  foo: { name: "foo"; data: { foo: string } };
  bar: { name: "bar"; data: { bar: string } };
  baz: { name: "baz"; data: { baz: string } };
};

const inngest = new Inngest<TestEvents>({
  name: "test",
  eventKey: "event-key-123",
});

describe("#generateID", () => {
  it("Returns a correct name", () => {
    const fn = () =>
      new InngestFunction(
        { name: "HELLO 👋 there mr Wolf 🥳!" },
        { event: "test/event.name" },
        () => undefined
      );
    expect(fn().id("MY MAGIC APP 🥳!")).toEqual(
      "my-magic-app-hello-there-mr-wolf"
    );
    expect(fn().id()).toEqual("hello-there-mr-wolf");
  });
});

describe("runFn", () => {
  describe("single-step function", () => {
    const stepRet = "step done";
    const stepErr = new Error("step error");

    [
      {
        type: "synchronous",
        flowFn: () => stepRet,
        badFlowFn: () => {
          throw stepErr;
        },
      },
      {
        type: "asynchronous",
        flowFn: () =>
          new Promise((resolve) => setTimeout(() => resolve(stepRet))),
        badFlowFn: () =>
          new Promise((_, reject) => setTimeout(() => reject(stepErr))),
      },
    ].forEach(({ type, flowFn, badFlowFn }) => {
      describe(`${type} function`, () => {
        describe("success", () => {
          let fn: InngestFunction<TestEvents>;
          let ret: Awaited<ReturnType<typeof fn["runFn"]>>;

          beforeAll(async () => {
            fn = new InngestFunction<TestEvents>(
              { name: "Foo" },
              { event: "foo" },
              flowFn
            );

            ret = await fn["runFn"](
              { event: { name: "foo", data: { foo: "foo" } } },
              []
            );
          });

          test("returns is not op on success", () => {
            expect(ret[0]).toBe("single");
          });

          test("returns data on success", () => {
            expect(ret[1]).toBe(stepRet);
          });
        });

        describe("throws", () => {
          const stepErr = new Error("step error");
          let fn: InngestFunction<TestEvents>;

          beforeAll(() => {
            fn = new InngestFunction<TestEvents>(
              { name: "Foo" },
              { event: "foo" },
              badFlowFn
            );
          });

          test("bubble thrown error", async () => {
            await expect(
              fn["runFn"]({ event: { name: "foo", data: { foo: "foo" } } }, [])
            ).rejects.toThrow(stepErr);
          });
        });
      });
    });
  });

  describe("multi-step functions", () => {
    const runFnWithStack = (fn: InngestFunction<any>, stack: OpStack) => {
      return fn["runFn"]({ event: { name: "foo", data: {} } }, stack);
    };

    describe("simple A to B", () => {
      const createFn = () => {
        const stepA = jest.fn(() => "A");
        const stepB = jest.fn(() => "B");

        const fn = inngest.createFunction(
          "name",
          "foo",
          async ({ tools: { run } }) => {
            await run("A", stepA);
            await run("B", stepB);
          }
        );

        return { fn, stepA, stepB };
      };

      let tools: ReturnType<typeof createFn>;

      beforeEach(() => {
        tools = createFn();
      });

      test("first run reports A step", async () => {
        const ret = await runFnWithStack(tools.fn, []);

        expect(ret).toEqual([
          "multi-discovery",
          [
            expect.objectContaining({
              name: "A",
              op: StepOpCode.RunStep,
              run: true,
              opPosition: [0],
            }),
          ],
        ]);
        expect(tools.stepA).not.toHaveBeenCalled();
        expect(tools.stepB).not.toHaveBeenCalled();
      });

      test("requesting to run A runs A", async () => {
        const ret = await runFnWithStack(tools.fn, [
          {
            id: "",
            run: true,
            opPosition: [0],
          },
        ]);

        expect(ret).toEqual(["multi-run", { data: "A" }]);
        expect(tools.stepA).toHaveBeenCalledTimes(1);
        expect(tools.stepB).not.toHaveBeenCalled();
      });

      test("request with A in stack reports B step", async () => {
        const ret = await runFnWithStack(tools.fn, [
          {
            id: "",
            data: "A",
            opPosition: [0],
          },
        ]);

        expect(ret).toEqual([
          "multi-discovery",
          [
            expect.objectContaining({
              name: "B",
              op: StepOpCode.RunStep,
              run: true,
              opPosition: [0, 0],
            }),
          ],
        ]);
        expect(tools.stepA).not.toHaveBeenCalled();
        expect(tools.stepB).not.toHaveBeenCalled();
      });

      test("requesting to run B runs B", async () => {
        const ret = await runFnWithStack(tools.fn, [
          {
            id: "",
            data: "A",
            opPosition: [0],
          },
          {
            id: "",
            run: true,
            opPosition: [0, 0],
          },
        ]);

        expect(ret).toEqual(["multi-run", { data: "B" }]);
        expect(tools.stepA).not.toHaveBeenCalled();
        expect(tools.stepB).toHaveBeenCalledTimes(1);
      });

      test("final request returns empty response", async () => {
        const ret = await runFnWithStack(tools.fn, [
          {
            id: "",
            data: "A",
            opPosition: [0],
          },
          {
            id: "",
            data: "B",
            opPosition: [0, 0],
          },
        ]);

        expect(ret).toEqual(["multi-discovery", []]);
        expect(tools.stepA).not.toHaveBeenCalled();
        expect(tools.stepB).not.toHaveBeenCalled();
      });
    });

    describe("change path based on data", () => {
      const createFn = () => {
        const stepA = jest.fn(() => "A");
        const stepB = jest.fn(() => "B");

        const fn = inngest.createFunction(
          "name",
          "foo",
          async ({ tools: { waitForEvent, run } }) => {
            const foo = await waitForEvent("foo", "2h");

            if (foo?.data.foo === "foo") {
              await run("A", stepA);
            } else if (foo?.data.foo === "bar") {
              await run("B", stepB);
            }
          }
        );

        return { fn, stepA, stepB };
      };

      let tools: ReturnType<typeof createFn>;
      beforeEach(() => {
        tools = createFn();
      });

      test("first run reports waitForEvent", async () => {
        const ret = await runFnWithStack(tools.fn, []);

        expect(ret).toEqual([
          "multi-discovery",
          [
            expect.objectContaining({
              name: "foo",
              op: StepOpCode.WaitForEvent,
              opPosition: [0],
            }),
          ],
        ]);
        expect(tools.stepA).not.toHaveBeenCalled();
        expect(tools.stepB).not.toHaveBeenCalled();
      });

      test("request with event foo.data.foo:foo reports A step", async () => {
        const ret = await runFnWithStack(tools.fn, [
          {
            id: "",
            data: { data: { foo: "foo" } },
            opPosition: [0],
          },
        ]);

        expect(ret).toEqual([
          "multi-discovery",
          [
            expect.objectContaining({
              name: "A",
              op: StepOpCode.RunStep,
              run: true,
              opPosition: [0, 0],
            }),
          ],
        ]);
        expect(tools.stepA).not.toHaveBeenCalled();
        expect(tools.stepB).not.toHaveBeenCalled();
      });

      test("requesting to run A runs A", async () => {
        const ret = await runFnWithStack(tools.fn, [
          {
            id: "",
            data: { data: { foo: "foo" } },
            opPosition: [0],
          },
          {
            id: "",
            run: true,
            opPosition: [0, 0],
          },
        ]);

        expect(ret).toEqual(["multi-run", { data: "A" }]);
        expect(tools.stepA).toHaveBeenCalledTimes(1);
        expect(tools.stepB).not.toHaveBeenCalled();
      });

      test("request with event foo.data.foo:bar reports B step", async () => {
        const ret = await runFnWithStack(tools.fn, [
          {
            id: "",
            data: { data: { foo: "bar" } },
            opPosition: [0],
          },
        ]);

        expect(ret).toEqual([
          "multi-discovery",
          [
            expect.objectContaining({
              name: "B",
              op: StepOpCode.RunStep,
              run: true,
              opPosition: [0, 0],
            }),
          ],
        ]);
        expect(tools.stepA).not.toHaveBeenCalled();
        expect(tools.stepB).not.toHaveBeenCalled();
      });

      test("requesting to run B runs B", async () => {
        const ret = await runFnWithStack(tools.fn, [
          {
            id: "",
            data: { data: { foo: "bar" } },
            opPosition: [0],
          },
          {
            id: "",
            run: true,
            opPosition: [0, 0],
          },
        ]);

        expect(ret).toEqual(["multi-run", { data: "B" }]);
        expect(tools.stepA).not.toHaveBeenCalled();
        expect(tools.stepB).toHaveBeenCalledTimes(1);
      });

      test("final request returns empty response", async () => {
        const ret = await runFnWithStack(tools.fn, [
          {
            id: "",
            data: { data: { foo: "bar" } },
            opPosition: [0],
          },
          {
            id: "",
            data: "B",
            opPosition: [0, 0],
          },
        ]);

        expect(ret).toEqual(["multi-discovery", []]);
        expect(tools.stepA).not.toHaveBeenCalled();
        expect(tools.stepB).not.toHaveBeenCalled();
      });
    });

    describe("Promise.all", () => {
      const createFn = () => {
        const stepA = jest.fn(() => "A");
        const stepB = jest.fn(() => "B");
        const stepC = jest.fn(() => "C");

        const fn = inngest.createFunction(
          "name",
          "foo",
          async ({ tools: { run } }) => {
            await Promise.all([run("A", stepA), run("B", stepB)]);
            await run("C", stepC);
          }
        );

        return { fn, stepA, stepB, stepC };
      };

      let tools: ReturnType<typeof createFn>;
      beforeEach(() => {
        tools = createFn();
      });

      test("first run reports A and B steps", async () => {
        const ret = await runFnWithStack(tools.fn, []);

        expect(ret).toEqual([
          "multi-discovery",
          [
            expect.objectContaining({
              name: "A",
              op: StepOpCode.RunStep,
              run: true,
              opPosition: [0],
            }),
            expect.objectContaining({
              name: "B",
              op: StepOpCode.RunStep,
              run: true,
              opPosition: [1],
            }),
          ],
        ]);
        expect(tools.stepA).not.toHaveBeenCalled();
        expect(tools.stepB).not.toHaveBeenCalled();
        expect(tools.stepC).not.toHaveBeenCalled();
      });

      test("requesting to run B runs B", async () => {
        const ret = await runFnWithStack(tools.fn, [
          {
            id: "",
            run: true,
            opPosition: [1],
          },
        ]);

        expect(ret).toEqual(["multi-run", { data: "B" }]);
        expect(tools.stepA).not.toHaveBeenCalled();
        expect(tools.stepB).toHaveBeenCalledTimes(1);
        expect(tools.stepC).not.toHaveBeenCalled();
      });

      test("request following B returns empty response", async () => {
        const ret = await runFnWithStack(tools.fn, [
          {
            id: "",
            data: "B",
            opPosition: [1],
          },
        ]);

        expect(ret).toEqual(["multi-discovery", []]);
        expect(tools.stepA).not.toHaveBeenCalled();
        expect(tools.stepB).not.toHaveBeenCalled();
        expect(tools.stepC).not.toHaveBeenCalled();
      });

      test("requesting to run A runs A", async () => {
        const ret = await runFnWithStack(tools.fn, [
          {
            id: "",
            run: true,
            opPosition: [0],
          },
        ]);

        expect(ret).toEqual(["multi-run", { data: "A" }]);
        expect(tools.stepA).toHaveBeenCalledTimes(1);
        expect(tools.stepB).not.toHaveBeenCalled();
        expect(tools.stepC).not.toHaveBeenCalled();
      });

      test("request with B,A order reports C step", async () => {
        const ret = await runFnWithStack(tools.fn, [
          {
            id: "",
            data: "B",
            opPosition: [1],
          },
          {
            id: "",
            data: "A",
            opPosition: [0],
          },
        ]);

        expect(ret).toEqual([
          "multi-discovery",
          [
            expect.objectContaining({
              name: "C",
              op: StepOpCode.RunStep,
              run: true,
              opPosition: [0, 0],
            }),
          ],
        ]);
        expect(tools.stepA).not.toHaveBeenCalled();
        expect(tools.stepB).not.toHaveBeenCalled();
        expect(tools.stepC).not.toHaveBeenCalled();
      });

      test("requesting to run C runs C", async () => {
        const ret = await runFnWithStack(tools.fn, [
          {
            id: "",
            data: "B",
            opPosition: [1],
          },
          {
            id: "",
            data: "A",
            opPosition: [0],
          },
          {
            id: "",
            run: true,
            opPosition: [0, 0],
          },
        ]);

        expect(ret).toEqual(["multi-run", { data: "C" }]);
        expect(tools.stepA).not.toHaveBeenCalled();
        expect(tools.stepB).not.toHaveBeenCalled();
        expect(tools.stepC).toHaveBeenCalledTimes(1);
      });

      test("final request returns empty response", async () => {
        const ret = await runFnWithStack(tools.fn, [
          {
            id: "",
            data: "B",
            opPosition: [1],
          },
          {
            id: "",
            data: "A",
            opPosition: [0],
          },
          {
            id: "",
            data: "C",
            opPosition: [0, 0],
          },
        ]);

        expect(ret).toEqual(["multi-discovery", []]);
        expect(tools.stepA).not.toHaveBeenCalled();
        expect(tools.stepB).not.toHaveBeenCalled();
        expect(tools.stepC).not.toHaveBeenCalled();
      });
    });

    describe("Promise.race", () => {
      const createFn = () => {
        const stepA = jest.fn(() => Promise.resolve("A"));
        const stepB = jest.fn(() => Promise.resolve("B"));
        const stepAWins = jest.fn(() => Promise.resolve("A wins"));
        const stepBWins = jest.fn(() => Promise.resolve("B wins"));

        const fn = inngest.createFunction(
          "name",
          "foo",
          async ({ tools: { run } }) => {
            const winner = await Promise.race([
              run("A", stepA),
              run("B", stepB),
            ]);

            if (winner === "A") {
              await run("A wins", stepAWins);
            } else if (winner === "B") {
              await run("B wins", stepBWins);
            }
          }
        );

        return { fn, stepA, stepB, stepAWins, stepBWins };
      };

      test("first run reports A and B steps", async () => {
        const tools = createFn();

        const ret = await runFnWithStack(tools.fn, []);

        expect(ret).toEqual([
          "multi-discovery",
          [
            expect.objectContaining({
              name: "A",
              op: StepOpCode.RunStep,
              run: true,
              opPosition: [0],
            }),
            expect.objectContaining({
              name: "B",
              op: StepOpCode.RunStep,
              run: true,
              opPosition: [1],
            }),
          ],
        ]);
        expect(tools.stepA).not.toHaveBeenCalled();
        expect(tools.stepB).not.toHaveBeenCalled();
        expect(tools.stepAWins).not.toHaveBeenCalled();
        expect(tools.stepBWins).not.toHaveBeenCalled();
      });

      test("requesting to run B runs B", async () => {
        const tools = createFn();

        const ret = await runFnWithStack(tools.fn, [
          {
            id: "",
            run: true,
            opPosition: [1],
          },
        ]);

        expect(ret).toEqual(["multi-run", { data: "B" }]);
        expect(tools.stepA).not.toHaveBeenCalled();
        expect(tools.stepB).toHaveBeenCalledTimes(1);
        expect(tools.stepAWins).not.toHaveBeenCalled();
        expect(tools.stepBWins).not.toHaveBeenCalled();
      });

      test("request following B reports 'B wins' step", async () => {
        const tools = createFn();

        const ret = await runFnWithStack(tools.fn, [
          {
            id: "",
            data: "B",
            opPosition: [1],
          },
        ]);

        expect(ret).toEqual([
          "multi-discovery",
          [
            expect.objectContaining({
              name: "B wins",
              op: StepOpCode.RunStep,
              run: true,
              opPosition: [1, 0],
            }),
          ],
        ]);
        expect(tools.stepA).not.toHaveBeenCalled();
        expect(tools.stepB).not.toHaveBeenCalled();
        expect(tools.stepAWins).not.toHaveBeenCalled();
        expect(tools.stepBWins).not.toHaveBeenCalled();
      });

      test("requesting to run A runs A", async () => {
        const tools = createFn();

        const ret = await runFnWithStack(tools.fn, [
          {
            id: "",
            run: true,
            opPosition: [0],
          },
        ]);

        expect(ret).toEqual(["multi-run", { data: "A" }]);
        expect(tools.stepA).toHaveBeenCalledTimes(1);
        expect(tools.stepB).not.toHaveBeenCalled();
        expect(tools.stepAWins).not.toHaveBeenCalled();
        expect(tools.stepBWins).not.toHaveBeenCalled();
      });

      test("request following A returns empty response", async () => {
        const tools = createFn();

        const ret = await runFnWithStack(tools.fn, [
          {
            id: "",
            data: "B",
            opPosition: [1],
          },
          {
            id: "",
            data: "A",
            opPosition: [0],
          },
        ]);

        expect(ret).toEqual(["multi-discovery", []]);
        expect(tools.stepA).not.toHaveBeenCalled();
        expect(tools.stepB).not.toHaveBeenCalled();
        expect(tools.stepAWins).not.toHaveBeenCalled();
        expect(tools.stepBWins).not.toHaveBeenCalled();
      });

      test("requesting to run 'B wins' runs 'B wins'", async () => {
        const tools = createFn();

        const ret = await runFnWithStack(tools.fn, [
          {
            id: "",
            data: "B",
            opPosition: [1],
          },
          {
            id: "",
            run: true,
            opPosition: [1, 0],
          },
        ]);

        expect(ret).toEqual(["multi-run", { data: "B wins" }]);
        expect(tools.stepA).not.toHaveBeenCalled();
        expect(tools.stepB).not.toHaveBeenCalled();
        expect(tools.stepAWins).not.toHaveBeenCalled();
        expect(tools.stepBWins).toHaveBeenCalledTimes(1);
      });

      test("final request returns empty response", async () => {
        const tools = createFn();

        const ret = await runFnWithStack(tools.fn, [
          {
            id: "",
            data: "B",
            opPosition: [1],
          },
          {
            id: "",
            data: "A",
            opPosition: [0],
          },
          {
            id: "",
            data: "B wins",
            opPosition: [1, 0],
          },
        ]);

        expect(ret).toEqual(["multi-discovery", []]);
        expect(tools.stepA).not.toHaveBeenCalled();
        expect(tools.stepB).not.toHaveBeenCalled();
        expect(tools.stepAWins).not.toHaveBeenCalled();
        expect(tools.stepBWins).not.toHaveBeenCalled();
      });
    });

    // B has a catch
    describe("silently handle step error", () => {
      const createFn = () => {
        const stepA = jest.fn(() => "A");
        const stepB = jest.fn(() => {
          throw "B";
        });
        const stepBFailed = jest.fn(() => "B failed");

        const fn = inngest.createFunction(
          "name",
          "foo",
          async ({ tools: { run } }) => {
            await Promise.all([
              run("A", stepA),
              run("B", stepB).catch(() => run("B failed", stepBFailed)),
            ]);
          }
        );

        return { fn, stepA, stepB, stepBFailed };
      };

      let tools: ReturnType<typeof createFn>;
      beforeEach(() => {
        tools = createFn();
      });

      test("first run reports A and B steps", async () => {
        const ret = await runFnWithStack(tools.fn, []);

        expect(ret).toEqual([
          "multi-discovery",
          [
            expect.objectContaining({
              name: "A",
              op: StepOpCode.RunStep,
              run: true,
              opPosition: [0],
            }),
            expect.objectContaining({
              name: "B",
              op: StepOpCode.RunStep,
              run: true,
              opPosition: [1],
            }),
          ],
        ]);
        expect(tools.stepA).not.toHaveBeenCalled();
        expect(tools.stepB).not.toHaveBeenCalled();
        expect(tools.stepBFailed).not.toHaveBeenCalled();
      });

      test("requesting to run A runs A", async () => {
        const ret = await runFnWithStack(tools.fn, [
          {
            id: "",
            run: true,
            opPosition: [0],
          },
        ]);

        expect(ret).toEqual(["multi-run", { data: "A" }]);
        expect(tools.stepA).toHaveBeenCalledTimes(1);
        expect(tools.stepB).not.toHaveBeenCalled();
        expect(tools.stepBFailed).not.toHaveBeenCalled();
      });

      test("request following A returns empty response", async () => {
        const ret = await runFnWithStack(tools.fn, [
          {
            id: "",
            data: "A",
            opPosition: [0],
          },
        ]);

        expect(ret).toEqual(["multi-discovery", []]);
        expect(tools.stepA).not.toHaveBeenCalled();
        expect(tools.stepB).not.toHaveBeenCalled();
        expect(tools.stepBFailed).not.toHaveBeenCalled();
      });

      test("requesting to run B runs B, which fails", async () => {
        const ret = await runFnWithStack(tools.fn, [
          {
            id: "",
            run: true,
            opPosition: [1],
          },
        ]);

        expect(ret).toEqual(["multi-run", { error: "B" }]);
        expect(tools.stepA).not.toHaveBeenCalled();
        expect(tools.stepB).toHaveBeenCalledTimes(1);
        expect(tools.stepBFailed).not.toHaveBeenCalled();
      });

      test("request following B reports 'B failed' step", async () => {
        const ret = await runFnWithStack(tools.fn, [
          {
            id: "",
            data: "A",
            opPosition: [0],
          },
          {
            id: "",
            error: "B",
            opPosition: [1],
          },
        ]);

        expect(ret).toEqual([
          "multi-discovery",
          [
            expect.objectContaining({
              name: "B failed",
              op: StepOpCode.RunStep,
              run: true,
              opPosition: [1, 0],
            }),
          ],
        ]);
        expect(tools.stepA).not.toHaveBeenCalled();
        expect(tools.stepB).not.toHaveBeenCalled();
        expect(tools.stepBFailed).not.toHaveBeenCalled();
      });

      test("requesting to run 'B failed' runs 'B failed'", async () => {
        const ret = await runFnWithStack(tools.fn, [
          {
            id: "",
            data: "A",
            opPosition: [0],
          },
          {
            id: "",
            error: "B",
            opPosition: [1],
          },
          {
            id: "",
            run: true,
            opPosition: [1, 0],
          },
        ]);

        expect(ret).toEqual(["multi-run", { data: "B failed" }]);
        expect(tools.stepA).not.toHaveBeenCalled();
        expect(tools.stepB).not.toHaveBeenCalled();
        expect(tools.stepBFailed).toHaveBeenCalledTimes(1);
      });

      test("final request returns empty response", async () => {
        const ret = await runFnWithStack(tools.fn, [
          {
            id: "",
            data: "A",
            opPosition: [0],
          },
          {
            id: "",
            error: "B",
            opPosition: [1],
          },
          {
            id: "",
            data: "B failed",
            opPosition: [1, 0],
          },
        ]);

        expect(ret).toEqual(["multi-discovery", []]);
        expect(tools.stepA).not.toHaveBeenCalled();
        expect(tools.stepB).not.toHaveBeenCalled();
        expect(tools.stepBFailed).not.toHaveBeenCalled();
      });
    });
  });
});
