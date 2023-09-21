/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { jest } from "@jest/globals";
import { EventSchemas, type EventPayload } from "@local";
import {
  _internals,
  type ExecutionResult,
  type ExecutionResults,
  type InngestExecutionOptions,
} from "@local/components/InngestExecution";
import { InngestFunction } from "@local/components/InngestFunction";
import { STEP_INDEXING_SUFFIX } from "@local/components/InngestStepTools";
import { NonRetriableError } from "@local/components/NonRetriableError";
import { ServerTiming } from "@local/helpers/ServerTiming";
import { internalEvents } from "@local/helpers/consts";
import {
  ErrCode,
  OutgoingResultError,
  serializeError,
} from "@local/helpers/errors";
import {
  DefaultLogger,
  ProxyLogger,
  type Logger,
} from "@local/middleware/logger";
import {
  StepOpCode,
  type ClientOptions,
  type FailureEventPayload,
  type OutgoingOp,
} from "@local/types";
import { type IsEqual } from "type-fest";
import { assertType } from "type-plus";
import { createClient } from "../test/helpers";

type TestEvents = {
  foo: { data: { foo: string } };
  bar: { data: { bar: string } };
  baz: { data: { baz: string } };
};

const schemas = new EventSchemas().fromRecord<TestEvents>();

const opts = (<T extends ClientOptions>(x: T): T => x)({
  id: "test",
  eventKey: "event-key-123",
  schemas,
});

const inngest = createClient(opts);

const timer = new ServerTiming();

const matchError = (err: any) => {
  const serializedErr = serializeError(err);
  return expect.objectContaining({
    ...serializedErr,
    stack: expect.any(String),
  });
};

describe("ID restrictions", () => {
  it.todo("does not allow characters outside of the character set");
});

