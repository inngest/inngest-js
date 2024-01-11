/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { jest } from "@jest/globals";
import {
  EventSchemas,
  InngestMiddleware,
  NonRetriableError,
  type EventPayload,
} from "@local";
import {
  InngestFunction,
  type AnyInngestFunction,
} from "@local/components/InngestFunction";
import { STEP_INDEXING_SUFFIX } from "@local/components/InngestStepTools";
import {
  ExecutionVersion,
  PREFERRED_EXECUTION_VERSION,
  type ExecutionResult,
  type ExecutionResults,
  type InngestExecutionOptions,
} from "@local/components/execution/InngestExecution";
import { _internals } from "@local/components/execution/v1";
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
import { fromPartial } from "@total-typescript/shoehorn";
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
  /**
   * Create some test middleware that purposefully takes time for every hook.
   * This ensures that the engine accounts for the potential time taken by
   * middleware to run.
   */
  middleware: [
    new InngestMiddleware({
      name: "Mock",
      init: () => {
        const mockHook = () =>
          new Promise<void>((resolve) => setTimeout(() => setTimeout(resolve)));

        return {
          onFunctionRun: () => {
            return {
              afterExecution: mockHook,
              afterMemoization: mockHook,
              beforeExecution: mockHook,
              beforeMemoization: mockHook,
              beforeResponse: mockHook,
              transformInput: mockHook,
              transformOutput: mockHook,
            };
          },
          onSendEvent: () => {
            return {
              transformInput: mockHook,
              transformOutput: mockHook,
            };
          },
        };
      },
    }),
  ],
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
              version: PREFERRED_EXECUTION_VERSION,
              partialOptions: {
                data: fromPartial({
                  event: { name: "foo", data: { foo: "foo" } },
                }),
                runId: "run",
                stepState: {},
                stepCompletionOrder: [],
                reqArgs: [],
              },
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
              version: PREFERRED_EXECUTION_VERSION,
              partialOptions: {
                data: fromPartial({
                  event: { name: "foo", data: { foo: "foo" } },
                }),
                stepState: {},
                runId: "run",
                stepCompletionOrder: [],
                reqArgs: [],
              },
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
      fn: AnyInngestFunction,
      stepState: InngestExecutionOptions["stepState"],
      opts?: {
        executionVersion?: ExecutionVersion;
        runStep?: string;
        onFailure?: boolean;
        event?: EventPayload;
        stackOrder?: InngestExecutionOptions["stepCompletionOrder"];
        disableImmediateExecution?: boolean;
      }
    ) => {
      const execution = fn["createExecution"]({
        version: opts?.executionVersion ?? PREFERRED_EXECUTION_VERSION,
        partialOptions: {
          data: fromPartial({
            event: opts?.event || { name: "foo", data: {} },
          }),
          runId: "run",
          stepState,
          stepCompletionOrder: opts?.stackOrder ?? Object.keys(stepState),
          isFailureHandler: Boolean(opts?.onFailure),
          requestedRunStep: opts?.runStep,
          timer,
          disableImmediateExecution: opts?.disableImmediateExecution,
          reqArgs: [],
        },
      });

      return execution.start();
    };

    const getHashDataSpy = () => jest.spyOn(_internals, "hashOp");
    const getWarningSpy = () => jest.spyOn(console, "warn");
    const getErrorSpy = () => jest.spyOn(console, "error");

    const executionIdHashes: Partial<
      Record<ExecutionVersion, (id: string) => string>
    > = {
      [ExecutionVersion.V1]: _internals.hashId,
    };

    const testFn = <
      T extends {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fn: AnyInngestFunction;
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
      U extends Record<keyof T["steps"], string>,
    >(
      fnName: string,
      createTools: () => T,
      executionTests: Record<
        ExecutionVersion,
        {
          hashes: U;
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
              expectedErrors?: string[];
            }
          >;
        } | null
      >
    ) => {
      Object.entries(executionTests).forEach(([version, specs]) => {
        if (!specs) return;
        const { hashes, tests } = specs;

        const executionVersion = version as unknown as ExecutionVersion;

        describe(`${fnName} (V${executionVersion})`, () => {
          const hashId = executionIdHashes[executionVersion];

          const processedHashes = hashId
            ? (Object.fromEntries(
                Object.entries(hashes).map(([key, value]) => {
                  return [key, hashId(value)];
                })
              ) as typeof hashes)
            : hashes;

          Object.entries(tests(processedHashes)).forEach(([name, t]) => {
            describe(name, () => {
              let hashDataSpy: ReturnType<typeof getHashDataSpy>;
              let warningSpy: ReturnType<typeof getWarningSpy>;
              let errorSpy: ReturnType<typeof getErrorSpy>;
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
                errorSpy = getErrorSpy();
                tools = createTools();
              });

              t.customTests?.();

              beforeAll(async () => {
                ret = await runFnWithStack(tools.fn, t.stack || {}, {
                  executionVersion,
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
                describe("warning logs", () => {
                  t.expectedWarnings?.forEach((warning, i) => {
                    test(`warning log #${i + 1} includes "${warning}"`, () => {
                      expect(warningSpy).toHaveBeenNthCalledWith(
                        i + 1,
                        expect.stringContaining(warning)
                      );
                    });
                  });
                });
              } else {
                test("no warning logs", () => {
                  expect(warningSpy).not.toHaveBeenCalled();
                });
              }

              if (t.expectedErrors?.length) {
                describe("error logs", () => {
                  t.expectedErrors?.forEach((error, i) => {
                    test(`error log #${i + 1} includes "${error}"`, () => {
                      const call = errorSpy.mock.calls[i];
                      const stringifiedArgs = call?.map((arg) => {
                        return arg instanceof Error ? serializeError(arg) : arg;
                      });

                      expect(JSON.stringify(stringifiedArgs)).toContain(error);
                    });
                  });
                });
              } else {
                test("no error logs", () => {
                  expect(errorSpy).not.toHaveBeenCalled();
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
        [ExecutionVersion.V0]: {
          hashes: {
            A: "c0a4028e0b48a2eeff383fa7186fd2d3763f5412",
            B: "b494def3936f5c59986e81bc29443609bfc2384a",
          },
          tests: ({ A, B }) => ({
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
              stack: { [A]: { id: A, data: "A" } },
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
                [A]: { id: A, data: "A" },
                [B]: { id: B, data: "B" },
              },
              stackOrder: [A, B],
              expectedReturn: {
                type: "function-resolved",
                data: null,
              },
            },
          }),
        },
        [ExecutionVersion.V1]: {
          hashes: {
            A: "A",
            B: "B",
          },
          tests: ({ A, B }) => ({
            "first run runs A step": {
              expectedReturn: {
                type: "step-ran",
                step: expect.objectContaining({
                  id: A,
                  name: "A",
                  op: StepOpCode.RunStep,
                  data: { data: "A" },
                  displayName: "A",
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
                  data: { data: "B" },
                  displayName: "B",
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
                data: null,
              },
            },
          }),
        },
      }
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
        [ExecutionVersion.V0]: {
          hashes: {
            foo: "715347facf54baa82ad66dafed5ed6f1f84eaf8a",
            A: "cfae9b35319fd155051a76b9208840185cecdc07",
            B: "1352bc51e5732952742e6d103747c954c16570f5",
          },
          tests: ({ foo, A, B }) => ({
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
              stack: {
                [foo]: { id: foo, data: { data: { foo: "foo" } } },
              },
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
              stack: {
                [foo]: { id: foo, data: { data: { foo: "bar" } } },
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
                [foo]: {
                  id: foo,
                  data: { data: { foo: "bar" } },
                },
                [B]: {
                  id: B,
                  data: "B",
                },
              },
              stackOrder: [foo, B],
              expectedReturn: {
                type: "function-resolved",
                data: null,
              },
            },
          }),
        },
        [ExecutionVersion.V1]: {
          hashes: {
            foo: "wait-id",
            A: "A",
            B: "B",
          },
          tests: ({ foo, A, B }) => ({
            "first run reports waitForEvent": {
              expectedReturn: {
                type: "steps-found",
                steps: [
                  expect.objectContaining({
                    op: StepOpCode.WaitForEvent,
                    name: "foo",
                    id: foo,
                    displayName: "wait-id",
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
                  data: { data: "A" },
                  displayName: "A",
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
                  data: { data: "B" },
                  displayName: "B",
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
                  data: { data: "B" },
                },
              },
              expectedReturn: {
                type: "function-resolved",
                data: null,
              },
            },
          }),
        },
      }
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
        [ExecutionVersion.V0]: {
          hashes: {
            A: "c0a4028e0b48a2eeff383fa7186fd2d3763f5412",
            B: "1b724c1e706194ce9fa9aa57c0fb1c5075c7f7f4",
            C: "b9996145f3de0c6073d3526ec18bb73be43e8bd6",
          },
          tests: ({ A, B, C }) => ({
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
            },

            "request following B returns empty response": {
              stack: {
                [B]: {
                  id: B,
                  data: "B",
                },
              },
              expectedReturn: {
                type: "steps-found",
                steps: [] as unknown as [OutgoingOp, ...OutgoingOp[]],
              },
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
            },

            "request with B,A order runs C step": {
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
              stackOrder: [B, A],
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
              stackOrder: [B, A, C],
              expectedReturn: {
                type: "function-resolved",
                data: null,
              },
            },
          }),
        },
        [ExecutionVersion.V1]: {
          hashes: {
            A: "A",
            B: "B",
            C: "C",
          },
          tests: ({ A, B, C }) => ({
            "first run reports A and B steps": {
              expectedReturn: {
                type: "steps-found",
                steps: [
                  expect.objectContaining({
                    id: A,
                    name: "A",
                    op: StepOpCode.StepPlanned,
                    displayName: "A",
                  }),
                  expect.objectContaining({
                    id: B,
                    name: "B",
                    op: StepOpCode.StepPlanned,
                    displayName: "B",
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
                  data: { data: "B" },
                  displayName: "B",
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
                    displayName: "A",
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
                  data: { data: "A" },
                  displayName: "A",
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
                    displayName: "C",
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
                  data: { data: "C" },
                  displayName: "C",
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
                data: null,
              },
            },
          }),
        },
      }
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
        [ExecutionVersion.V0]: {
          hashes: {
            A: "c0a4028e0b48a2eeff383fa7186fd2d3763f5412",
            B: "1b724c1e706194ce9fa9aa57c0fb1c5075c7f7f4",
            AWins: "",
            BWins: "bfdc2902cd708525bec677c1ad15fffff4bdccca",
          },
          tests: ({ A, B, BWins }) => ({
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
            },

            "request following B runs 'B wins' step": {
              stack: { [B]: { id: B, data: "B" } },
              expectedReturn: {
                type: "step-ran",
                step: expect.objectContaining({
                  id: BWins,
                  name: "B wins",
                  op: StepOpCode.RunStep,
                  data: "B wins",
                }),
              },
              expectedStepsRun: ["BWins"],
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
            },

            "request following A returns empty response": {
              stack: {
                [B]: { id: B, data: "B" },
                [A]: { id: A, data: "A" },
              },
              stackOrder: [B, A],
              expectedReturn: {
                type: "steps-found",
                steps: [] as unknown as [OutgoingOp, ...OutgoingOp[]],
              },
            },
          }),
        },
        [ExecutionVersion.V1]: {
          hashes: {
            A: "A",
            B: "B",
            AWins: "A wins",
            BWins: "B wins",
          },
          tests: ({ A, B, AWins, BWins }) => ({
            "first run reports A and B steps": {
              expectedReturn: {
                type: "steps-found",
                steps: [
                  expect.objectContaining({
                    id: A,
                    name: "A",
                    op: StepOpCode.StepPlanned,
                    displayName: "A",
                  }),
                  expect.objectContaining({
                    id: B,
                    name: "B",
                    op: StepOpCode.StepPlanned,
                    displayName: "B",
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
                  data: { data: "B" },
                  displayName: "B",
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
                    displayName: "A",
                  }),
                  expect.objectContaining({
                    id: BWins,
                    name: "B wins",
                    op: StepOpCode.StepPlanned,
                    displayName: "B wins",
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
                  data: { data: "A" },
                  displayName: "A",
                }),
              },
              expectedStepsRun: ["A"],
              disableImmediateExecution: true,
            },

            "request following 'B wins' re-reports missing 'A' step": {
              stack: {
                [B]: { id: B, data: "B" },
                [BWins]: { id: BWins, data: "B wins" },
              },
              stackOrder: [B, BWins],
              expectedReturn: {
                type: "steps-found",
                steps: [
                  expect.objectContaining({
                    id: A,
                    name: "A",
                    op: StepOpCode.StepPlanned,
                    displayName: "A",
                  }),
                ],
              },
              disableImmediateExecution: true,
            },

            "request following A completion resolves": {
              stack: {
                [A]: { id: A, data: "A" },
                [B]: { id: B, data: "B" },
                [BWins]: { id: BWins, data: "B wins" },
              },
              stackOrder: [B, BWins, A],
              expectedReturn: { type: "function-resolved", data: null },
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
                    displayName: "B",
                  }),
                  expect.objectContaining({
                    id: AWins,
                    name: "A wins",
                    op: StepOpCode.StepPlanned,
                    displayName: "A wins",
                  }),
                ],
              },
              disableImmediateExecution: true,
            },
          }),
        },
      }
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
        [ExecutionVersion.V0]: {
          hashes: {
            A: "c0a4028e0b48a2eeff383fa7186fd2d3763f5412",
            B: "1b724c1e706194ce9fa9aa57c0fb1c5075c7f7f4",
            B2: "e363452a9ca7762e772c235cf97ced4e7db51bd6",
            AWins: "",
            BWins: "c2592f0bf963b94c594c24431460a66bae8fa60f",
          },
          tests: ({ A, B, B2, BWins }) => ({
            "if B chain wins without 'A', runs 'B wins' step": {
              stack: {
                [B]: { id: B, data: "B" },
                [B2]: { id: B2, data: "B2" },
              },
              stackOrder: [B, B2],
              expectedReturn: {
                type: "step-ran",
                step: expect.objectContaining({
                  id: BWins,
                  name: "B wins",
                  op: StepOpCode.RunStep,
                  data: "B wins",
                }),
              },
              expectedStepsRun: ["BWins"],
            },
            "if B chain wins with 'A' afterwards, reports no steps to run": {
              stack: {
                [B]: { id: B, data: "B" },
                [B2]: { id: B2, data: "B2" },
                [A]: { id: A, data: "A" },
              },
              stackOrder: [B, B2, A],
              expectedReturn: {
                type: "steps-found",
                steps: [] as unknown as [OutgoingOp, ...OutgoingOp[]],
              },
            },
          }),
        },
        [ExecutionVersion.V1]: {
          hashes: {
            A: "A",
            B: "B",
            B2: "B2",
            AWins: "A wins",
            BWins: "B wins",
          },
          tests: ({ A, B, B2, BWins }) => ({
            "if B chain wins without 'A', reports 'A' and 'B wins' steps": {
              stack: {
                [B]: { id: B, data: "B" },
                [B2]: { id: B2, data: "B2" },
              },
              expectedReturn: {
                type: "steps-found",
                steps: [
                  expect.objectContaining({
                    id: A,
                    name: "A",
                    op: StepOpCode.StepPlanned,
                    displayName: "A",
                  }),
                  expect.objectContaining({
                    id: BWins,
                    name: "B wins",
                    op: StepOpCode.StepPlanned,
                    displayName: "B wins",
                  }),
                ],
              },
              disableImmediateExecution: true,
            },
            "if B chain wins after with 'A' afterwards, reports 'B wins' step":
              {
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
                      displayName: "B wins",
                    }),
                  ],
                },
                disableImmediateExecution: true,
              },
          }),
        },
      }
    );

    testFn(
      "step indexing in sequence",
      () => {
        const A = jest.fn(() => "A");
        const B = jest.fn(() => "B");
        const C = jest.fn(() => "C");

        const id = "A";

        const fn = inngest.createFunction(
          { id: "name" },
          { event: "foo" },
          async ({ step: { run } }) => {
            await run(id, A);
            await run(id, B);
            await run(id, C);
          }
        );

        return { fn, steps: { A, B, C } };
      },
      {
        // This is not performed in v0 executions.
        [ExecutionVersion.V0]: null,
        [ExecutionVersion.V1]: {
          hashes: {
            A: "A",
            B: `A${STEP_INDEXING_SUFFIX}1`,
            C: `A${STEP_INDEXING_SUFFIX}2`,
          },
          tests: ({ A, B, C }) => ({
            "first run runs A step": {
              expectedReturn: {
                type: "step-ran",
                step: expect.objectContaining({
                  id: A,
                  name: "A",
                  op: StepOpCode.RunStep,
                  data: { data: "A" },
                  displayName: "A",
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
                  data: { data: "B" },
                  displayName: "A",
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
                  data: { data: "C" },
                  displayName: "A",
                }),
              },
              expectedStepsRun: ["C"],
            },
          }),
        },
      }
    );

    testFn(
      "step indexing synchronously",
      () => {
        const A = jest.fn(() => "A");
        const B = jest.fn(() => "B");
        const C = jest.fn(() => "C");

        const id = "A";

        const fn = inngest.createFunction(
          { id: "name" },
          { event: "foo" },
          async ({ step: { run } }) => {
            await Promise.all([run(id, A), run(id, B), run(id, C)]);
          }
        );

        return { fn, steps: { A, B, C } };
      },
      {
        // This is not performed in v0 executions.
        [ExecutionVersion.V0]: null,
        [ExecutionVersion.V1]: {
          hashes: {
            A: "A",
            B: `A${STEP_INDEXING_SUFFIX}1`,
            C: `A${STEP_INDEXING_SUFFIX}2`,
          },
          tests: ({ A, B, C }) => ({
            "first run reports all steps": {
              expectedReturn: {
                type: "steps-found",
                steps: [
                  expect.objectContaining({
                    id: A,
                    name: "A",
                    op: StepOpCode.StepPlanned,
                    displayName: "A",
                  }),
                  expect.objectContaining({
                    id: B,
                    name: "A",
                    op: StepOpCode.StepPlanned,
                    displayName: "A",
                  }),
                  expect.objectContaining({
                    id: C,
                    name: "A",
                    op: StepOpCode.StepPlanned,
                    displayName: "A",
                  }),
                ],
              },
            },
          }),
        },
      }
    );

    testFn(
      "step indexing in parallel",
      () => {
        const A = jest.fn(() => "A");
        const B = jest.fn(() => "B");

        const id = "A";
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

        const fn = inngest.createFunction(
          { id: "name" },
          { event: "foo" },
          async ({ step: { run } }) => {
            await run(id, A);
            await wait(200);
            await run(id, B);
          }
        );

        return { fn, steps: { A, B } };
      },
      {
        // This is not performed in v0 executions.
        [ExecutionVersion.V0]: null,
        [ExecutionVersion.V1]: {
          hashes: {
            A: "A",
            B: `A${STEP_INDEXING_SUFFIX}1`,
            C: `A${STEP_INDEXING_SUFFIX}2`,
          },
          tests: ({ A, B }) => ({
            "first run runs A step": {
              expectedReturn: {
                type: "step-ran",
                step: expect.objectContaining({
                  id: A,
                  name: "A",
                  op: StepOpCode.RunStep,
                  data: { data: "A" },
                  displayName: "A",
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
                  data: { data: "B" },
                  displayName: "A",
                }),
              },
              expectedStepsRun: ["B"],
              expectedWarnings: [ErrCode.AUTOMATIC_PARALLEL_INDEXING],
            },
          }),
        },
      }
    );

    testFn(
      "step indexing in parallel with separated indexes",
      () => {
        const A = jest.fn(() => "A");
        const B = jest.fn(() => "B");
        const C = jest.fn(() => "C");

        const id = "A";
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

        const fn = inngest.createFunction(
          { id: "name" },
          { event: "foo" },
          async ({ step: { run } }) => {
            await Promise.all([run(id, A), run(id, B)]);
            await wait(200);
            await run(id, C);
          }
        );

        return { fn, steps: { A, B, C } };
      },
      {
        // This is not performed in v0 executions.
        [ExecutionVersion.V0]: null,
        [ExecutionVersion.V1]: {
          hashes: {
            A: "A",
            B: `A${STEP_INDEXING_SUFFIX}1`,
            C: `A${STEP_INDEXING_SUFFIX}2`,
          },
          tests: ({ A, B, C }) => ({
            "request with A,B in stack reports C step": {
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
                type: "steps-found",
                steps: [
                  expect.objectContaining({
                    id: C,
                    name: "A",
                    op: StepOpCode.StepPlanned,
                    displayName: "A",
                  }),
                ],
              },
              expectedWarnings: [ErrCode.AUTOMATIC_PARALLEL_INDEXING],
              disableImmediateExecution: true,
            },
          }),
        },
      }
    );

    testFn(
      "silently handle step error",
      () => {
        const A = jest.fn(() => "A");
        const B = jest.fn(() => {
          throw "B failed message";
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
        [ExecutionVersion.V0]: {
          hashes: {
            A: "c0a4028e0b48a2eeff383fa7186fd2d3763f5412",
            B: "1b724c1e706194ce9fa9aa57c0fb1c5075c7f7f4",
            BFailed: "0ccca8a0c6463bcf972afb233f1f0baa47d90cc3",
          },
          tests: ({ A, B, BFailed }) => ({
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

            "request following A returns empty response": {
              stack: { [A]: { id: A, data: "A" } },
              expectedReturn: {
                type: "steps-found",
                steps: [] as unknown as [OutgoingOp, ...OutgoingOp[]],
              },
            },

            "requesting to run B runs B, which fails": {
              runStep: B,
              expectedReturn: {
                type: "step-ran",
                step: expect.objectContaining({
                  id: B,
                  name: "B",
                  op: StepOpCode.RunStep,
                  error: matchError("B failed message"),
                  retriable: true,
                }),
              },
              expectedErrors: ["B failed message"],
              expectedStepsRun: ["B"],
            },

            "request following B runs 'B failed' step": {
              stack: {
                [A]: { id: A, data: "A" },
                [B]: { id: B, error: "B" },
              },
              stackOrder: [A, B],
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

            "final request returns return value": {
              stack: {
                [A]: { id: A, data: "A" },
                [B]: { id: B, error: "B" },
                [BFailed]: { id: BFailed, data: "B failed" },
              },
              stackOrder: [A, B, BFailed],
              expectedReturn: {
                type: "function-resolved",
                data: ["A", "B failed"],
              },
            },
          }),
        },
        [ExecutionVersion.V1]: {
          hashes: {
            A: "A",
            B: "B",
            BFailed: "B failed",
          },
          tests: ({ A, B, BFailed }) => ({
            "first run reports A and B steps": {
              expectedReturn: {
                type: "steps-found",
                steps: [
                  expect.objectContaining({
                    id: A,
                    name: "A",
                    op: StepOpCode.StepPlanned,
                    displayName: "A",
                  }),
                  expect.objectContaining({
                    id: B,
                    name: "B",
                    op: StepOpCode.StepPlanned,
                    displayName: "B",
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
                  data: { data: "A" },
                  displayName: "A",
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
                    displayName: "B",
                  }),
                ],
              },
            },

            "requesting to run B runs B, which fails": {
              disableImmediateExecution: true,
              runStep: B,
              expectedReturn: {
                type: "function-rejected",
                error: matchError("B failed message"),
                retriable: true,
              },
              expectedStepsRun: ["B"],
              expectedErrors: ["B failed message"],
            },

            "request following B reports 'B failed' step": {
              disableImmediateExecution: true,
              stack: {
                [A]: { id: A, data: "A" },
                [B]: { id: B, error: "B failed message" },
              },
              expectedReturn: {
                type: "steps-found",
                steps: [
                  expect.objectContaining({
                    id: BFailed,
                    name: "B failed",
                    op: StepOpCode.StepPlanned,
                    displayName: "B failed",
                  }),
                ],
              },
            },

            "requesting to run 'B failed' runs 'B failed'": {
              disableImmediateExecution: true,
              stack: {
                [A]: { id: A, data: "A" },
                [B]: { id: B, error: "B failed message" },
              },
              runStep: BFailed,
              expectedReturn: {
                type: "step-ran",
                step: expect.objectContaining({
                  id: BFailed,
                  name: "B failed",
                  op: StepOpCode.RunStep,
                  data: { data: "B failed" },
                  displayName: "B failed",
                }),
              },
              expectedStepsRun: ["BFailed"],
            },

            "final request returns empty response": {
              disableImmediateExecution: true,
              stack: {
                [A]: { id: A, data: "A" },
                [B]: { id: B, error: "B failed message" },
                [BFailed]: { id: BFailed, data: "B failed" },
              },
              expectedReturn: {
                type: "function-resolved",
                data: ["A", "B failed"],
              },
            },
          }),
        },
      }
    );

    testFn(
      "throws a NonRetriableError when one is thrown inside a step",
      () => {
        const A = jest.fn(() => {
          throw new NonRetriableError("A error message");
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
        [ExecutionVersion.V0]: {
          hashes: {
            A: "c0a4028e0b48a2eeff383fa7186fd2d3763f5412",
          },
          tests: ({ A }) => ({
            "first run executes A, which throws a NonRetriable error": {
              expectedReturn: {
                type: "step-ran",
                step: expect.objectContaining({
                  id: A,
                  name: "A",
                  op: StepOpCode.RunStep,
                  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                  error: matchError(new NonRetriableError("A error message")),
                }),
              },
              expectedErrors: ["A error message"],
              expectedStepsRun: ["A"],
            },
          }),
        },
        [ExecutionVersion.V1]: {
          hashes: {
            A: "A",
          },
          tests: () => ({
            "first run executes A, which throws a NonRetriable error": {
              expectedReturn: {
                type: "function-rejected",
                retriable: false,
                error: matchError(new NonRetriableError("A error message")),
              },
              expectedStepsRun: ["A"],
              expectedErrors: ["A error message"],
            },
          }),
        },
      }
    );

    testFn(
      "throws a NonRetriableError when thrown inside the main function body",
      () => {
        const fn = inngest.createFunction(
          { id: "Foo" },
          { event: "foo" },
          async () => {
            throw new NonRetriableError("Error message");
          }
        );

        return { fn, steps: {} };
      },
      {
        [ExecutionVersion.V0]: {
          hashes: {
            A: "c0a4028e0b48a2eeff383fa7186fd2d3763f5412",
          },
          tests: () => ({
            "throws a NonRetriableError": {
              expectedReturn: {
                type: "function-rejected",
                retriable: false,
                error: matchError(new NonRetriableError("Error message")),
              },
              expectedErrors: ["Error message"],
            },
          }),
        },
        [ExecutionVersion.V1]: {
          hashes: {},
          tests: () => ({
            "throws a NonRetriableError": {
              expectedReturn: {
                type: "function-rejected",
                retriable: false,
                error: matchError(new NonRetriableError("Error message")),
              },
              expectedErrors: ["Error message"],
              expectedStepsRun: [],
            },
          }),
        },
      }
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
      {
        [ExecutionVersion.V0]: {
          hashes: {},
          tests: () => ({
            "throws a retriable error": {
              expectedReturn: {
                type: "function-rejected",
                retriable: true,
                error: matchError("foo"),
              },
              expectedErrors: ["foo"],
            },
          }),
        },
        [ExecutionVersion.V1]: {
          hashes: {},
          tests: () => ({
            "throws a retriable error": {
              expectedReturn: {
                type: "function-rejected",
                retriable: true,
                error: matchError("foo"),
              },
              expectedErrors: ["foo"],
              expectedStepsRun: [],
            },
          }),
        },
      }
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
      {
        [ExecutionVersion.V0]: {
          hashes: {},
          tests: () => ({
            "throws a retriable error": {
              expectedReturn: {
                type: "function-rejected",
                retriable: true,
                error: matchError({}),
              },
              expectedErrors: ["{}"],
            },
          }),
        },
        [ExecutionVersion.V1]: {
          hashes: {},
          tests: () => ({
            "throws a retriable error": {
              expectedReturn: {
                type: "function-rejected",
                retriable: true,
                error: matchError({}),
              },
              expectedErrors: ["{}"],
              expectedStepsRun: [],
            },
          }),
        },
      }
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
        [ExecutionVersion.V0]: {
          hashes: {
            A: "c0a4028e0b48a2eeff383fa7186fd2d3763f5412",
            B: "b494def3936f5c59986e81bc29443609bfc2384a",
          },
          tests: ({ A, B }) => ({
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
              stackOrder: [A, B],
              expectedReturn: {
                type: "function-resolved",
                data: null,
              },
            },
          }),
        },
        [ExecutionVersion.V1]: {
          hashes: {
            A: "A",
            B: "B",
          } as const,
          tests: ({ A, B }) => ({
            "first run runs A step": {
              expectedReturn: {
                type: "step-ran",
                step: expect.objectContaining({
                  id: A,
                  name: "A",
                  op: StepOpCode.RunStep,
                  data: { data: "A" },
                  displayName: "A",
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
                  data: { data: "B" },
                  displayName: "B",
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
                data: null,
              },
            },
          }),
        },
      }
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
        [ExecutionVersion.V0]: {
          hashes: {
            A: "c0a4028e0b48a2eeff383fa7186fd2d3763f5412",
            B: "b494def3936f5c59986e81bc29443609bfc2384a",
          },
          tests: ({ A, B }) => ({
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
                data: null,
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
          }),
        },
        [ExecutionVersion.V1]: {
          hashes: {
            A: "A",
            B: "B",
          },
          tests: ({ A, B }) => ({
            "first run runs A step": {
              expectedReturn: {
                type: "step-ran",
                step: expect.objectContaining({
                  id: A,
                  name: "A",
                  op: StepOpCode.RunStep,
                  data: { data: "A" },
                  displayName: "A",
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
                  data: { data: "B" },
                  displayName: "B",
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
                data: null,
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
          }),
        },
      }
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
