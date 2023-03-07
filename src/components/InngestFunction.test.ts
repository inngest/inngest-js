/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { jest } from "@jest/globals";
import { assertType } from "type-plus";
import { internalEvents } from "../helpers/consts";
import { ServerTiming } from "../helpers/ServerTiming";
import {
  EventPayload,
  FailureEventPayload,
  OpStack,
  StepOpCode,
} from "../types";
import { Inngest } from "./Inngest";
import { InngestFunction } from "./InngestFunction";
import { UnhashedOp, _internals } from "./InngestStepTools";

type TestEvents = {
  foo: { name: "foo"; data: { foo: string } };
  bar: { name: "bar"; data: { bar: string } };
  baz: { name: "baz"; data: { baz: string } };
};

const inngest = new Inngest<TestEvents>({
  name: "test",
  eventKey: "event-key-123",
});

const timer = new ServerTiming();

describe("#generateID", () => {
  it("Returns a correct name", () => {
    const fn = () =>
      new InngestFunction(
        new Inngest({ name: "test" }),
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
          let fn: InngestFunction<TestEvents, any, any>;
          let ret: Awaited<ReturnType<typeof fn["runFn"]>>;

          beforeAll(async () => {
            fn = new InngestFunction(
              new Inngest<TestEvents>({ name: "test" }),
              { name: "Foo" },
              { event: "foo" },
              flowFn
            );

            ret = await fn["runFn"](
              { event: { name: "foo", data: { foo: "foo" } } },
              [],
              null,
              timer
            );
          });

          test("returns is not op on success", () => {
            expect(ret[0]).toBe("complete");
          });

          test("returns data on success", () => {
            expect(ret[1]).toBe(stepRet);
          });
        });

        describe("throws", () => {
          const stepErr = new Error("step error");
          let fn: InngestFunction<TestEvents, any, any>;

          beforeAll(() => {
            fn = new InngestFunction(
              new Inngest<TestEvents>({ name: "test" }),
              { name: "Foo" },
              { event: "foo" },
              badFlowFn
            );
          });

          test("bubble thrown error", async () => {
            await expect(
              fn["runFn"](
                { event: { name: "foo", data: { foo: "foo" } } },
                [],
                null,
                timer
              )
            ).rejects.toThrow(stepErr);
          });
        });
      });
    });
  });

  describe("step functions", () => {
    const runFnWithStack = (
      fn: InngestFunction<any, any, any>,
      stack: OpStack,
      runStep?: string
    ) => {
      return fn["runFn"](
        { event: { name: "foo", data: {} } },
        stack,
        runStep || null,
        timer
      );
    };

    const getHashDataSpy = () => jest.spyOn(_internals, "hashData");

    const testFn = <
      T extends {
        fn: InngestFunction<any, any, any>;
        steps: Record<
          string,
          jest.Mock<() => string> | jest.Mock<() => Promise<string>>
        >;
      },
      U extends Record<keyof T["steps"], string>
    >(
      fnName: string,
      createTools: () => T,
      hashes: U,
      tests: (hashes: U) => Record<
        string,
        {
          stack?: OpStack;
          runStep?: string;
          expectedReturn: Awaited<ReturnType<typeof runFnWithStack>>;
          expectedHashOps?: UnhashedOp[];
          expectedStepsRun?: (keyof T["steps"])[];
        }
      >
    ) => {
      describe(fnName, () => {
        Object.entries(tests(hashes)).forEach(([name, t]) => {
          describe(name, () => {
            let hashDataSpy: ReturnType<typeof getHashDataSpy>;
            let tools: T;
            let ret: Awaited<ReturnType<typeof runFnWithStack>>;

            beforeAll(async () => {
              hashDataSpy = getHashDataSpy();
              tools = createTools();
              ret = await runFnWithStack(tools.fn, t.stack || [], t.runStep);
            });

            test("returns expected value", () => {
              expect(ret).toEqual(t.expectedReturn);
            });

            if (t.expectedHashOps?.length) {
              test("hashes expected ops", () => {
                t.expectedHashOps?.forEach((h) => {
                  expect(hashDataSpy).toHaveBeenCalledWith(h);
                });
              });
            }

            test("runs expected steps", () => {
              Object.keys(tools.steps).forEach((k) => {
                const step = tools.steps[k];

                if (t.expectedStepsRun?.includes(k)) {
                  expect(step).toHaveBeenCalled();
                } else {
                  expect(step).not.toHaveBeenCalled();
                }
              });
            });
          });
        });
      });
    };

    testFn(
      "simple A to B",
      () => {
        const A = jest.fn(() => "A");
        const B = jest.fn(() => "B");

        const fn = inngest.createFunction(
          "name",
          "foo",
          async ({ tools: { run } }) => {
            await run("A", A);
            await run("B", B);
          }
        );

        return { fn, steps: { A, B } };
      },
      {
        A: "c0a4028e0b48a2eeff383fa7186fd2d3763f5412",
        B: "b494def3936f5c59986e81bc29443609bfc2384a",
      },
      ({ A, B }) => ({
        "first run reports A step": {
          expectedReturn: [
            "discovery",
            [
              expect.objectContaining({
                id: A,
                name: "A",
                op: StepOpCode.StepPlanned,
              }),
            ],
          ],
        },
        "requesting to run A runs A": {
          runStep: A,
          expectedReturn: [
            "run",
            expect.objectContaining({
              id: A,
              name: "A",
              op: StepOpCode.RunStep,
              data: "A",
            }),
          ],
          expectedStepsRun: ["A"],
        },
        "request with A in stack reports B step": {
          stack: [
            {
              id: A,
              data: "A",
            },
          ],
          expectedReturn: [
            "discovery",
            [
              expect.objectContaining({
                id: B,
                name: "B",
                op: StepOpCode.StepPlanned,
              }),
            ],
          ],
        },
        "requesting to run B runs B": {
          stack: [
            {
              id: A,
              data: "A",
            },
          ],
          runStep: B,
          expectedReturn: [
            "run",
            expect.objectContaining({
              id: B,
              name: "B",
              op: StepOpCode.RunStep,
              data: "B",
            }),
          ],
          expectedStepsRun: ["B"],
        },
        "final request returns empty response": {
          stack: [
            {
              id: A,
              data: "A",
            },
            {
              id: B,
              data: "B",
            },
          ],
          expectedReturn: ["complete", undefined],
        },
      })
    );

    testFn(
      "change path based on data",
      () => {
        const A = jest.fn(() => "A");
        const B = jest.fn(() => "B");

        const fn = inngest.createFunction(
          "name",
          "foo",
          async ({ tools: { waitForEvent, run } }) => {
            const foo = await waitForEvent("foo", "2h");

            if (foo?.data.foo === "foo") {
              await run("A", A);
            } else if (foo?.data.foo === "bar") {
              await run("B", B);
            }
          }
        );

        return { fn, steps: { A, B } };
      },
      {
        foo: "715347facf54baa82ad66dafed5ed6f1f84eaf8a",
        A: "cfae9b35319fd155051a76b9208840185cecdc07",
        B: "1352bc51e5732952742e6d103747c954c16570f5",
      },
      ({ foo, A, B }) => ({
        "first run reports waitForEvent": {
          expectedReturn: [
            "discovery",
            [
              expect.objectContaining({
                op: StepOpCode.WaitForEvent,
                name: "foo",
                id: foo,
              }),
            ],
          ],
        },
        "request with event foo.data.foo:foo reports A step": {
          stack: [{ id: foo, data: { data: { foo: "foo" } } }],
          expectedReturn: [
            "discovery",
            [
              expect.objectContaining({
                id: A,
                name: "A",
                op: StepOpCode.StepPlanned,
              }),
            ],
          ],
        },
        "requesting to run A runs A": {
          stack: [{ id: foo, data: { data: { foo: "foo" } } }],
          runStep: A,
          expectedReturn: [
            "run",
            expect.objectContaining({
              id: A,
              name: "A",
              op: StepOpCode.RunStep,
              data: "A",
            }),
          ],
          expectedStepsRun: ["A"],
        },
        "request with event foo.data.foo:bar reports B step": {
          stack: [{ id: foo, data: { data: { foo: "bar" } } }],
          expectedReturn: [
            "discovery",
            [
              expect.objectContaining({
                id: B,
                name: "B",
                op: StepOpCode.StepPlanned,
              }),
            ],
          ],
        },
        "requesting to run B runs B": {
          stack: [{ id: foo, data: { data: { foo: "bar" } } }],
          runStep: B,
          expectedReturn: [
            "run",
            expect.objectContaining({
              id: B,
              name: "B",
              op: StepOpCode.RunStep,
              data: "B",
            }),
          ],
          expectedStepsRun: ["B"],
        },
        "final request returns empty response": {
          stack: [
            {
              id: foo,
              data: { data: { foo: "bar" } },
            },
            {
              id: B,
              data: "B",
            },
          ],
          expectedReturn: ["complete", undefined],
        },
      })
    );

    testFn(
      "Promise.all",
      () => {
        const A = jest.fn(() => "A");
        const B = jest.fn(() => "B");
        const C = jest.fn(() => "C");

        const fn = inngest.createFunction(
          "name",
          "foo",
          async ({ tools: { run } }) => {
            await Promise.all([run("A", A), run("B", B)]);
            await run("C", C);
          }
        );

        return { fn, steps: { A, B, C } };
      },
      {
        A: "c0a4028e0b48a2eeff383fa7186fd2d3763f5412",
        B: "1b724c1e706194ce9fa9aa57c0fb1c5075c7f7f4",
        C: "b9996145f3de0c6073d3526ec18bb73be43e8bd6",
      },
      ({ A, B, C }) => ({
        "first run reports A and B steps": {
          expectedReturn: [
            "discovery",
            [
              expect.objectContaining({
                id: A,
                name: "A",
                op: StepOpCode.StepPlanned,
              }),
              expect.objectContaining({
                id: B,
                name: "B",
                op: StepOpCode.StepPlanned,
              }),
            ],
          ],
        },

        "requesting to run B runs B": {
          runStep: B,
          expectedReturn: [
            "run",
            expect.objectContaining({
              id: B,
              name: "B",
              op: StepOpCode.RunStep,
              data: "B",
            }),
          ],
          expectedStepsRun: ["B"],
        },

        "request following B returns empty response": {
          stack: [
            {
              id: B,
              data: "B",
            },
          ],
          expectedReturn: ["discovery", []],
        },

        "requesting to run A runs A": {
          runStep: A,
          expectedReturn: [
            "run",
            expect.objectContaining({
              id: A,
              name: "A",
              op: StepOpCode.RunStep,
              data: "A",
            }),
          ],
          expectedStepsRun: ["A"],
        },

        "request with B,A order reports C step": {
          stack: [
            {
              id: B,
              data: "B",
            },
            {
              id: A,
              data: "A",
            },
          ],
          expectedReturn: [
            "discovery",
            [
              expect.objectContaining({
                id: C,
                name: "C",
                op: StepOpCode.StepPlanned,
              }),
            ],
          ],
        },

        "requesting to run C runs C": {
          runStep: C,
          stack: [
            {
              id: B,
              data: "B",
            },
            {
              id: A,
              data: "A",
            },
          ],
          expectedReturn: [
            "run",
            expect.objectContaining({
              id: C,
              name: "C",
              op: StepOpCode.RunStep,
              data: "C",
            }),
          ],
          expectedStepsRun: ["C"],
        },

        "final request returns empty response": {
          stack: [
            {
              id: B,
              data: "B",
            },
            {
              id: A,
              data: "A",
            },
            {
              id: C,
              data: "C",
            },
          ],
          expectedReturn: ["complete", undefined],
        },
      })
    );

    testFn(
      "Promise.race",
      () => {
        const A = jest.fn(() => Promise.resolve("A"));
        const B = jest.fn(() => Promise.resolve("B"));
        const AWins = jest.fn(() => Promise.resolve("A wins"));
        const BWins = jest.fn(() => Promise.resolve("B wins"));

        const fn = inngest.createFunction(
          "name",
          "foo",
          async ({ tools: { run } }) => {
            const winner = await Promise.race([run("A", A), run("B", B)]);

            if (winner === "A") {
              await run("A wins", AWins);
            } else if (winner === "B") {
              await run("B wins", BWins);
            }
          }
        );

        return { fn, steps: { A, B, AWins, BWins } };
      },
      {
        A: "c0a4028e0b48a2eeff383fa7186fd2d3763f5412",
        B: "1b724c1e706194ce9fa9aa57c0fb1c5075c7f7f4",
        AWins: "",
        BWins: "bfdc2902cd708525bec677c1ad15fffff4bdccca",
      },
      ({ A, B, BWins }) => ({
        "first run reports A and B steps": {
          expectedReturn: [
            "discovery",
            [
              expect.objectContaining({
                id: A,
                name: "A",
                op: StepOpCode.StepPlanned,
              }),
              expect.objectContaining({
                id: B,
                name: "B",
                op: StepOpCode.StepPlanned,
              }),
            ],
          ],
        },

        "requesting to run B runs B": {
          runStep: B,
          expectedReturn: [
            "run",
            expect.objectContaining({
              id: B,
              name: "B",
              op: StepOpCode.RunStep,
              data: "B",
            }),
          ],
          expectedStepsRun: ["B"],
        },

        "request following B reports 'B wins' step": {
          stack: [
            {
              id: B,
              data: "B",
            },
          ],
          expectedReturn: [
            "discovery",
            [
              expect.objectContaining({
                id: BWins,
                name: "B wins",
                op: StepOpCode.StepPlanned,
              }),
            ],
          ],
        },

        "requesting to run A runs A": {
          runStep: A,
          expectedReturn: [
            "run",
            expect.objectContaining({
              id: A,
              name: "A",
              op: StepOpCode.RunStep,
              data: "A",
            }),
          ],
          expectedStepsRun: ["A"],
        },

        "request following A returns empty response": {
          stack: [
            {
              id: B,
              data: "B",
            },
            {
              id: A,
              data: "A",
            },
          ],
          expectedReturn: ["discovery", []],
        },

        "requesting to run 'B wins' runs 'B wins'": {
          runStep: BWins,
          stack: [
            {
              id: B,
              data: "B",
            },
          ],
          expectedReturn: [
            "run",
            expect.objectContaining({
              id: BWins,
              name: "B wins",
              op: StepOpCode.RunStep,
              data: "B wins",
            }),
          ],
          expectedStepsRun: ["BWins"],
        },
      })
    );

    testFn(
      "silently handle step error",
      () => {
        const A = jest.fn(() => "A");
        const B = jest.fn(() => {
          throw "B";
        });
        const BFailed = jest.fn(() => "B failed");

        const fn = inngest.createFunction(
          "name",
          "foo",
          async ({ tools: { run } }) => {
            return Promise.all([
              run("A", A),
              run("B", B).catch(() => run("B failed", BFailed)),
            ]);
          }
        );

        return { fn, steps: { A, B, BFailed } };
      },
      {
        A: "c0a4028e0b48a2eeff383fa7186fd2d3763f5412",
        B: "1b724c1e706194ce9fa9aa57c0fb1c5075c7f7f4",
        BFailed: "0ccca8a0c6463bcf972afb233f1f0baa47d90cc3",
      },
      ({ A, B, BFailed }) => ({
        "first run reports A and B steps": {
          expectedReturn: [
            "discovery",
            [
              expect.objectContaining({
                id: A,
                name: "A",
                op: StepOpCode.StepPlanned,
              }),
              expect.objectContaining({
                id: B,
                name: "B",
                op: StepOpCode.StepPlanned,
              }),
            ],
          ],
        },

        "requesting to run A runs A": {
          runStep: A,
          expectedReturn: [
            "run",
            expect.objectContaining({
              id: A,
              name: "A",
              op: StepOpCode.RunStep,
              data: "A",
            }),
          ],
          expectedStepsRun: ["A"],
        },

        "request following A returns empty response": {
          stack: [{ id: A, data: "A" }],
          expectedReturn: ["discovery", []],
        },

        "requesting to run B runs B, which fails": {
          runStep: B,
          expectedReturn: [
            "run",
            expect.objectContaining({
              id: B,
              name: "B",
              op: StepOpCode.RunStep,
              error: "B",
            }),
          ],
          expectedStepsRun: ["B"],
        },

        "request following B reports 'B failed' step": {
          stack: [
            { id: A, data: "A" },
            { id: B, error: "B" },
          ],
          expectedReturn: [
            "discovery",
            [
              expect.objectContaining({
                id: BFailed,
                name: "B failed",
                op: StepOpCode.StepPlanned,
              }),
            ],
          ],
        },

        "requesting to run 'B failed' runs 'B failed'": {
          runStep: BFailed,
          stack: [
            { id: A, data: "A" },
            { id: B, error: "B" },
          ],
          expectedReturn: [
            "run",
            expect.objectContaining({
              id: BFailed,
              name: "B failed",
              op: StepOpCode.RunStep,
              data: "B failed",
            }),
          ],
          expectedStepsRun: ["BFailed"],
        },

        "final request returns empty response": {
          stack: [
            { id: A, data: "A" },
            { id: B, error: "B" },
            { id: BFailed, data: "B failed" },
          ],
          expectedReturn: ["complete", ["A", "B failed"]],
        },
      })
    );
  });

  describe("onFailure functions", () => {
    describe("types", () => {
      describe("no custom types", () => {
        const inngest = new Inngest({ name: "test" });

        test("onFailure function has unknown internal event", () => {
          inngest.createFunction(
            { name: "test" },
            { event: "test" },
            () => {
              // no-op
            },
            ({ event }) => {
              assertType<`${internalEvents.FunctionFailed}`>(event.name);
              assertType<FailureEventPayload<EventPayload>>(event);
            }
          );
        });
      });

      describe("multiple custom types", () => {
        const inngest = new Inngest<{
          foo: {
            name: "foo";
            data: { title: string };
          };
          bar: {
            name: "bar";
            data: { message: string };
          };
        }>({ name: "test" });

        test("onFailure function has known internal event", () => {
          inngest.createFunction(
            { name: "test" },
            { event: "foo" },
            () => {
              // no-op
            },
            ({ event }) => {
              assertType<`${internalEvents.FunctionFailed}`>(event.name);
              assertType<FailureEventPayload<EventPayload>>(event);

              assertType<"foo">(event.data.event.name);
              assertType<EventPayload>(event.data.event);
              assertType<{ title: string }>(event.data.event.data);
            }
          );
        });
      });
    });

    test("specifying an onFailure function registers correctly", () => {
      const inngest = new Inngest<{
        foo: {
          name: "foo";
          data: { title: string };
        };
        bar: {
          name: "bar";
          data: { message: string };
        };
      }>({ name: "test" });

      const fn = inngest.createFunction(
        { name: "test" },
        { event: "foo" },
        () => {
          // no-op
        },
        () => {
          // no-op
        }
      );

      expect(fn).toBeInstanceOf(InngestFunction);

      const exampleUrl = new URL("https://example.com");

      const [fnConfig, failureFnConfig] = fn["getConfig"](exampleUrl);

      expect(fnConfig).toMatchObject({
        id: "test",
        name: "test",
        steps: {
          [InngestFunction.stepId]: {
            id: InngestFunction.stepId,
            name: InngestFunction.stepId,
            runtime: {
              type: "http",
              url: `https://example.com/?fnId=test&stepId=${InngestFunction.stepId}`,
            },
          },
        },
        triggers: [{ event: "foo" }],
      });

      expect(failureFnConfig).toMatchObject({
        id: "test-failure",
        name: "test (failure)",
        steps: {
          [InngestFunction.stepId]: {
            id: InngestFunction.stepId,
            name: InngestFunction.stepId,
            runtime: {
              type: "http",
              url: `https://example.com/?fnId=test-failure&stepId=${InngestFunction.stepId}`,
            },
          },
        },
        triggers: [
          {
            event: internalEvents.FunctionFailed,
            expression: "async.data.function_id == 'test'",
          },
        ],
      });
    });
  });

  describe("cancellation", () => {
    describe("types", () => {
      describe("no custom types", () => {
        const inngest = new Inngest({ name: "test" });

        test("allows any event name", () => {
          inngest.createFunction(
            { name: "test", cancelOn: [{ event: "anything" }] },
            { event: "test" },
            () => {
              // no-op
            }
          );
        });

        test("allows any match", () => {
          inngest.createFunction(
            {
              name: "test",
              cancelOn: [{ event: "anything", match: "data.anything" }],
            },
            { event: "test" },
            () => {
              // no-op
            }
          );
        });
      });

      describe("multiple custom types", () => {
        const inngest = new Inngest<{
          foo: {
            name: "foo";
            data: { title: string; foo: string };
          };
          bar: {
            name: "bar";
            data: { message: string; bar: string };
          };
          baz: {
            name: "baz";
            data: { title: string; baz: string };
          };
          qux: {
            name: "qux";
            data: { title: string; qux: string };
          };
        }>({ name: "test" });

        test("disallows unknown event name", () => {
          inngest.createFunction(
            // @ts-expect-error Unknown event name
            { name: "test", cancelOn: [{ event: "unknown" }] },
            { event: "foo" },
            () => {
              // no-op
            }
          );
        });

        test("allows known event name", () => {
          inngest.createFunction(
            { name: "test", cancelOn: [{ event: "bar" }] },
            { event: "foo" },
            () => {
              // no-op
            }
          );
        });

        test("disallows known event name with bad field match", () => {
          inngest.createFunction(
            {
              name: "test",
              // @ts-expect-error Unknown match field
              cancelOn: [{ event: "bar", match: "data.title" }],
            },
            { event: "foo" },
            () => {
              // no-op
            }
          );
        });

        test("allows known event name with good field match", () => {
          inngest.createFunction(
            {
              name: "test",
              cancelOn: [{ event: "baz", match: "data.title" }],
            },
            { event: "foo" },
            () => {
              // no-op
            }
          );
        });
      });
    });

    test("specifying a cancellation event registers correctly", () => {
      const inngest = new Inngest<{
        foo: {
          name: "foo";
          data: { title: string };
        };
        bar: {
          name: "bar";
          data: { message: string };
        };
        baz: {
          name: "baz";
          data: { title: string };
        };
      }>({ name: "test" });

      const fn = inngest.createFunction(
        { name: "test", cancelOn: [{ event: "baz", match: "data.title" }] },
        { event: "foo" },
        () => {
          // no-op
        }
      );

      const [fnConfig] = fn["getConfig"](new URL("https://example.com"));

      expect(fnConfig).toMatchObject({
        id: "test",
        name: "test",
        steps: {
          [InngestFunction.stepId]: {
            id: InngestFunction.stepId,
            name: InngestFunction.stepId,
            runtime: {
              type: "http",
              url: `https://example.com/?fnId=test&stepId=${InngestFunction.stepId}`,
            },
          },
        },
        triggers: [{ event: "foo" }],
        cancel: [{ event: "baz", if: "event.data.title == async.data.title" }],
      });
    });
  });
});