describe("runFn", () => {
  describe("single-step function", () => {
    const stepRet = { someProperty: "step done" };
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
          let fn: InngestFunction<typeof opts>;
          let ret: ExecutionResult;
          let flush: jest.SpiedFunction<() => void>;

          beforeAll(async () => {
            jest.restoreAllMocks();
            flush = jest
              .spyOn(ProxyLogger.prototype, "flush")
              .mockImplementation(async () => {
                /* noop */
              });

            fn = new InngestFunction(
              createClient(opts),
              { id: "Foo" },
              { event: "foo" },
              flowFn
            );

            const execution = fn["createExecution"]({
              data: { event: { name: "foo", data: { foo: "foo" } } },
              stepState: {},
              stepCompletionOrder: [],
            });

            ret = await execution.start();
          });

          test("returns is not op on success", () => {
            expect(ret.type).toBe("function-resolved");
          });

          test("returns data on success", () => {
            expect((ret as ExecutionResults["function-resolved"]).data).toBe(
              stepRet
            );
          });

          test("should attempt to flush logs", () => {
            expect(flush).toHaveBeenCalledTimes(1);
          });
        });

        describe("throws", () => {
          const stepErr = new Error("step error");
          let fn: InngestFunction<typeof opts>;

          beforeAll(() => {
            fn = new InngestFunction(
              createClient(opts),
              { id: "Foo" },
              { event: "foo" },
              badFlowFn
            );
          });

          test("wrap thrown error", async () => {
            const execution = fn["createExecution"]({
              data: { event: { name: "foo", data: { foo: "foo" } } },
              stepState: {},
              stepCompletionOrder: [],
            });

            const ret = await execution.start();

            expect(ret.type).toBe("function-rejected");
            expect(ret).toMatchObject({
              error: matchError(stepErr),
              retriable: true,
            });
          });
        });
      });
    });
  });

  describe("step functions", () => {
    const runFnWithStack = (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fn: InngestFunction<any, any, any, any>,
      stepState: InngestExecutionOptions["stepState"],
      opts?: {
        runStep?: string;
        onFailure?: boolean;
        event?: EventPayload;
        stackOrder?: InngestExecutionOptions["stepCompletionOrder"];
        disableImmediateExecution?: boolean;
      }
    ) => {
      const execution = fn["createExecution"]({
        data: { event: opts?.event || { name: "foo", data: {} } },
        stepState,
        stepCompletionOrder: opts?.stackOrder ?? Object.keys(stepState),
        isFailureHandler: Boolean(opts?.onFailure),
        requestedRunStep: opts?.runStep,
        timer,
        disableImmediateExecution: opts?.disableImmediateExecution,
      });

      return execution.start();
    };

    const getHashDataSpy = () => jest.spyOn(_internals, "hashOp");
    const getWarningSpy = () => jest.spyOn(console, "warn");

    const testFn = <
      T extends {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fn: InngestFunction<any, any, any, any>;
        steps: Record<
          string,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          | jest.Mock<(...args: any[]) => string>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          | jest.Mock<(...args: any[]) => Promise<string>>
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
          stack?: InngestExecutionOptions["stepState"];
          stackOrder?: InngestExecutionOptions["stepCompletionOrder"];
          onFailure?: boolean;
          runStep?: string;
          expectedReturn?: Awaited<ReturnType<typeof runFnWithStack>>;
          expectedThrowMessage?: string;
          expectedHashOps?: OutgoingOp[];
          expectedStepsRun?: (keyof T["steps"])[];
          event?: EventPayload;
          customTests?: () => void;
          disableImmediateExecution?: boolean;
          expectedWarnings?: string[];
        }
      >
    ) => {
      describe(fnName, () => {
        const processedHashes = Object.fromEntries(
          Object.entries(hashes).map(([key, value]) => {
            return [key, _internals.hashId(value)];
          })
        ) as typeof hashes;

        Object.entries(tests(processedHashes)).forEach(([name, t]) => {
          describe(name, () => {
            let hashDataSpy: ReturnType<typeof getHashDataSpy>;
            let warningSpy: ReturnType<typeof getWarningSpy>;
            let tools: T;
            let ret: Awaited<ReturnType<typeof runFnWithStack>> | undefined;
            let retErr: Error | undefined;
            let flush: jest.SpiedFunction<() => void>;

            beforeAll(() => {
              jest.restoreAllMocks();
              flush = jest
                .spyOn(ProxyLogger.prototype, "flush")
                .mockImplementation(async () => {
                  /* noop */
                });
              hashDataSpy = getHashDataSpy();
              warningSpy = getWarningSpy();
              tools = createTools();
            });

            t.customTests?.();

            beforeAll(async () => {
              ret = await runFnWithStack(tools.fn, t.stack || {}, {
                stackOrder: t.stackOrder,
                runStep: t.runStep,
                onFailure: t.onFailure || tools.onFailure,
                event: t.event || tools.event,
                disableImmediateExecution: t.disableImmediateExecution,
              }).catch((err: Error) => {
                retErr = err;
                return undefined;
              });
            });

            if (t.expectedThrowMessage) {
              test("throws expected error", () => {
                expect(
                  retErr instanceof OutgoingResultError
                    ? (retErr.result.error as Error)?.message
                    : retErr?.message ?? ""
                ).toContain(t.expectedThrowMessage);
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

            if (t.expectedWarnings?.length) {
              describe("warnings", () => {
                t.expectedWarnings?.forEach((warning) => {
                  test(`includes "${warning}"`, () => {
                    expect(warningSpy).toHaveBeenCalledWith(
                      expect.stringContaining(warning)
                    );
                  });
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

            test("should attempt to flush logs", () => {
              // could be flushed multiple times so no specifying counts
              expect(flush).toHaveBeenCalled();
            });

            if (
              ret &&
              (ret.type === "step-ran" || ret.type === "steps-found")
            ) {
              test("output hashes match expected shape", () => {
                const outgoingOps: OutgoingOp[] =
                  ret!.type === "step-ran"
                    ? [ret!.step]
                    : ret!.type === "steps-found"
                    ? ret!.steps
                    : [];

                outgoingOps.forEach((op) => {
                  expect(op.id).toMatch(/^[a-f0-9]{40}$/i);
                });
              });
            }

            t.customTests?.();
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
          { id: "name" },
          { event: "foo" },
          async ({ step: { run } }) => {
            await run("A", A);
            await run("B", B);
          }
        );

        return { fn, steps: { A, B } };
      },
      {
        A: "A",
        B: "B",
      },
      ({ A, B }) => ({
        "first run runs A step": {
          expectedReturn: {
            type: "step-ran",
            step: expect.objectContaining({
              id: A,
              name: "A",
              op: StepOpCode.RunStep,
              data: "A",
            }),
          },
          expectedStepsRun: ["A"],
        },
        "request with A in stack runs B step": {
          stack: {
            [A]: {
              id: A,
              data: "A",
            },
          },
          expectedReturn: {
            type: "step-ran",
            step: expect.objectContaining({
              id: B,
              name: "B",
              op: StepOpCode.RunStep,
              data: "B",
            }),
          },
          expectedStepsRun: ["B"],
        },
        "final request returns empty response": {
          stack: {
            [A]: {
              id: A,
              data: "A",
            },
            [B]: {
              id: B,
              data: "B",
            },
          },
          expectedReturn: {
            type: "function-resolved",
            data: undefined,
          },
        },
      })
    );

    testFn(
      "change path based on data",
      () => {
        const A = jest.fn(() => "A");
        const B = jest.fn(() => "B");

        const fn = inngest.createFunction(
          { id: "name" },
          { event: "foo" },
          async ({ step: { waitForEvent, run } }) => {
            const foo = await waitForEvent("wait-id", {
              event: "foo",
              timeout: "2h",
            });

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
        foo: "wait-id",
        A: "A",
        B: "B",
      },
      ({ foo, A, B }) => ({
        "first run reports waitForEvent": {
          expectedReturn: {
            type: "steps-found",
            steps: [
              expect.objectContaining({
                op: StepOpCode.WaitForEvent,
                name: "foo",
                id: foo,
              }),
            ],
          },
        },
        "request with event foo.data.foo:foo runs A step": {
          stack: { [foo]: { id: foo, data: { data: { foo: "foo" } } } },
          expectedReturn: {
            type: "step-ran",
            step: expect.objectContaining({
              id: A,
              name: "A",
              op: StepOpCode.RunStep,
              data: "A",
            }),
          },
          expectedStepsRun: ["A"],
        },
        "request with event foo.data.foo:bar runs B step": {
          stack: { [foo]: { id: foo, data: { data: { foo: "bar" } } } },
          expectedReturn: {
            type: "step-ran",
            step: expect.objectContaining({
              id: B,
              name: "B",
              op: StepOpCode.RunStep,
              data: "B",
            }),
          },
          expectedStepsRun: ["B"],
        },
        "final request returns empty response": {
          stack: {
            [foo]: {
              id: foo,
              data: { data: { foo: "bar" } },
            },
            [B]: {
              id: B,
              data: "B",
            },
          },
          expectedReturn: {
            type: "function-resolved",
            data: undefined,
          },
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
          { id: "name" },
          { event: "foo" },
          async ({ step: { run } }) => {
            await Promise.all([run("A", A), run("B", B)]);
            await run("C", C);
          }
        );

        return { fn, steps: { A, B, C } };
      },
      {
        A: "A",
        B: "B",
        C: "C",
      },
      ({ A, B, C }) => ({
        "first run reports A and B steps": {
          expectedReturn: {
            type: "steps-found",
            steps: [
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
          },
        },

        "requesting to run B runs B": {
          disableImmediateExecution: true,
          runStep: B,
          expectedReturn: {
            type: "step-ran",
            step: expect.objectContaining({
              id: B,
              name: "B",
              op: StepOpCode.RunStep,
              data: "B",
            }),
          },
          expectedStepsRun: ["B"],
        },

        "request with only B state returns discovery of A": {
          disableImmediateExecution: true,
          stack: {
            [B]: {
              id: B,
              data: "B",
            },
          },
          expectedReturn: {
            type: "steps-found",
            steps: [
              expect.objectContaining({
                id: A,
                name: "A",
                op: StepOpCode.StepPlanned,
              }),
            ],
          },
        },

        "requesting to run A runs A": {
          disableImmediateExecution: true,
          runStep: A,
          expectedReturn: {
            type: "step-ran",
            step: expect.objectContaining({
              id: A,
              name: "A",
              op: StepOpCode.RunStep,
              data: "A",
            }),
          },
          expectedStepsRun: ["A"],
        },

        "request with B,A state discovers C step": {
          disableImmediateExecution: true,
          stack: {
            [B]: {
              id: B,
              data: "B",
            },
            [A]: {
              id: A,
              data: "A",
            },
          },
          expectedReturn: {
            type: "steps-found",
            steps: [
              expect.objectContaining({
                id: C,
                name: "C",
                op: StepOpCode.StepPlanned,
              }),
            ],
          },
        },

        "requesting to run C runs C": {
          disableImmediateExecution: true,
          stack: {
            [B]: {
              id: B,
              data: "B",
            },
            [A]: {
              id: A,
              data: "A",
            },
          },
          runStep: C,
          expectedReturn: {
            type: "step-ran",
            step: expect.objectContaining({
              id: C,
              name: "C",
              op: StepOpCode.RunStep,
              data: "C",
            }),
          },
          expectedStepsRun: ["C"],
        },

        "final request returns empty response": {
          disableImmediateExecution: true,
          stack: {
            [B]: {
              id: B,
              data: "B",
            },
            [A]: {
              id: A,
              data: "A",
            },
            [C]: {
              id: C,
              data: "C",
            },
          },
          expectedReturn: {
            type: "function-resolved",
            data: undefined,
          },
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
          { id: "name" },
          { event: "foo" },
          async ({ step: { run } }) => {
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
        A: "A",
        B: "B",
        AWins: "A wins",
        BWins: "B wins",
      },
      ({ A, B, AWins, BWins }) => ({
        "first run reports A and B steps": {
          expectedReturn: {
            type: "steps-found",
            steps: [
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
          },
        },

        "requesting to run B runs B": {
          runStep: B,
          expectedReturn: {
            type: "step-ran",
            step: expect.objectContaining({
              id: B,
              name: "B",
              op: StepOpCode.RunStep,
              data: "B",
            }),
          },
          expectedStepsRun: ["B"],
          disableImmediateExecution: true,
        },

        "request following B reports 'A' and 'B wins' steps": {
          stack: { [B]: { id: B, data: "B" } },
          expectedReturn: {
            type: "steps-found",
            steps: [
              expect.objectContaining({
                id: A,
                name: "A",
                op: StepOpCode.StepPlanned,
              }),
              expect.objectContaining({
                id: BWins,
                name: "B wins",
                op: StepOpCode.StepPlanned,
              }),
            ],
          },
          disableImmediateExecution: true,
        },

        "requesting to run A runs A": {
          runStep: A,
          expectedReturn: {
            type: "step-ran",
            step: expect.objectContaining({
              id: A,
              name: "A",
              op: StepOpCode.RunStep,
              data: "A",
            }),
          },
          expectedStepsRun: ["A"],
          disableImmediateExecution: true,
        },

        "request following 'B wins' resolves": {
          stack: {
            [B]: { id: B, data: "B" },
            [BWins]: { id: BWins, data: "B wins" },
          },
          stackOrder: [B, BWins],
          expectedReturn: { type: "function-resolved", data: undefined },
          disableImmediateExecution: true,
        },

        "request following A completion resolves": {
          stack: {
            [A]: { id: A, data: "A" },
            [B]: { id: B, data: "B" },
            [BWins]: { id: BWins, data: "B wins" },
          },
          stackOrder: [B, BWins, A],
          expectedReturn: { type: "function-resolved", data: undefined },
          disableImmediateExecution: true,
        },

        "request if 'A' is complete reports 'B' and 'A wins' steps": {
          stack: { [A]: { id: A, data: "A" } },
          expectedReturn: {
            type: "steps-found",
            steps: [
              expect.objectContaining({
                id: B,
                name: "B",
                op: StepOpCode.StepPlanned,
              }),
              expect.objectContaining({
                id: AWins,
                name: "A wins",
                op: StepOpCode.StepPlanned,
              }),
            ],
          },
          disableImmediateExecution: true,
        },
      })
    );

    testFn(
      "Deep Promise.race",
      () => {
        const A = jest.fn(() => Promise.resolve("A"));
        const B = jest.fn(() => Promise.resolve("B"));
        const B2 = jest.fn(() => Promise.resolve("B2"));
        const AWins = jest.fn(() => Promise.resolve("A wins"));
        const BWins = jest.fn(() => Promise.resolve("B wins"));

        const fn = inngest.createFunction(
          { id: "name" },
          { event: "foo" },
          async ({ step: { run } }) => {
            const winner = await Promise.race([
              run("A", A),
              run("B", B).then(() => run("B2", B2)),
            ]);

            if (winner === "A") {
              await run("A wins", AWins);
            } else if (winner === "B2") {
              await run("B wins", BWins);
            }
          }
        );

        return { fn, steps: { A, B, B2, AWins, BWins } };
      },
      {
        A: "A",
        B: "B",
        B2: "B2",
        AWins: "A wins",
        BWins: "B wins",
      },
      ({ A, B, B2, BWins }) => ({
        "if B chain wins without 'A', reports 'A' and 'B wins' steps": {
          stack: { [B]: { id: B, data: "B" }, [B2]: { id: B2, data: "B2" } },
          expectedReturn: {
            type: "steps-found",
            steps: [
              expect.objectContaining({
                id: A,
                name: "A",
                op: StepOpCode.StepPlanned,
              }),
              expect.objectContaining({
                id: BWins,
                name: "B wins",
                op: StepOpCode.StepPlanned,
              }),
            ],
          },
          disableImmediateExecution: true,
        },
        "if B chain wins after with 'A' afterwards, reports 'B wins' step": {
          stack: {
            [B]: { id: B, data: "B" },
            [B2]: { id: B2, data: "B2" },
            [A]: { id: A, data: "A" },
          },
          stackOrder: [B, B2, A],
          expectedReturn: {
            type: "steps-found",
            steps: [
              expect.objectContaining({
                id: BWins,
                name: "B wins",
                op: StepOpCode.StepPlanned,
              }),
            ],
          },
          disableImmediateExecution: true,
        },
      })
    );

    testFn(
      "step indexing in sequence",
      () => {
        const A = jest.fn(() => "A");
        const B = jest.fn(() => "B");
        const C = jest.fn(() => "C");

        const fn = inngest.createFunction(
          { id: "name" },
          { event: "foo" },
          async ({ step: { run } }) => {
            await run("A", A);
            await run("A", B);
            await run("A", C);
          }
        );

        return { fn, steps: { A, B, C } };
      },
      {
        A: "A",
        B: `A${STEP_INDEXING_SUFFIX}1`,
        C: `A${STEP_INDEXING_SUFFIX}2`,
      },
      ({ A, B, C }) => ({
        "first run runs A step": {
          expectedReturn: {
            type: "step-ran",
            step: expect.objectContaining({
              id: A,
              name: "A",
              op: StepOpCode.RunStep,
              data: "A",
            }),
          },
          expectedStepsRun: ["A"],
        },
        "request with A in stack runs B step": {
          stack: {
            [A]: {
              id: A,
              data: "A",
            },
          },
          expectedReturn: {
            type: "step-ran",
            step: expect.objectContaining({
              id: B,
              name: "A",
              op: StepOpCode.RunStep,
              data: "B",
            }),
          },
          expectedStepsRun: ["B"],
        },
        "request with B in stack runs C step": {
          stack: {
            [A]: {
              id: A,
              data: "A",
            },
            [B]: {
              id: B,
              data: "B",
            },
          },
          expectedReturn: {
            type: "step-ran",
            step: expect.objectContaining({
              id: C,
              name: "A",
              op: StepOpCode.RunStep,
              data: "C",
            }),
          },
          expectedStepsRun: ["C"],
        },
      })
    );

    testFn(
      "step indexing in parallel",
      () => {
        const A = jest.fn(() => "A");
        const B = jest.fn(() => "B");
        const C = jest.fn(() => "C");

        const fn = inngest.createFunction(
          { id: "name" },
          { event: "foo" },
          async ({ step: { run } }) => {
            await Promise.all([run("A", A), run("A", B), run("A", C)]);
          }
        );

        return { fn, steps: { A, B, C } };
      },
      {
        A: "A",
        B: `A${STEP_INDEXING_SUFFIX}1`,
        C: `A${STEP_INDEXING_SUFFIX}2`,
      },
      ({ A, B, C }) => ({
        "first run reports all steps": {
          expectedReturn: {
            type: "steps-found",
            steps: [
              expect.objectContaining({
                id: A,
                name: "A",
                op: StepOpCode.StepPlanned,
              }),
              expect.objectContaining({
                id: B,
                name: "A",
                op: StepOpCode.StepPlanned,
              }),
              expect.objectContaining({
                id: C,
                name: "A",
                op: StepOpCode.StepPlanned,
              }),
            ],
          },
          expectedWarnings: [ErrCode.AUTOMATIC_PARALLEL_INDEXING],
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
          { id: "name" },
          { event: "foo" },
          async ({ step: { run } }) => {
            return Promise.all([
              run("A", A),
              run("B", B).catch(() => run("B failed", BFailed)),
            ]);
          }
        );

        return { fn, steps: { A, B, BFailed } };
      },
      {
        A: "A",
        B: "B",
        BFailed: "B failed",
      },
      ({ A, B, BFailed }) => ({
        "first run reports A and B steps": {
          expectedReturn: {
            type: "steps-found",
            steps: [
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
          },
        },

        "requesting to run A runs A": {
          disableImmediateExecution: true,
          runStep: A,
          expectedReturn: {
            type: "step-ran",
            step: expect.objectContaining({
              id: A,
              name: "A",
              op: StepOpCode.RunStep,
              data: "A",
            }),
          },
          expectedStepsRun: ["A"],
        },

        "request with only A state returns B found": {
          disableImmediateExecution: true,
          stack: { [A]: { id: A, data: "A" } },
          expectedReturn: {
            type: "steps-found",
            steps: [
              expect.objectContaining({
                id: B,
                name: "B",
                op: StepOpCode.StepPlanned,
              }),
            ],
          },
        },

        "requesting to run B runs B, which fails": {
          disableImmediateExecution: true,
          runStep: B,
          expectedReturn: {
            type: "function-rejected",
            error: matchError("B"),
            retriable: true,
          },
          expectedStepsRun: ["B"],
        },

        "request following B reports 'B failed' step": {
          disableImmediateExecution: true,
          stack: {
            [A]: { id: A, data: "A" },
            [B]: { id: B, error: "B" },
          },
          expectedReturn: {
            type: "steps-found",
            steps: [
              expect.objectContaining({
                id: BFailed,
                name: "B failed",
                op: StepOpCode.StepPlanned,
              }),
            ],
          },
        },

        "requesting to run 'B failed' runs 'B failed'": {
          disableImmediateExecution: true,
          stack: {
            [A]: { id: A, data: "A" },
            [B]: { id: B, error: "B" },
          },
          runStep: BFailed,
          expectedReturn: {
            type: "step-ran",
            step: expect.objectContaining({
              id: BFailed,
              name: "B failed",
              op: StepOpCode.RunStep,
              data: "B failed",
            }),
          },
          expectedStepsRun: ["BFailed"],
        },

        "final request returns empty response": {
          disableImmediateExecution: true,
          stack: {
            [A]: { id: A, data: "A" },
            [B]: { id: B, error: "B" },
            [BFailed]: { id: BFailed, data: "B failed" },
          },
          expectedReturn: {
            type: "function-resolved",
            data: ["A", "B failed"],
          },
        },
      })
    );

    testFn(
      "throws a NonRetriableError when one is thrown inside a step",
      () => {
        const A = jest.fn(() => {
          throw new NonRetriableError("A");
        });

        const fn = inngest.createFunction(
          { id: "Foo" },
          { event: "foo" },
          async ({ step: { run } }) => {
            await run("A", A);
          }
        );

        return { fn, steps: { A } };
      },
      {
        A: "A",
      },
      () => ({
        "first run executes A, which throws a NonRetriable error": {
          expectedReturn: {
            type: "function-rejected",
            retriable: false,
            error: matchError(new NonRetriableError("A")),
          },
          expectedStepsRun: ["A"],
        },
      })
    );

    testFn(
      "throws a NonRetriableError when thrown inside the main function body",
      () => {
        const fn = inngest.createFunction(
          { id: "Foo" },
          { event: "foo" },
          async () => {
            throw new NonRetriableError("Error");
          }
        );

        return { fn, steps: {} };
      },
      {},
      () => ({
        "throws a NonRetriableError": {
          expectedReturn: {
            type: "function-rejected",
            retriable: false,
            error: matchError(new NonRetriableError("Error")),
          },
          expectedStepsRun: [],
        },
      })
    );

    testFn(
      "throws a retriable error when a string is thrown inside the main function body",
      () => {
        const fn = inngest.createFunction(
          { id: "Foo" },
          { event: "foo" },
          async () => {
            throw "foo";
          }
        );

        return { fn, steps: {} };
      },
      {},
      () => ({
        "throws a retriable error": {
          expectedReturn: {
            type: "function-rejected",
            retriable: true,
            error: matchError("foo"),
          },
          expectedStepsRun: [],
        },
      })
    );

    testFn(
      "throws a retriable error when an empty object is thrown inside the main function body",
      () => {
        const fn = inngest.createFunction(
          { id: "Foo" },
          { event: "foo" },
          async () => {
            throw {};
          }
        );

        return { fn, steps: {} };
      },
      {},
      () => ({
        "throws a retriable error": {
          expectedReturn: {
            type: "function-rejected",
            retriable: true,
            error: matchError({}),
          },
          expectedStepsRun: [],
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
            id: "name",
            onFailure: async ({ step: { run } }) => {
              await run("A", A);
              await run("B", B);
            },
          },
          { event: "foo" },
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
        A: "A",
        B: "B",
      } as const,
      ({ A, B }) => ({
        "first run runs A step": {
          expectedReturn: {
            type: "step-ran",
            step: expect.objectContaining({
              id: A,
              name: "A",
              op: StepOpCode.RunStep,
              data: "A",
            }),
          },
          expectedStepsRun: ["A"],
        },
        "request with A in stack runs B step": {
          stack: {
            [A]: {
              id: A,
              data: "A",
            },
          },
          expectedReturn: {
            type: "step-ran",
            step: expect.objectContaining({
              id: B,
              name: "B",
              op: StepOpCode.RunStep,
              data: "B",
            }),
          },
          expectedStepsRun: ["B"],
        },
        "final request returns empty response": {
          stack: {
            [A]: {
              id: A,
              data: "A",
            },
            [B]: {
              id: B,
              data: "B",
            },
          },
          expectedReturn: {
            type: "function-resolved",
            data: undefined,
          },
        },
      })
    );

    testFn(
      "can use built-in logger middleware",
      () => {
        const A = jest.fn((logger: Logger) => {
          logger.info("A");
          return "A";
        });

        const B = jest.fn((logger: Logger) => {
          logger.info("B");
          return "B";
        });

        const fn = inngest.createFunction(
          { id: "name" },
          { event: "foo" },
          async ({ step: { run }, logger }) => {
            assertType<IsEqual<Logger, typeof logger>>(true);
            logger.info("info1");
            await run("A", () => A(logger));
            logger.info("2");
            await run("B", () => B(logger));
            logger.info("3");
          }
        );

        return { fn, steps: { A, B } };
      },
      {
        A: "A",
        B: "B",
      },
      ({ A, B }) => ({
        "first run runs A step": {
          expectedReturn: {
            type: "step-ran",
            step: expect.objectContaining({
              id: A,
              name: "A",
              op: StepOpCode.RunStep,
              data: "A",
            }),
          },
          expectedStepsRun: ["A"],
          customTests() {
            let loggerInfoSpy: jest.SpiedFunction<() => void>;

            beforeAll(() => {
              loggerInfoSpy = jest.spyOn(DefaultLogger.prototype, "info");
            });

            test("log called", () => {
              expect(loggerInfoSpy.mock.calls).toEqual([["info1"], ["A"]]);
            });
          },
        },
        "request with A in stack runs B step": {
          stack: {
            [A]: {
              id: A,
              data: "A",
            },
          },
          expectedReturn: {
            type: "step-ran",
            step: expect.objectContaining({
              id: B,
              name: "B",
              op: StepOpCode.RunStep,
              data: "B",
            }),
          },
          expectedStepsRun: ["B"],
          customTests() {
            let loggerInfoSpy: jest.SpiedFunction<() => void>;

            beforeAll(() => {
              loggerInfoSpy = jest.spyOn(DefaultLogger.prototype, "info");
            });

            test("log called", () => {
              expect(loggerInfoSpy.mock.calls).toEqual([["2"], ["B"]]);
            });
          },
        },
        "final request returns empty response": {
          stack: {
            [A]: {
              id: A,
              data: "A",
            },
            [B]: {
              id: B,
              data: "B",
            },
          },
          expectedReturn: {
            type: "function-resolved",
            data: undefined,
          },
          customTests() {
            let loggerInfoSpy: jest.SpiedFunction<() => void>;

            beforeAll(() => {
              loggerInfoSpy = jest.spyOn(DefaultLogger.prototype, "info");
            });

            test("log called", () => {
              expect(loggerInfoSpy.mock.calls).toEqual([["3"]]);
            });
          },
        },
      })
    );
  });

  describe("onFailure functions", () => {
    describe("types", () => {
      describe("no custom types", () => {
        const inngest = createClient({ id: "test" });

        test("onFailure function has unknown internal event", () => {
          inngest.createFunction(
            {
              id: "test",
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
        const inngest = createClient({
          id: "test",
          schemas: new EventSchemas().fromRecord<{
            foo: {
              name: "foo";
              data: { title: string };
            };
            bar: {
              name: "bar";
              data: { message: string };
            };
          }>(),
        });

        test("onFailure function has known internal event", () => {
          inngest.createFunction(
            {
              id: "test",
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
    });

    test("specifying an onFailure function registers correctly", () => {
      const clientId = "testclient";

      const inngest = createClient({
        id: clientId,
        schemas: new EventSchemas().fromRecord<{
          foo: {
            name: "foo";
            data: { title: string };
          };
          bar: {
            name: "bar";
            data: { message: string };
          };
        }>(),
      });

      const fn = inngest.createFunction(
        {
          id: "testfn",
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
        new URL("https://example.com"),
        clientId
      );

      expect(fnConfig).toMatchObject({
        id: "testclient-testfn",
        steps: {
          [InngestFunction.stepId]: {
            id: InngestFunction.stepId,
            name: InngestFunction.stepId,
            runtime: {
              type: "http",
              url: `https://example.com/?fnId=testclient-testfn&stepId=${InngestFunction.stepId}`,
            },
          },
        },
        triggers: [{ event: "foo" }],
      });

      expect(failureFnConfig).toMatchObject({
        id: "testclient-testfn-failure",
        steps: {
          [InngestFunction.stepId]: {
            id: InngestFunction.stepId,
            name: InngestFunction.stepId,
            runtime: {
              type: "http",
              url: `https://example.com/?fnId=testclient-testfn-failure&stepId=${InngestFunction.stepId}`,
            },
          },
        },
        triggers: [
          {
            event: internalEvents.FunctionFailed,
            expression: "event.data.function_id == 'testclient-testfn'",
          },
        ],
      });
    });
  });

  describe("cancellation", () => {
    describe("types", () => {
      describe("no custom types", () => {
        const inngest = createClient({ id: "test" });

        test("allows any event name", () => {
          inngest.createFunction(
            { id: "test", cancelOn: [{ event: "anything" }] },
            { event: "test" },
            () => {
              // no-op
            }
          );
        });

        test("allows any match", () => {
          inngest.createFunction(
            {
              id: "test",
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
        const inngest = createClient({
          id: "test",
          schemas: new EventSchemas().fromRecord<{
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
          }>(),
        });

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
            { id: "test", cancelOn: [{ event: "bar" }] },
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
              id: "test",
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
      const clientId = "testclient";

      const inngest = createClient({
        id: clientId,
        schemas: new EventSchemas().fromRecord<{
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
        }>(),
      });

      const fn = inngest.createFunction(
        { id: "testfn", cancelOn: [{ event: "baz", match: "data.title" }] },
        { event: "foo" },
        () => {
          // no-op
        }
      );

      const [fnConfig] = fn["getConfig"](
        new URL("https://example.com"),
        clientId
      );

      expect(fnConfig).toMatchObject({
        id: "testclient-testfn",
        steps: {
          [InngestFunction.stepId]: {
            id: InngestFunction.stepId,
            name: InngestFunction.stepId,
            runtime: {
              type: "http",
              url: `https://example.com/?fnId=testclient-testfn&stepId=${InngestFunction.stepId}`,
            },
          },
        },
        triggers: [{ event: "foo" }],
        cancel: [{ event: "baz", if: "event.data.title == async.data.title" }],
      });
    });
  });
});
