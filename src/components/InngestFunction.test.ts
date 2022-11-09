/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { jest } from "@jest/globals";
import { MultiStepFn, OpStack, StepOpCode } from "../types";
import { InngestFunction } from "./InngestFunction";

type TestEvents = {
  foo: { name: "foo"; data: { foo: string } };
  bar: { name: "bar"; data: { bar: string } };
  baz: { name: "baz"; data: { baz: string } };
};

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
              {}
            );
          });

          test("returns is not op on success", () => {
            expect(ret[0]).toBe(false);
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
              fn["runFn"]({ event: { name: "foo", data: { foo: "foo" } } }, {})
            ).rejects.toThrow(stepErr);
          });
        });
      });
    });
  });

  describe("multi-step functions", () => {
    const step1Ret = "step1 done";
    const step3Ret = "step3 done";

    const createFn = () => {
      const event: TestEvents["foo"] = { name: "foo", data: { foo: "foo" } };
      const step1 = jest.fn(() => step1Ret);
      const step2 = jest.fn();
      const step3 = jest.fn(
        () =>
          new Promise<string>((resolve) =>
            setTimeout(() => resolve(step3Ret), 200)
          )
      );

      // Create a step function to test SDK handling various state inputs.
      const stepFn: MultiStepFn<TestEvents, "foo", string, string> = ({
        tools: { run, waitForEvent },
      }) => {
        const stepres = [];
        const firstWaitForEvent = waitForEvent("bar", { timeout: "5 minutes" });
        if (firstWaitForEvent?.data.bar === "baz") {
          const data = run("step1", step1);
          stepres.push(data);
        }

        const secondWaitForEvent = waitForEvent("baz", {
          timeout: "2d",
        });
        if (!secondWaitForEvent) {
          const data = run("step2", step2);
          stepres.push(data);
        }

        const data = run("step3", step3);
        stepres.push(data);
        return { stepres };
      };

      const fn = new InngestFunction<TestEvents>(
        { name: "Foo" },
        { event: "foo" },
        stepFn
      );

      return { fn, step1Ret, step1, step2, step3Ret, step3, event };
    };

    // runFuncWith is a helper to run the above step function given stack data.
    // It returns the step function tools and function response.
    const runFuncWith = async (
      input: OpStack = {}
    ): Promise<
      [
        ReturnType<typeof createFn>,
        Awaited<ReturnType<InngestFunction<TestEvents>["runFn"]>>
      ]
    > => {
      const tools: ReturnType<typeof createFn> = createFn();
      const ret: Awaited<ReturnType<InngestFunction<TestEvents>["runFn"]>> =
        await tools.fn["runFn"]({ event: tools.event }, input);
      return [tools, ret];
    };

    // These represent hashes for each step in the above step function
    const hashes = {
      firstWaitForEvent: "ad7a92c7c23670ab7fb94a6f2dda2ae7d8c34b39",
      step1: "375be344ee59a2b013ef35d909ac84b23136c732",
      secondWaitForEvent: "c0fe3f23240c37a0a5b7287ba74be64b4a5d5f06",
      step2: "3bff481d2c96dbbf8680d4f824c32882d109e8da",
      step3: "88a0e46b054ef061bc4ed598be3ae22be87fdd2d",
    };

    describe("waitForEvent bar", () => {
      let tools: ReturnType<typeof createFn>;
      let ret: Awaited<ReturnType<InngestFunction<TestEvents>["runFn"]>>;

      beforeAll(async () => {
        [tools, ret] = await runFuncWith({});
      });

      test("with no input data returns isOp true", () => {
        expect(ret[0]).toBe(true);
      });

      test("with no input data returns correct opcode", () => {
        expect(ret[1]).toEqual({
          op: StepOpCode.WaitForEvent,
          name: "bar",
          opts: { ttl: "5m" },
          id: hashes.firstWaitForEvent,
        });
      });

      test("should not have run any steps", () => {
        expect(tools.step1).not.toHaveBeenCalled();
        expect(tools.step2).not.toHaveBeenCalled();
        expect(tools.step3).not.toHaveBeenCalled();
      });
    });

    describe("maybe run step1", () => {
      describe("if wait for event data matches", () => {
        let tools: ReturnType<typeof createFn>;
        let ret: Awaited<ReturnType<InngestFunction<TestEvents>["runFn"]>>;

        beforeAll(async () => {
          [tools, ret] = await runFuncWith({
            [hashes.firstWaitForEvent]: {
              name: "bar",
              data: { bar: "baz" },
            },
          });
        });

        test("returns isOp true", () => {
          expect(ret[0]).toBe(true);
        });

        test("should run the first step's tool", () => {
          expect(tools.step1).toHaveBeenCalledTimes(1);
        });

        test("should not have run any other steps", () => {
          expect(tools.step2).toHaveBeenCalledTimes(0);
          expect(tools.step3).toHaveBeenCalledTimes(0);
        });

        test("should return step1 opcode data", () => {
          expect(ret[1]).toEqual({
            op: StepOpCode.RunStep,
            name: "step1",
            data: tools.step1Ret,
            id: hashes.step1,
          });
        });
      });

      describe("data doesn't match", () => {
        let tools: ReturnType<typeof createFn>;
        let ret: Awaited<ReturnType<InngestFunction<TestEvents>["runFn"]>>;

        beforeAll(async () => {
          [tools, ret] = await runFuncWith({
            [hashes.firstWaitForEvent]: {
              name: "bar",
              data: { bar: "not baz" },
            },
          });
        });

        test("returns isOp true", () => {
          expect(ret[0]).toBe(true);
        });

        test("should not call step 1", () => {
          expect(tools.step1).toHaveBeenCalledTimes(0);
        });

        test("should not have run any other steps", () => {
          expect(tools.step2).toHaveBeenCalledTimes(0);
          expect(tools.step3).toHaveBeenCalledTimes(0);
        });
      });
    });

    describe("waitForEvent baz with timeout", () => {
      let tools: ReturnType<typeof createFn>;
      let ret: Awaited<ReturnType<InngestFunction<TestEvents>["runFn"]>>;

      beforeAll(async () => {
        [tools, ret] = await runFuncWith({
          [hashes.firstWaitForEvent]: {
            name: "bar",
            data: { bar: "baz" },
          },
          [hashes.step1]: step1Ret,
        });
      });

      test("returns isOp true", () => {
        expect(ret[0]).toBe(true);
      });

      test("should not have run any steps", () => {
        expect(tools.step1).toHaveBeenCalledTimes(0);
        expect(tools.step2).toHaveBeenCalledTimes(0);
        expect(tools.step3).toHaveBeenCalledTimes(0);
      });

      test("returns event request data", () => {
        expect(ret[1]).toEqual({
          op: StepOpCode.WaitForEvent,
          name: "baz",
          opts: {
            ttl: "2d",
          },
          id: hashes.secondWaitForEvent,
        });
      });
    });

    describe("maybe run step2", () => {
      describe("event found", () => {
        let tools: ReturnType<typeof createFn>;
        let ret: Awaited<ReturnType<InngestFunction<TestEvents>["runFn"]>>;

        beforeAll(async () => {
          [tools, ret] = await runFuncWith({
            [hashes.firstWaitForEvent]: {
              name: "bar",
              data: { bar: "baz" },
            },
            [hashes.step1]: step1Ret,
            [hashes.secondWaitForEvent]: {
              name: "baz",
              data: { baz: "baz" },
            },
          });
        });

        test("returns isOp true", () => {
          expect(ret[0]).toBe(true);
        });

        test("skips step 2, which runs if secondWaitForEvent is null", () => {
          expect(tools.step2).toHaveBeenCalledTimes(0);
        });

        test("should not have run any previous steps", () => {
          expect(tools.step1).toHaveBeenCalledTimes(0);
        });
      });

      describe("event not found", () => {
        let tools: ReturnType<typeof createFn>;
        let ret: Awaited<ReturnType<InngestFunction<TestEvents>["runFn"]>>;

        beforeAll(async () => {
          [tools, ret] = await runFuncWith({
            [hashes.firstWaitForEvent]: {
              name: "bar",
              data: { bar: "baz" },
            },
            [hashes.step1]: step1Ret,
            [hashes.secondWaitForEvent]: null,
          });
        });

        test("returns isOp true", () => {
          expect(ret[0]).toBe(true);
        });

        test("runs step 2", () => {
          expect(tools.step2).toHaveBeenCalledTimes(1);
        });

        test("should not have run any other steps", () => {
          expect(tools.step1).toHaveBeenCalledTimes(0);
          expect(tools.step3).toHaveBeenCalledTimes(0);
        });

        test("step returns data", () => {
          expect(ret[1]).toEqual({
            op: StepOpCode.RunStep,
            name: "step2",
            data: undefined,
            id: hashes.step2,
          });
        });
      });
    });

    describe("run async step3", () => {
      let tools: ReturnType<typeof createFn>;
      let ret: Awaited<ReturnType<InngestFunction<TestEvents>["runFn"]>>;

      beforeAll(async () => {
        [tools, ret] = await runFuncWith({
          [hashes.firstWaitForEvent]: {
            name: "bar",
            data: { bar: "baz" },
          },
          [hashes.step1]: step1Ret,
          [hashes.secondWaitForEvent]: { name: "baz", data: { baz: "baz" } },
        });
      });

      test("returns isOp true", () => {
        expect(ret[0]).toBe(true);
      });

      test("run step", () => {
        expect(tools.step3).toHaveBeenCalledTimes(1);
      });

      test("should not have run any other steps", () => {
        expect(tools.step1).toHaveBeenCalledTimes(0);
        expect(tools.step2).toHaveBeenCalledTimes(0);
      });

      test("step returns data", () => {
        expect(ret[1]).toEqual({
          op: StepOpCode.RunStep,
          name: "step3",
          data: tools.step3Ret,
          id: hashes.step3,
        });
      });
    });

    describe("final run", () => {
      let tools: ReturnType<typeof createFn>;
      let ret: Awaited<ReturnType<InngestFunction<TestEvents>["runFn"]>>;

      beforeAll(async () => {
        [tools, ret] = await runFuncWith({
          [hashes.firstWaitForEvent]: {
            name: "bar",
            data: { bar: "baz" },
          },
          [hashes.step1]: step1Ret,
          [hashes.secondWaitForEvent]: { name: "baz", data: { baz: "baz" } },
          [hashes.step3]: step3Ret,
        });
      });

      test("returns isOp false", () => {
        expect(ret[0]).toBe(false);
      });

      test("should not have run any steps", () => {
        expect(tools.step1).toHaveBeenCalledTimes(0);
        expect(tools.step2).toHaveBeenCalledTimes(0);
        expect(tools.step3).toHaveBeenCalledTimes(0);
      });

      test("returns function data", () => {
        expect(ret[1]).toEqual({ stepres: [step1Ret, step3Ret] });
      });
    });
  });
});
