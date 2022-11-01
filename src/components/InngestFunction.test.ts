/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { jest } from "@jest/globals";
import { StepOpCode, SyncStepFn } from "../types";
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
              []
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
              fn["runFn"]({ event: { name: "foo", data: { foo: "foo" } } }, [])
            ).rejects.toThrow(stepErr);
          });
        });
      });
    });
  });

  describe("multi-step functions", () => {
    const createFn = () => {
      const event: TestEvents["foo"] = { name: "foo", data: { foo: "foo" } };
      const step1Ret = "step1 done";
      const step3Ret = "step3 done";
      const step1 = jest.fn(() => step1Ret);
      const step2 = jest.fn();

      const step3 = jest.fn(
        () =>
          new Promise<string>((resolve) =>
            setTimeout(() => resolve(step3Ret), 200)
          )
      );

      const stepFn: SyncStepFn<TestEvents, "foo", string, string> = ({
        tools: { step, waitForEvent },
      }) => {
        const event2 = waitForEvent("bar");

        if (event2.data.bar === "baz") {
          step("step1", step1);
        }

        const event3 = waitForEvent("baz", {
          timeout: "2d",
        });

        if (!event3) {
          step("step2", step2);
        }

        step("step3", step3);
      };

      const fn = new InngestFunction<TestEvents>(
        { name: "Foo" },
        { event: "foo" },
        stepFn
      );

      return { fn, step1Ret, step1, step2, step3Ret, step3, event };
    };

    describe("waitForEvent bar", () => {
      let tools: ReturnType<typeof createFn>;
      let ret: Awaited<ReturnType<InngestFunction<TestEvents>["runFn"]>>;

      beforeAll(async () => {
        tools = createFn();
        ret = await tools.fn["runFn"]({ event: tools.event }, []);
      });

      test("returns isOp true", () => {
        expect(ret[0]).toBe(true);
      });

      test("returns bar event request data", () => {
        expect(ret[1]).toEqual({
          op: StepOpCode.WaitForEvent,
          id: "bar",
        });
      });
    });

    describe("maybe run step1", () => {
      describe("data matches", () => {
        let tools: ReturnType<typeof createFn>;
        let ret: Awaited<ReturnType<InngestFunction<TestEvents>["runFn"]>>;

        beforeAll(async () => {
          tools = createFn();
          ret = await tools.fn["runFn"]({ event: tools.event }, [
            {
              op: StepOpCode.WaitForEvent,
              id: "bar",
              data: { name: "bar", data: { bar: "baz" } },
            },
          ]);
        });

        test("returns isOp true", () => {
          expect(ret[0]).toBe(true);
        });

        test("run step", () => {
          expect(tools.step1).toHaveBeenCalledTimes(1);
        });

        test("return step data", () => {
          expect(ret[1]).toEqual({
            op: StepOpCode.RunStep,
            id: "step1",
            data: tools.step1Ret,
          });
        });
      });

      describe("data doesn't match", () => {
        let tools: ReturnType<typeof createFn>;
        let ret: Awaited<ReturnType<InngestFunction<TestEvents>["runFn"]>>;

        beforeAll(async () => {
          tools = createFn();
          ret = await tools.fn["runFn"]({ event: tools.event }, [
            {
              op: StepOpCode.WaitForEvent,
              id: "bar",
              data: { name: "bar", data: { bar: "not baz" } },
            },
          ]);
        });

        test("returns isOp true", () => {
          expect(ret[0]).toBe(true);
        });

        test("skip step", () => {
          expect(tools.step1).toHaveBeenCalledTimes(0);
        });
      });
    });

    describe("waitForEvent baz with timeout", () => {
      let tools: ReturnType<typeof createFn>;
      let ret: Awaited<ReturnType<InngestFunction<TestEvents>["runFn"]>>;

      beforeAll(async () => {
        tools = createFn();
        ret = await tools.fn["runFn"]({ event: tools.event }, [
          {
            op: StepOpCode.WaitForEvent,
            id: "bar",
            data: { name: "bar", data: { bar: "baz" } },
          },
          {
            op: StepOpCode.RunStep,
            id: "step1",
            data: tools.step1Ret,
          },
        ]);
      });

      test("returns isOp true", () => {
        expect(ret[0]).toBe(true);
      });

      test("returns event request data", () => {
        expect(ret[1]).toEqual({
          op: StepOpCode.WaitForEvent,
          id: "baz",
          opts: {
            timeout: "2d",
          },
        });
      });
    });

    describe("maybe run step2", () => {
      describe("event found", () => {
        let tools: ReturnType<typeof createFn>;
        let ret: Awaited<ReturnType<InngestFunction<TestEvents>["runFn"]>>;

        beforeAll(async () => {
          tools = createFn();
          ret = await tools.fn["runFn"]({ event: tools.event }, [
            {
              op: StepOpCode.WaitForEvent,
              id: "bar",
              data: { name: "bar", data: { bar: "baz" } },
            },
            {
              op: StepOpCode.RunStep,
              id: "step1",
              data: tools.step1Ret,
            },
            {
              op: StepOpCode.WaitForEvent,
              id: "baz",
              opts: {
                timeout: "2d",
              },
              data: { name: "baz", data: { baz: "baz" } },
            },
          ]);
        });

        test("returns isOp true", () => {
          expect(ret[0]).toBe(true);
        });

        test("skip step", () => {
          expect(tools.step2).toHaveBeenCalledTimes(0);
        });
      });

      describe("event not found", () => {
        let tools: ReturnType<typeof createFn>;
        let ret: Awaited<ReturnType<InngestFunction<TestEvents>["runFn"]>>;

        beforeAll(async () => {
          tools = createFn();
          ret = await tools.fn["runFn"]({ event: tools.event }, [
            {
              op: StepOpCode.WaitForEvent,
              id: "bar",
              data: { name: "bar", data: { bar: "baz" } },
            },
            {
              op: StepOpCode.RunStep,
              id: "step1",
              data: tools.step1Ret,
            },
            {
              op: StepOpCode.WaitForEvent,
              id: "baz",
              opts: {
                timeout: "2d",
              },
              data: null,
            },
          ]);
        });

        test("returns isOp true", () => {
          expect(ret[0]).toBe(true);
        });

        test("run step", () => {
          expect(tools.step2).toHaveBeenCalledTimes(1);
        });
      });
    });

    describe("run async step3", () => {
      let tools: ReturnType<typeof createFn>;
      let ret: Awaited<ReturnType<InngestFunction<TestEvents>["runFn"]>>;

      beforeAll(async () => {
        tools = createFn();
        ret = await tools.fn["runFn"]({ event: tools.event }, [
          {
            op: StepOpCode.WaitForEvent,
            id: "bar",
            data: { name: "bar", data: { bar: "baz" } },
          },
          {
            op: StepOpCode.RunStep,
            id: "step1",
            data: tools.step1Ret,
          },

          {
            op: StepOpCode.WaitForEvent,
            id: "baz",
            opts: {
              timeout: "2d",
            },
            data: { name: "baz", data: { baz: "baz" } },
          },
        ]);
      });

      test("returns isOp true", () => {
        expect(ret[0]).toBe(true);
      });

      test("run step", () => {
        expect(tools.step3).toHaveBeenCalledTimes(1);
      });

      test("step returns data", () => {
        expect(ret[1]).toEqual({
          op: StepOpCode.RunStep,
          id: "step3",
          data: tools.step3Ret,
        });
      });
    });

    describe("final run", () => {
      let tools: ReturnType<typeof createFn>;
      let ret: Awaited<ReturnType<InngestFunction<TestEvents>["runFn"]>>;

      beforeAll(async () => {
        tools = createFn();
        ret = await tools.fn["runFn"]({ event: tools.event }, [
          {
            op: StepOpCode.WaitForEvent,
            id: "bar",
            data: { name: "bar", data: { bar: "baz" } },
          },
          {
            op: StepOpCode.RunStep,
            id: "step1",
            data: tools.step1Ret,
          },
          {
            op: StepOpCode.WaitForEvent,
            id: "baz",
            opts: {
              timeout: "2d",
            },
            data: { name: "baz", data: { baz: "baz" } },
          },
          {
            op: StepOpCode.RunStep,
            id: "step3",
            data: tools.step3Ret,
          },
        ]);
      });

      test("returns isOp false", () => {
        expect(ret[0]).toBe(false);
      });

      test("returns void data", () => {
        expect(ret[1]).toBeUndefined();
      });
    });
  });
});
