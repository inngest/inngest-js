import { jest } from "@jest/globals";
import { InngestFunction } from "@local/components/InngestFunction";
import {
  _internals,
  type UnhashedOp,
} from "@local/components/InngestStepTools";
import { internalEvents } from "@local/helpers/consts";
import { ServerTiming } from "@local/helpers/ServerTiming";
import {
  StepOpCode,
  type EventPayload,
  type FailureEventPayload,
  type OpStack,
} from "@local/types";
import { assertType } from "type-plus";
import { createClient } from "../test/helpers";

type TestEvents = {
  foo: { name: "foo"; data: { foo: string } };
  bar: { name: "bar"; data: { bar: string } };
  baz: { name: "baz"; data: { baz: string } };
};

const inngest = createClient<TestEvents>({
  name: "test",
  eventKey: "event-key-123",
});

const timer = new ServerTiming();

describe("#generateID", () => {
  it("Returns a correct name", () => {
    const fn = () =>
      new InngestFunction(
        createClient({ name: "test" }),
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
          let ret: Awaited<ReturnType<(typeof fn)["runFn"]>>;

          beforeAll(async () => {
            fn = new InngestFunction(
              createClient<TestEvents>({ name: "test" }),
              { name: "Foo" },
              { event: "foo" },
              flowFn
            );

            ret = await fn["runFn"](
              { event: { name: "foo", data: { foo: "foo" } } },
              [],
              null,
              timer,
              false
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
          let fn: InngestFunction<TestEvents>;

          beforeAll(() => {
            fn = new InngestFunction(
              createClient<TestEvents>({ name: "test" }),
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
                timer,
                false
              )
            ).rejects.toThrow(stepErr);
          });
        });
      });
    });
  });

  describe("step functions", () => {
    const runFnWithStack = (
      fn: InngestFunction,
      stack: OpStack,
      opts?: {
        runStep?: string;
        onFailure?: boolean;
        event?: EventPayload;
      }
    ) => {
      return fn["runFn"](
        { event: opts?.event || { name: "foo", data: {} } },
        stack,
        opts?.runStep || null,
        timer,
        Boolean(opts?.onFailure)
      );
    };

    const getHashDataSpy = () => jest.spyOn(_internals, "hashData");

    const testFn = <
      T extends {
        fn: InngestFunction;
        steps: Record<
          string,
          jest.Mock<() => string> | jest.Mock<() => Promise<string>>
        >;
        event?: EventPayload;
        onFailure?: boolean;
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
          onFailure?: boolean;
          runStep?: string;
          expectedReturn?: Awaited<ReturnType<typeof runFnWithStack>>;
          expectedThrowMessage?: string;
          expectedHashOps?: UnhashedOp[];
          expectedStepsRun?: (keyof T["steps"])[];
          event?: EventPayload;
        }
      >
    ) => {
      describe(fnName, () => {
        Object.entries(tests(hashes)).forEach(([name, t]) => {
          describe(name, () => {
            let hashDataSpy: ReturnType<typeof getHashDataSpy>;
            let tools: T;
            let ret: Awaited<ReturnType<typeof runFnWithStack>> | undefined;
            let retErr: Error | undefined;

            beforeAll(async () => {
              hashDataSpy = getHashDataSpy();
              tools = createTools();
              ret = await runFnWithStack(tools.fn, t.stack || [], {
                runStep: t.runStep,
                onFailure: t.onFailure || tools.onFailure,
                event: t.event || tools.event,
              }).catch((err: Error) => {
                retErr = err;
                return undefined;
              });
            });

            if (t.expectedThrowMessage) {
              test("throws expected error", () => {
                expect(retErr?.message).toContain(t.expectedThrowMessage);
              });
            } else {
              test("returns expected value", () => {
                expect(ret).toEqual(t.expectedReturn);
              });
            }

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
        "first run runs A step": {
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
        "request with A in stack runs B step": {
          stack: [
            {
              id: A,
              data: "A",
            },
          ],
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
        "request with event foo.data.foo:foo runs A step": {
          stack: [{ id: foo, data: { data: { foo: "foo" } } }],
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
        "request with event foo.data.foo:bar runs B step": {
          stack: [{ id: foo, data: { data: { foo: "bar" } } }],
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

        "request with B,A order runs C step": {
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

        "request following B runs 'B wins' step": {
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

        "request following B runs 'B failed' step": {
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

    testFn(
      "throw when a non-step fn becomes a step-fn",
      () => {
        const A = jest.fn(() => "A");

        const fn = inngest.createFunction(
          { name: "Foo" },
          "foo",
          async ({ step: { run } }) => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            await run("A", A);
          }
        );

        return { fn, steps: { A } };
      },
      {
        A: "",
      },
      () => ({
        "first run throws, as we find a step late": {
          expectedThrowMessage: "Your function was stopped from running",
        },
      })
    );

    testFn(
      "handle onFailure calls",
      () => {
        const A = jest.fn(() => "A");
        const B = jest.fn(() => "B");

        const fn = inngest.createFunction(
          {
            name: "name",
            onFailure: async ({ step: { run } }) => {
              await run("A", A);
              await run("B", B);
            },
          },
          "foo",
          () => undefined
        );

        const event: FailureEventPayload = {
          name: internalEvents.FunctionFailed,
          data: {
            event: {
              name: "foo",
              data: {},
            },
            function_id: "123",
            run_id: "456",
            error: {
              name: "Error",
              message: "Something went wrong",
              stack: "",
            },
          },
        };

        return { fn, steps: { A, B }, event, onFailure: true };
      },
      {
        A: "c0a4028e0b48a2eeff383fa7186fd2d3763f5412",
        B: "b494def3936f5c59986e81bc29443609bfc2384a",
      },
      ({ A, B }) => ({
        "first run runs A step": {
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
        "request with A in stack runs B step": {
          stack: [
            {
              id: A,
              data: "A",
            },
          ],
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
  });

  describe("onFailure functions", () => {
    describe("types", () => {
      describe("no custom types", () => {
        const inngest = createClient({ name: "test" });

        test("onFailure function has unknown internal event", () => {
          inngest.createFunction(
            {
              name: "test",
              onFailure: ({ error, event }) => {
                assertType<`${internalEvents.FunctionFailed}`>(event.name);
                assertType<FailureEventPayload>(event);
                assertType<Error>(error);
              },
            },
            { event: "test" },
            () => {
              // no-op
            }
          );
        });
      });

      describe("multiple custom types", () => {
        const inngest = createClient<{
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
            {
              name: "test",
              onFailure: ({ error, event }) => {
                assertType<`${internalEvents.FunctionFailed}`>(event.name);
                assertType<FailureEventPayload>(event);
                assertType<Error>(error);

                assertType<"foo">(event.data.event.name);
                assertType<EventPayload>(event.data.event);
                assertType<{ title: string }>(event.data.event.data);
              },
            },
            { event: "foo" },
            () => {
              // no-op
            }
          );
        });
      });

      describe("passed fns have correct types", () => {
        const inngest = createClient({ name: "test" });

        const lib = {
          foo: true,
          bar: 5,
          baz: <T extends string>(name: T) => `Hello, ${name}!` as const,
          qux: (name: string) => `Hello, ${name}!`,
        };

        test("has shimmed fn types", () => {
          inngest.createFunction(
            {
              name: "test",
              fns: { ...lib },
              onFailure: ({ fns: { qux } }) => {
                assertType<Promise<string>>(qux("world"));
              },
            },
            { event: "foo" },
            () => {
              // no-op
            }
          );
        });

        test.skip("has shimmed fn types that preserve generics", () => {
          inngest.createFunction(
            {
              name: "test",
              fns: { ...lib },
              onFailure: ({ fns: { baz: _baz } }) => {
                // assertType<Promise<"Hello, world!">>(baz("world"));
              },
            },
            { event: "foo" },
            () => {
              // no-op
            }
          );
        });
      });
    });

    test("specifying an onFailure function registers correctly", () => {
      const inngest = createClient<{
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
        {
          name: "test",
          onFailure: () => {
            // no-op
          },
        },
        { event: "foo" },
        () => {
          // no-op
        }
      );

      expect(fn).toBeInstanceOf(InngestFunction);

      const [fnConfig, failureFnConfig] = fn["getConfig"](
        new URL("https://example.com")
      );

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
            expression: "event.data.function_id == 'test'",
          },
        ],
      });
    });
  });

  describe("cancellation", () => {
    describe("types", () => {
      describe("no custom types", () => {
        const inngest = createClient({ name: "test" });

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
        const inngest = createClient<{
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
      const inngest = createClient<{
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
