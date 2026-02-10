globalThis.console = {
  ...globalThis.console,
  log: vi.fn(() => undefined),
  warn: vi.fn(() => undefined),
  error: vi.fn(() => undefined),
};

const clearConsole = () => {
  // biome-ignore lint/suspicious/noExplicitAny: intentional
  (globalThis.console.log as any).mockClear();
  // biome-ignore lint/suspicious/noExplicitAny: intentional
  (globalThis.console.warn as any).mockClear();
  // biome-ignore lint/suspicious/noExplicitAny: intentional
  (globalThis.console.error as any).mockClear();
};

import { fromPartial } from "@total-typescript/shoehorn";
import type { Mock, MockInstance } from "vitest";
import { ExecutionVersion, internalEvents } from "../helpers/consts.ts";
import {
  ErrCode,
  OutgoingResultError,
  serializeError,
} from "../helpers/errors.ts";
import type { IsEqual } from "../helpers/types.ts";
import {
  type EventPayload,
  EventSchemas,
  InngestMiddleware,
  NonRetriableError,
  RetryAfterError,
} from "../index.ts";
import { type Logger, ProxyLogger } from "../middleware/logger.ts";
import { createClient, runFnWithStack } from "../test/helpers.ts";
import {
  type ClientOptions,
  type FailureEventPayload,
  type OutgoingOp,
  StepMode,
  StepOpCode,
} from "../types.ts";
import {
  type ExecutionResult,
  type ExecutionResults,
  type InngestExecutionOptions,
  PREFERRED_ASYNC_EXECUTION_VERSION,
  PREFERRED_CHECKPOINTING_EXECUTION_VERSION,
} from "./execution/InngestExecution.ts";
import { _internals as _v1Internals } from "./execution/v1.ts";
import { _internals as _v2Internals } from "./execution/v2.ts";
import { InngestFunction } from "./InngestFunction.ts";
import { STEP_INDEXING_SUFFIX } from "./InngestStepTools.ts";

type TestEvents = {
  foo: { data: { foo: string } };
  bar: { data: { bar: string } };
  baz: { data: { baz: string } };
};

const schemas = new EventSchemas().fromRecord<TestEvents>();

const mockLogger = {
  info: vi.fn(globalThis.console.log),
  warn: vi.fn(globalThis.console.warn),
  error: vi.fn(globalThis.console.error),
  debug: vi.fn(globalThis.console.debug),
};

const clearLogger = () => {
  mockLogger.info.mockClear();
  mockLogger.warn.mockClear();
  mockLogger.error.mockClear();
  mockLogger.debug.mockClear();
};

const opts = (<T extends ClientOptions>(x: T): T => x)({
  id: "test",
  eventKey: "event-key-123",
  schemas,
  logger: mockLogger,
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
              finished: mockHook,
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

// biome-ignore lint/suspicious/noExplicitAny: intentional
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

    // biome-ignore lint/complexity/noForEach: intentional
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
          let fn: InngestFunction.Any;
          let ret: ExecutionResult;
          let flush: MockInstance<() => void>;

          beforeAll(async () => {
            vi.restoreAllMocks();
            flush = vi
              .spyOn(ProxyLogger.prototype, "flush")
              .mockImplementation(async () => {
                /* noop */
              });

            fn = new InngestFunction(
              createClient(opts),
              { id: "Foo", triggers: [{ event: "foo" }] },
              flowFn,
            );

            const execution = fn["createExecution"]({
              version: PREFERRED_ASYNC_EXECUTION_VERSION,
              partialOptions: {
                client: fn["client"],
                data: fromPartial({
                  event: { name: "foo", data: { foo: "foo" } },
                }),
                runId: "run",
                stepState: {},
                stepCompletionOrder: [],
                reqArgs: [],
                headers: {},
                stepMode: StepMode.Async,
              },
            });

            ret = await execution.start();
          });

          test("returns is not op on success", () => {
            expect(ret.type).toBe("function-resolved");
          });

          test("returns data on success", () => {
            expect((ret as ExecutionResults["function-resolved"]).data).toBe(
              stepRet,
            );
          });

          test("should attempt to flush logs", () => {
            expect(flush).toHaveBeenCalledTimes(1);
          });
        });

        describe("throws", () => {
          const stepErr = new Error("step error");
          let fn: InngestFunction.Any;

          beforeAll(() => {
            fn = new InngestFunction(
              createClient(opts),
              { id: "Foo", triggers: [{ event: "foo" }] },
              badFlowFn,
            );
          });

          test("wrap thrown error", async () => {
            const execution = fn["createExecution"]({
              version: PREFERRED_ASYNC_EXECUTION_VERSION,
              partialOptions: {
                client: fn["client"],
                data: fromPartial({
                  event: { name: "foo", data: { foo: "foo" } },
                }),
                stepState: {},
                runId: "run",
                stepCompletionOrder: [],
                reqArgs: [],
                headers: {},
                stepMode: StepMode.Async,
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
    const getHashDataSpy = () => vi.spyOn(_v1Internals, "hashOp");

    const executionIdHashes: Partial<
      Record<ExecutionVersion, (id: string) => string>
    > = {
      [ExecutionVersion.V1]: _v1Internals.hashId,
      [ExecutionVersion.V2]: _v2Internals.hashId,
    };

    const testFn = <
      T extends {
        fn: InngestFunction.Any;
        steps: Record<
          string,
          // biome-ignore lint/suspicious/noExplicitAny: intentional
          | Mock<(...args: any[]) => string>
          // biome-ignore lint/suspicious/noExplicitAny: intentional
          | Mock<(...args: any[]) => Promise<string>>
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
      >,
    ) => {
      // biome-ignore lint/complexity/noForEach: intentional
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
                }),
              ) as typeof hashes)
            : hashes;

          // biome-ignore lint/complexity/noForEach: intentional
          Object.entries(tests(processedHashes)).forEach(([name, t]) => {
            describe(name, () => {
              let hashDataSpy: ReturnType<typeof getHashDataSpy>;
              let tools: T;
              let ret: Awaited<ReturnType<typeof runFnWithStack>> | undefined;
              let retErr: Error | undefined;
              let flush: MockInstance<() => void>;

              beforeAll(() => {
                vi.restoreAllMocks();
                vi.resetModules();
                clearLogger();
                clearConsole();
                flush = vi
                  .spyOn(ProxyLogger.prototype, "flush")
                  .mockImplementation(async () => {
                    /* noop */
                  });
                hashDataSpy = getHashDataSpy();
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
                      : (retErr?.message ?? ""),
                  ).toContain(t.expectedThrowMessage);
                });
              } else {
                test("returns expected value", () => {
                  expect(ret).toEqual(t.expectedReturn);
                });
              }

              if (t.expectedHashOps?.length) {
                test("hashes expected ops", () => {
                  // biome-ignore lint/complexity/noForEach: intentional
                  t.expectedHashOps?.forEach((h) => {
                    expect(hashDataSpy).toHaveBeenCalledWith(h);
                  });
                });
              }

              if (t.expectedWarnings?.length) {
                describe("warning logs", () => {
                  t.expectedWarnings?.forEach((warning, i) => {
                    test(`warning log #${i + 1} includes "${warning}"`, () => {
                      expect(mockLogger.warn).toHaveBeenNthCalledWith(
                        i + 1,
                        expect.stringContaining(warning),
                      );
                    });
                  });
                });
              } else {
                test("no warning logs", () => {
                  expect(mockLogger.warn).not.toHaveBeenCalled();
                });
              }

              if (t.expectedErrors?.length) {
                describe("error logs", () => {
                  t.expectedErrors?.forEach((error, i) => {
                    test(`error log #${i + 1} includes "${error}"`, () => {
                      // biome-ignore lint/suspicious/noExplicitAny: intentional
                      const call = (mockLogger.error as any).mock.calls[i];
                      const stringifiedArgs =
                        call?.map((arg: unknown) => {
                          return arg instanceof Error
                            ? serializeError(arg)
                            : arg;
                        }) ?? "";

                      expect(JSON.stringify(stringifiedArgs)).toContain(error);
                    });
                  });
                });
              } else {
                test("no error logs", () => {
                  expect(mockLogger.error).not.toHaveBeenCalled();
                });
              }

              test("runs expected steps", () => {
                // biome-ignore lint/complexity/noForEach: intentional
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
                  // Horrible syntax for TS 4.7+ compatibility - lack of narrowing
                  const outgoingOps: OutgoingOp[] =
                    ret!.type === "step-ran"
                      ? [
                          (ret as Extract<typeof ret, { type: "step-ran" }>)!
                            .step,
                        ]
                      : ret!.type === "steps-found"
                        ? (ret as Extract<typeof ret, { type: "steps-found" }>)!
                            .steps
                        : [];

                  // biome-ignore lint/complexity/noForEach: intentional
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
        const A = vi.fn(() => "A");
        const B = vi.fn(() => "B");

        const fn = inngest.createFunction(
          { id: "name" },
          { event: "foo" },
          async ({ step: { run } }) => {
            await run("A", A);
            await run("B", B);
          },
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
                  op: StepOpCode.Step,
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
                  op: StepOpCode.Step,
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
                  op: StepOpCode.StepRun,
                  data: "A",
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
                  op: StepOpCode.StepRun,
                  data: "B",
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
        [ExecutionVersion.V2]: {
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
                  op: StepOpCode.StepRun,
                  data: "A",
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
                  op: StepOpCode.StepRun,
                  data: "B",
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
      },
    );

    testFn(
      "change path based on data",
      () => {
        const A = vi.fn(() => "A");
        const B = vi.fn(() => "B");

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
          },
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
                  op: StepOpCode.Step,
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
                  op: StepOpCode.Step,
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
                  op: StepOpCode.StepRun,
                  data: "A",
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
                  op: StepOpCode.StepRun,
                  data: "B",
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
        [ExecutionVersion.V2]: {
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
                  op: StepOpCode.StepRun,
                  data: "A",
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
                  op: StepOpCode.StepRun,
                  data: "B",
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
      },
    );

    testFn(
      "Promise.all",
      () => {
        const A = vi.fn(() => "A");
        const B = vi.fn(() => "B");
        const C = vi.fn(() => "C");

        const fn = inngest.createFunction(
          { id: "name" },
          { event: "foo" },
          async ({ step: { run } }) => {
            await Promise.all([run("A", A), run("B", B)]);
            await run("C", C);
          },
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
                  op: StepOpCode.Step,
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
                  op: StepOpCode.Step,
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
                  op: StepOpCode.Step,
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
                  op: StepOpCode.StepRun,
                  data: "B",
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
                  op: StepOpCode.StepRun,
                  data: "A",
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
                  op: StepOpCode.StepRun,
                  data: "C",
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
        [ExecutionVersion.V2]: {
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
                  op: StepOpCode.StepRun,
                  data: "B",
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
                  op: StepOpCode.StepRun,
                  data: "A",
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
                  op: StepOpCode.StepRun,
                  data: "C",
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
      },
    );

    testFn(
      "Promise.race",
      () => {
        const A = vi.fn(() => Promise.resolve("A"));
        const B = vi.fn(() => Promise.resolve("B"));
        const AWins = vi.fn(() => Promise.resolve("A wins"));
        const BWins = vi.fn(() => Promise.resolve("B wins"));

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
          },
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
                  op: StepOpCode.Step,
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
                  op: StepOpCode.Step,
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
                  op: StepOpCode.Step,
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
                  op: StepOpCode.StepRun,
                  data: "B",
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
                  op: StepOpCode.StepRun,
                  data: "A",
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
        [ExecutionVersion.V2]: null,
      },
    );

    testFn(
      "Deep Promise.race",
      () => {
        const A = vi.fn(() => Promise.resolve("A"));
        const B = vi.fn(() => Promise.resolve("B"));
        const B2 = vi.fn(() => Promise.resolve("B2"));
        const AWins = vi.fn(() => Promise.resolve("A wins"));
        const BWins = vi.fn(() => Promise.resolve("B wins"));

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
          },
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
                  op: StepOpCode.Step,
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
        [ExecutionVersion.V2]: null,
      },
    );

    testFn(
      "step indexing in sequence",
      () => {
        const A = vi.fn(() => "A");
        const B = vi.fn(() => "B");
        const C = vi.fn(() => "C");

        const id = "A";

        const fn = inngest.createFunction(
          { id: "name" },
          { event: "foo" },
          async ({ step: { run } }) => {
            await run(id, A);
            await run(id, B);
            await run(id, C);
          },
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
                  op: StepOpCode.StepRun,
                  data: "A",
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
                  op: StepOpCode.StepRun,
                  data: "B",
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
                  op: StepOpCode.StepRun,
                  data: "C",
                  displayName: "A",
                }),
              },
              expectedStepsRun: ["C"],
            },
          }),
        },
        [ExecutionVersion.V2]: {
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
                  op: StepOpCode.StepRun,
                  data: "A",
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
                  op: StepOpCode.StepRun,
                  data: "B",
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
                  op: StepOpCode.StepRun,
                  data: "C",
                  displayName: "A",
                }),
              },
              expectedStepsRun: ["C"],
            },
          }),
        },
      },
    );

    testFn(
      "step indexing synchronously",
      () => {
        const A = vi.fn(() => "A");
        const B = vi.fn(() => "B");
        const C = vi.fn(() => "C");

        const id = "A";

        const fn = inngest.createFunction(
          { id: "name" },
          { event: "foo" },
          async ({ step: { run } }) => {
            await Promise.all([run(id, A), run(id, B), run(id, C)]);
          },
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
        [ExecutionVersion.V2]: {
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
      },
    );

    testFn(
      "step indexing in parallel",
      () => {
        const A = vi.fn(() => "A");
        const B = vi.fn(() => "B");

        const id = "A";
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

        const fn = inngest.createFunction(
          { id: "name" },
          { event: "foo" },
          async ({ step: { run } }) => {
            await run(id, A);
            await wait(200);
            await run(id, B);
          },
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
                  op: StepOpCode.StepRun,
                  data: "A",
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
                  op: StepOpCode.StepRun,
                  data: "B",
                  displayName: "A",
                }),
              },
              expectedStepsRun: ["B"],
              expectedWarnings: [ErrCode.AUTOMATIC_PARALLEL_INDEXING],
            },
          }),
        },
        [ExecutionVersion.V2]: {
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
                  op: StepOpCode.StepRun,
                  data: "A",
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
                  op: StepOpCode.StepRun,
                  data: "B",
                  displayName: "A",
                }),
              },
              expectedStepsRun: ["B"],
            },
          }),
        },
      },
    );

    testFn(
      "step indexing in parallel with separated indexes",
      () => {
        const A = vi.fn(() => "A");
        const B = vi.fn(() => "B");
        const C = vi.fn(() => "C");

        const id = "A";
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

        const fn = inngest.createFunction(
          { id: "name" },
          { event: "foo" },
          async ({ step: { run } }) => {
            await Promise.all([run(id, A), run(id, B)]);
            await wait(200);
            await run(id, C);
          },
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
        [ExecutionVersion.V2]: {
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
              disableImmediateExecution: true,
            },
          }),
        },
      },
    );

    testFn(
      "silently handle step error",
      () => {
        const A = vi.fn(() => "A");
        const B = vi.fn(() => {
          throw "B failed message";
        });
        const BFailed = vi.fn(() => "B failed");

        const fn = inngest.createFunction(
          { id: "name" },
          { event: "foo" },
          async ({ step: { run } }) => {
            return Promise.all([
              run("A", A),
              run("B", B).catch(() => run("B failed", BFailed)),
            ]);
          },
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
                  op: StepOpCode.Step,
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
                  op: StepOpCode.Step,
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
                  op: StepOpCode.Step,
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
                  op: StepOpCode.StepRun,
                  data: "A",
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
                type: "step-ran",
                retriable: true,
                step: expect.objectContaining({
                  id: B,
                  name: "B",
                  displayName: "B",
                  op: StepOpCode.StepError,
                  error: matchError("B failed message"),
                }),
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
                  op: StepOpCode.StepRun,
                  data: "B failed",
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
        [ExecutionVersion.V2]: {
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
                  op: StepOpCode.StepRun,
                  data: "A",
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
                type: "step-ran",
                retriable: true,
                step: expect.objectContaining({
                  id: B,
                  name: "B",
                  displayName: "B",
                  op: StepOpCode.StepError,
                  error: matchError("B failed message"),
                }),
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
                  op: StepOpCode.StepRun,
                  data: "B failed",
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
      },
    );

    testFn(
      "throws a NonRetriableError when one is thrown inside a step",
      () => {
        const A = vi.fn(() => {
          throw new NonRetriableError("A error message");
        });

        const fn = inngest.createFunction(
          { id: "Foo" },
          { event: "foo" },
          async ({ step: { run } }) => {
            await run("A", A);
          },
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
                  op: StepOpCode.Step,
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
          tests: ({ A }) => ({
            "first run executes A, which throws a NonRetriable error": {
              expectedReturn: {
                type: "step-ran",
                retriable: false,
                step: expect.objectContaining({
                  id: A,
                  name: "A",
                  displayName: "A",
                  op: StepOpCode.StepFailed,
                  error: matchError(new NonRetriableError("A error message")),
                }),
              },
              expectedStepsRun: ["A"],
              expectedErrors: ["A error message"],
            },
          }),
        },
        [ExecutionVersion.V2]: {
          hashes: {
            A: "A",
          },
          tests: ({ A }) => ({
            "first run executes A, which throws a NonRetriable error": {
              expectedReturn: {
                type: "step-ran",
                retriable: false,
                step: expect.objectContaining({
                  id: A,
                  name: "A",
                  displayName: "A",
                  op: StepOpCode.StepFailed,
                  error: matchError(new NonRetriableError("A error message")),
                }),
              },
              expectedStepsRun: ["A"],
              expectedErrors: ["A error message"],
            },
          }),
        },
      },
    );

    testFn(
      "throws a NonRetriableError when thrown inside the main function body",
      () => {
        const fn = inngest.createFunction(
          { id: "Foo" },
          { event: "foo" },
          async () => {
            throw new NonRetriableError("Error message");
          },
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
        [ExecutionVersion.V2]: {
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
      },
    );

    testFn(
      "NonRetriableError in step should use StepFailed opcode (not StepError) even on early attempts",
      () => {
        const A = vi.fn(() => {
          throw new NonRetriableError("Should not retry this step");
        });

        const fn = inngest.createFunction(
          { id: "Foo" },
          { event: "foo" },
          async ({ step: { run } }) => {
            await run("A", A);
          },
        );

        return { fn, steps: { A } };
      },
      {
        [ExecutionVersion.V0]: {
          hashes: {
            A: "c0a4028e0b48a2eeff383fa7186fd2d3763f5412",
          },
          tests: ({ A }) => ({
            "V0 doesn't use StepFailed opcode, uses Step with error": {
              expectedReturn: {
                type: "step-ran",
                step: expect.objectContaining({
                  id: A,
                  name: "A",
                  op: StepOpCode.Step,
                  error: matchError(
                    new NonRetriableError("Should not retry this step"),
                  ),
                }),
              },
              expectedErrors: ["Should not retry this step"],
              expectedStepsRun: ["A"],
            },
          }),
        },
        [ExecutionVersion.V1]: {
          hashes: {
            A: "A",
          },
          tests: ({ A }) => ({
            "first run executes A, which throws NonRetriableError -> should use StepFailed":
              {
                // Set attempt to 0 and maxAttempts to 4 to ensure we're not at max attempts
                // This tests that NonRetriableError triggers StepFailed regardless of attempt count
                fnArg: {
                  attempt: 0,
                  maxAttempts: 4,
                },
                expectedReturn: {
                  type: "step-ran",
                  retriable: false,
                  step: expect.objectContaining({
                    id: A,
                    name: "A",
                    displayName: "A",
                    op: StepOpCode.StepFailed, // This should be StepFailed, not StepError
                    error: matchError(
                      new NonRetriableError("Should not retry this step"),
                    ),
                  }),
                },
                expectedStepsRun: ["A"],
                expectedErrors: ["Should not retry this step"],
              },
          }),
        },
        [ExecutionVersion.V2]: {
          hashes: {
            A: "A",
          },
          tests: ({ A }) => ({
            "first run executes A, which throws NonRetriableError -> should use StepFailed":
              {
                // Set attempt to 0 and maxAttempts to 4 to ensure we're not at max attempts
                fnArg: {
                  attempt: 0,
                  maxAttempts: 4,
                },
                expectedReturn: {
                  type: "step-ran",
                  retriable: false,
                  step: expect.objectContaining({
                    id: A,
                    name: "A",
                    displayName: "A",
                    op: StepOpCode.StepFailed, // This should be StepFailed, not StepError
                    error: matchError(
                      new NonRetriableError("Should not retry this step"),
                    ),
                  }),
                },
                expectedStepsRun: ["A"],
                expectedErrors: ["Should not retry this step"],
              },
          }),
        },
      },
    );

    testFn(
      "detects NonRetriableError by name when instanceof fails",
      () => {
        const fn = inngest.createFunction(
          { id: "Foo" },
          { event: "foo" },
          async () => {
            const error = new Error("Simulated monorepo error");
            error.name = "NonRetriableError";
            throw error;
          },
        );

        return { fn, steps: {} };
      },
      {
        [ExecutionVersion.V0]: {
          hashes: {},
          tests: () => ({
            "detects NonRetriableError by name and sets retriable to false": {
              expectedReturn: {
                type: "function-rejected",
                retriable: false,
                error: expect.objectContaining({
                  name: "NonRetriableError",
                  message: "Simulated monorepo error",
                }),
              },
              expectedErrors: ["Simulated monorepo error"],
            },
          }),
        },
        [ExecutionVersion.V1]: {
          hashes: {},
          tests: () => ({
            "detects NonRetriableError by name and sets retriable to false": {
              expectedReturn: {
                type: "function-rejected",
                retriable: false,
                error: expect.objectContaining({
                  name: "NonRetriableError",
                  message: "Simulated monorepo error",
                }),
              },
              expectedErrors: ["Simulated monorepo error"],
              expectedStepsRun: [],
            },
          }),
        },
        [ExecutionVersion.V2]: {
          hashes: {},
          tests: () => ({
            "detects NonRetriableError by name and sets retriable to false": {
              expectedReturn: {
                type: "function-rejected",
                retriable: false,
                error: expect.objectContaining({
                  name: "NonRetriableError",
                  message: "Simulated monorepo error",
                }),
              },
              expectedErrors: ["Simulated monorepo error"],
              expectedStepsRun: [],
            },
          }),
        },
      },
    );

    testFn(
      "detects RetryAfterError by name when instanceof fails",
      () => {
        const fn = inngest.createFunction(
          { id: "Foo" },
          { event: "foo" },
          async () => {
            const error = new Error(
              "Simulated monorepo retry error",
            ) as Error & { retryAfter: string };
            error.name = "RetryAfterError";
            error.retryAfter = "30";
            throw error;
          },
        );

        return { fn, steps: {} };
      },
      {
        [ExecutionVersion.V0]: {
          hashes: {},
          tests: () => ({
            "detects RetryAfterError by name and sets retriable to retryAfter value":
              {
                expectedReturn: {
                  type: "function-rejected",
                  retriable: "30",
                  error: expect.objectContaining({
                    name: "RetryAfterError",
                    message: "Simulated monorepo retry error",
                  }),
                },
                expectedErrors: ["Simulated monorepo retry error"],
              },
          }),
        },
        [ExecutionVersion.V1]: {
          hashes: {},
          tests: () => ({
            "detects RetryAfterError by name and sets retriable to retryAfter value":
              {
                expectedReturn: {
                  type: "function-rejected",
                  retriable: "30",
                  error: expect.objectContaining({
                    name: "RetryAfterError",
                    message: "Simulated monorepo retry error",
                  }),
                },
                expectedErrors: ["Simulated monorepo retry error"],
                expectedStepsRun: [],
              },
          }),
        },
        [ExecutionVersion.V2]: {
          hashes: {},
          tests: () => ({
            "detects RetryAfterError by name and sets retriable to retryAfter value":
              {
                expectedReturn: {
                  type: "function-rejected",
                  retriable: "30",
                  error: expect.objectContaining({
                    name: "RetryAfterError",
                    message: "Simulated monorepo retry error",
                  }),
                },
                expectedErrors: ["Simulated monorepo retry error"],
                expectedStepsRun: [],
              },
          }),
        },
      },
    );

    testFn(
      "throws a retriable error when a string is thrown inside the main function body",
      () => {
        const fn = inngest.createFunction(
          { id: "Foo" },
          { event: "foo" },
          async () => {
            throw "foo";
          },
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
        [ExecutionVersion.V2]: {
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
      },
    );

    testFn(
      "throws a retriable error when an empty object is thrown inside the main function body",
      () => {
        const fn = inngest.createFunction(
          { id: "Foo" },
          { event: "foo" },
          async () => {
            throw {};
          },
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
        [ExecutionVersion.V2]: {
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
      },
    );

    testFn(
      "handle onFailure calls",
      () => {
        const A = vi.fn(() => "A");
        const B = vi.fn(() => "B");

        const fn = inngest.createFunction(
          {
            id: "name",
            onFailure: async ({ step: { run } }) => {
              await run("A", A);
              await run("B", B);
            },
          },
          { event: "foo" },
          () => undefined,
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
                  op: StepOpCode.Step,
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
                  op: StepOpCode.Step,
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
                  op: StepOpCode.Step,
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
                  op: StepOpCode.StepRun,
                  data: "A",
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
                  op: StepOpCode.StepRun,
                  data: "B",
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
        [ExecutionVersion.V2]: {
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
                  op: StepOpCode.StepRun,
                  data: "A",
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
                  op: StepOpCode.StepRun,
                  data: "B",
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
      },
    );

    testFn(
      "can use built-in logger middleware",
      () => {
        const A = vi.fn((logger: Logger) => {
          logger.info("A");
          return "A";
        });

        const B = vi.fn((logger: Logger) => {
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
          },
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
                  op: StepOpCode.Step,
                  data: "A",
                }),
              },
              expectedStepsRun: ["A"],
              customTests() {
                test("log called", () => {
                  expect(mockLogger.info.mock.calls).toEqual([
                    ["info1"],
                    ["A"],
                  ]);
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
                  op: StepOpCode.Step,
                  data: "B",
                }),
              },
              expectedStepsRun: ["B"],
              customTests() {
                test("log called", () => {
                  expect(mockLogger.info.mock.calls).toEqual([["2"], ["B"]]);
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
                test("log called", () => {
                  expect(mockLogger.info.mock.calls).toEqual([["3"]]);
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
                  op: StepOpCode.StepRun,
                  data: "A",
                  displayName: "A",
                }),
              },
              expectedStepsRun: ["A"],
              customTests() {
                test("log called", () => {
                  expect(mockLogger.info.mock.calls).toEqual([
                    ["info1"],
                    ["A"],
                  ]);
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
                  op: StepOpCode.StepRun,
                  data: "B",
                  displayName: "B",
                }),
              },
              expectedStepsRun: ["B"],
              customTests() {
                test("log called", () => {
                  expect(mockLogger.info.mock.calls).toEqual([["2"], ["B"]]);
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
                test("log called", () => {
                  expect(mockLogger.info.mock.calls).toEqual([["3"]]);
                });
              },
            },
          }),
        },
        [ExecutionVersion.V2]: {
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
                  op: StepOpCode.StepRun,
                  data: "A",
                  displayName: "A",
                }),
              },
              expectedStepsRun: ["A"],
              customTests() {
                test("log called", () => {
                  expect(mockLogger.info.mock.calls).toEqual([
                    ["info1"],
                    ["A"],
                  ]);
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
                  op: StepOpCode.StepRun,
                  data: "B",
                  displayName: "B",
                }),
              },
              expectedStepsRun: ["B"],
              customTests() {
                test("log called", () => {
                  expect(mockLogger.info.mock.calls).toEqual([["2"], ["B"]]);
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
                test("log called", () => {
                  expect(mockLogger.info.mock.calls).toEqual([["3"]]);
                });
              },
            },
          }),
        },
      },
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
            },
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
            },
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
        },
      );

      expect(fn).toBeInstanceOf(InngestFunction);

      const [fnConfig, failureFnConfig] = fn["getConfig"]({
        baseUrl: new URL("https://example.com"),
        appPrefix: clientId,
      });

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
            },
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
            },
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
            },
          );
        });

        test("allows known event name", () => {
          inngest.createFunction(
            { id: "test", cancelOn: [{ event: "bar" }] },
            { event: "foo" },
            () => {
              // no-op
            },
          );
        });

        test("allows known event name with a field match", () => {
          inngest.createFunction(
            {
              id: "test",
              cancelOn: [{ event: "baz", match: "data.title" }],
            },
            { event: "foo" },
            () => {
              // no-op
            },
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
        },
      );

      const [fnConfig] = fn["getConfig"]({
        baseUrl: new URL("https://example.com"),
        appPrefix: clientId,
      });

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

  describe("sync mode (checkpointing) middleware", () => {
    // Helper to create a mock ActionResponse for sync mode tests
    const mockCreateResponse = (data: unknown) => ({
      status: 200,
      headers: {},
      body: JSON.stringify(data),
      version: PREFERRED_CHECKPOINTING_EXECUTION_VERSION,
    });

    describe("function-resolved", () => {
      test("should call transformOutput middleware in sync mode", async () => {
        const transformOutputMock = vi.fn(({ result }) => ({
          result: {
            ...result,
            data: {
              ...result.data,
              __extra: true,
            },
          },
        }));

        const clientWithMiddleware = createClient({
          ...opts,
          middleware: [
            new InngestMiddleware({
              name: "TestTransformOutput",
              init: () => ({
                onFunctionRun: () => ({
                  transformOutput: transformOutputMock,
                }),
              }),
            }),
          ],
        });

        // Mock the checkpoint API to prevent actual HTTP calls
        Object.defineProperty(clientWithMiddleware, "inngestApi", {
          value: {
            checkpointNewRun: vi.fn().mockResolvedValue({
              data: { app_id: "app", fn_id: "fn", token: "token" },
            }),
            checkpointSteps: vi.fn().mockResolvedValue({}),
          },
          writable: true,
        });

        const fn = new InngestFunction(
          clientWithMiddleware,
          { id: "SyncTransformTest", triggers: [{ event: "foo" }] },
          () => {
            return { result: "success" };
          },
        );

        const execution = fn["createExecution"]({
          version: PREFERRED_CHECKPOINTING_EXECUTION_VERSION,
          partialOptions: {
            client: fn["client"],
            data: fromPartial({
              event: { name: "foo", data: { foo: "foo" } },
            }),
            runId: "run",
            stepState: {},
            stepCompletionOrder: [],
            reqArgs: [],
            headers: {},
            stepMode: StepMode.Sync,
            createResponse: mockCreateResponse,
          },
        });

        const result = await execution.start();

        expect(result.type).toBe("function-resolved");
        // In sync mode, transformOutput is called twice:
        // 1. Once to transform data for checkpointing
        // 2. Once to transform data for the SDK return value
        expect(transformOutputMock).toHaveBeenCalledTimes(2);
        expect(transformOutputMock).toHaveBeenCalledWith(
          expect.objectContaining({
            result: expect.objectContaining({
              data: { result: "success" },
            }),
          }),
        );
        // @ts-expect-error - result.data is not defined
        expect(result.data).toMatchObject({
          result: "success",
          __extra: true,
        });
      });
    });

    describe("function-rejected", () => {
      test("should call transformOutput middleware in sync mode on final attempt", async () => {
        const transformOutputMock = vi.fn(({ result }) => ({ result }));

        const clientWithMiddleware = createClient({
          ...opts,
          middleware: [
            new InngestMiddleware({
              name: "TestTransformOutput",
              init: () => ({
                onFunctionRun: () => ({
                  transformOutput: transformOutputMock,
                }),
              }),
            }),
          ],
        });

        // Mock the checkpoint API to prevent actual HTTP calls
        Object.defineProperty(clientWithMiddleware, "inngestApi", {
          value: {
            checkpointNewRun: vi.fn().mockResolvedValue({
              data: { app_id: "app", fn_id: "fn", token: "token" },
            }),
            checkpointSteps: vi.fn().mockResolvedValue({}),
          },
          writable: true,
        });

        const testError = new Error("test error");

        const fn = new InngestFunction(
          clientWithMiddleware,
          { id: "SyncTransformErrorTest", triggers: [{ event: "foo" }] },
          () => {
            throw testError;
          },
        );

        const execution = fn["createExecution"]({
          version: PREFERRED_CHECKPOINTING_EXECUTION_VERSION,
          partialOptions: {
            client: fn["client"],
            data: fromPartial({
              event: { name: "foo", data: { foo: "foo" } },
              attempt: 2, // On attempt 2 with maxAttempts 3, this is the final attempt (2 + 1 >= 3)
              maxAttempts: 3,
            }),
            runId: "run",
            stepState: {},
            stepCompletionOrder: [],
            reqArgs: [],
            headers: {},
            stepMode: StepMode.Sync,
            createResponse: mockCreateResponse,
          },
        });

        const result = await execution.start();

        expect(result.type).toBe("function-rejected");
        expect(transformOutputMock).toHaveBeenCalledTimes(1);
        expect(transformOutputMock).toHaveBeenCalledWith(
          expect.objectContaining({
            result: expect.objectContaining({
              error: testError,
            }),
          }),
        );
      });
    });

    describe("step data transformation", () => {
      test("should call transformOutput middleware for step data in sync mode (v2)", async () => {
        const transformOutputMock = vi.fn(({ result }) => {
          // Transform the data (simulating encryption)
          if (result.data !== undefined) {
            return {
              result: { data: { encrypted: true, original: result.data } },
            };
          }
          return { result };
        });

        const clientWithMiddleware = createClient({
          ...opts,
          middleware: [
            new InngestMiddleware({
              name: "TestTransformOutput",
              init: () => ({
                onFunctionRun: () => ({
                  transformOutput: transformOutputMock,
                }),
              }),
            }),
          ],
        });

        const checkpointNewRun = vi.fn().mockResolvedValue({
          data: {
            app_id: "test",
            fn_id: "SyncStepTransformTest",
            token: "token",
          },
        });
        const checkpointSteps = vi.fn().mockResolvedValue({});

        // Mock the checkpoint API to prevent actual HTTP calls
        Object.defineProperty(clientWithMiddleware, "inngestApi", {
          value: {
            checkpointNewRun,
            checkpointSteps,
          },
          writable: true,
        });

        const fn = new InngestFunction(
          clientWithMiddleware,
          {
            id: "SyncStepTransformTest",
            triggers: [{ event: "foo" }],
            checkpointing: true,
          },
          async ({ step }) => {
            const result = await step.run("test-step", () => {
              return { stepData: "hello" };
            });
            return { final: result };
          },
        );

        const execution = fn["createExecution"]({
          version: PREFERRED_CHECKPOINTING_EXECUTION_VERSION,
          partialOptions: {
            client: fn["client"],
            data: fromPartial({
              runId: "01KG8JS019P1M1H0N3H6N8Q761",
              event: { name: "foo", data: { foo: "foo" } },
            }),
            runId: "01KG8JS019P1M1H0N3H6N8Q761",
            stepState: {},
            stepCompletionOrder: [],
            reqArgs: [],
            headers: {},
            stepMode: StepMode.Sync,
            createResponse: mockCreateResponse,
            checkpointingConfig: {
              maxRuntime: "60s",
              bufferedSteps: 1,
              maxInterval: "1s",
            },
          },
        });

        await execution.start();

        // In sync mode with checkpointing, the result type depends on whether
        // we switch to async or not. Since we have a step, we expect the
        // execution to eventually complete or checkpoint.
        // The transformOutput should be called for the step result.
        expect(transformOutputMock).toHaveBeenCalled();

        // Verify that transformOutput was called with step data
        const calls = transformOutputMock.mock.calls;
        const stepDataCall = calls.find(
          (call) =>
            call[0]?.result?.data !== undefined &&
            typeof call[0]?.result?.data === "object" &&
            "stepData" in call[0].result.data,
        );
        expect(stepDataCall).toBeDefined();
        expect(checkpointNewRun).toHaveBeenCalledWith(
          expect.objectContaining({
            steps: expect.arrayContaining([
              expect.objectContaining({
                data: { encrypted: true, original: { stepData: "hello" } },
              }),
            ]),
          }),
        );
        expect(checkpointSteps).toHaveBeenCalledWith({
          appId: "test",
          runId: "01KG8JS019P1M1H0N3H6N8Q761",
          fnId: "SyncStepTransformTest",
          steps: [
            {
              id: "0737c22d3bfae812339732d14d8c7dbd6dc4e09c",
              op: "RunComplete",
              data: {
                // The final function result is { final: { stepData: "hello" } }
                // which gets encrypted by transformOutput middleware
                body: '{"encrypted":true,"original":{"final":{"stepData":"hello"}}}',
                headers: {},
                status: 200,
                version: 2,
              },
            },
          ],
        });
      });

      test("should call transformOutput middleware for step data in sync mode (v1)", async () => {
        const transformOutputMock = vi.fn(({ result }) => {
          // Transform the data (simulating encryption)
          if (result.data !== undefined) {
            return {
              result: { data: { encrypted: true, original: result.data } },
            };
          }
          return { result };
        });

        const clientWithMiddleware = createClient({
          ...opts,
          middleware: [
            new InngestMiddleware({
              name: "TestTransformOutput",
              init: () => ({
                onFunctionRun: () => ({
                  transformOutput: transformOutputMock,
                }),
              }),
            }),
          ],
        });

        const checkpointNewRun = vi.fn().mockResolvedValue({
          data: {
            app_id: "test",
            fn_id: "SyncStepTransformTest",
            token: "token",
          },
        });
        const checkpointSteps = vi.fn().mockResolvedValue({});

        // Mock the checkpoint API to prevent actual HTTP calls
        Object.defineProperty(clientWithMiddleware, "inngestApi", {
          value: {
            checkpointNewRun,
            checkpointSteps,
          },
          writable: true,
        });

        const fn = new InngestFunction(
          clientWithMiddleware,
          {
            id: "SyncStepTransformTest",
            triggers: [{ event: "foo" }],
            checkpointing: true,
          },
          async ({ step }) => {
            const result = await step.run("test-step", () => {
              return { stepData: "hello" };
            });
            return { final: result };
          },
        );

        const execution = fn["createExecution"]({
          version: PREFERRED_ASYNC_EXECUTION_VERSION,
          partialOptions: {
            client: fn["client"],
            data: fromPartial({
              runId: "01KG8JS019P1M1H0N3H6N8Q761",
              event: { name: "foo", data: { foo: "foo" } },
            }),
            runId: "01KG8JS019P1M1H0N3H6N8Q761",
            stepState: {},
            stepCompletionOrder: [],
            reqArgs: [],
            headers: {},
            stepMode: StepMode.Sync,
            createResponse: mockCreateResponse,
            checkpointingConfig: {
              maxRuntime: "60s",
              bufferedSteps: 1,
              maxInterval: "1s",
            },
          },
        });

        await execution.start();

        // In sync mode with checkpointing, the result type depends on whether
        // we switch to async or not. Since we have a step, we expect the
        // execution to eventually complete or checkpoint.
        // The transformOutput should be called for the step result.
        expect(transformOutputMock).toHaveBeenCalled();

        // Verify that transformOutput was called with step data
        const calls = transformOutputMock.mock.calls;
        const stepDataCall = calls.find(
          (call) =>
            call[0]?.result?.data !== undefined &&
            typeof call[0]?.result?.data === "object" &&
            "stepData" in call[0].result.data,
        );
        expect(stepDataCall).toBeDefined();
        expect(checkpointNewRun).toHaveBeenCalledWith(
          expect.objectContaining({
            steps: expect.arrayContaining([
              expect.objectContaining({
                data: { encrypted: true, original: { stepData: "hello" } },
              }),
            ]),
          }),
        );
        expect(checkpointSteps).toHaveBeenCalledWith({
          appId: "test",
          runId: "01KG8JS019P1M1H0N3H6N8Q761",
          fnId: "SyncStepTransformTest",
          steps: [
            {
              id: "0737c22d3bfae812339732d14d8c7dbd6dc4e09c",
              op: "RunComplete",
              data: {
                // The final function result is { final: { stepData: "hello" } }
                // which gets encrypted by transformOutput middleware
                body: '{"encrypted":true,"original":{"final":{"stepData":"hello"}}}',
                headers: {},
                status: 200,
                version: 2,
              },
            },
          ],
        });
      });

      test("should call transformOutput middleware for step data in async checkpointing mode", async () => {
        const transformOutputMock = vi.fn(({ result }) => {
          // Transform the data (simulating encryption)
          if (result.data !== undefined) {
            return {
              result: { data: { encrypted: true, original: result.data } },
            };
          }
          return { result };
        });

        const clientWithMiddleware = createClient({
          ...opts,
          middleware: [
            new InngestMiddleware({
              name: "TestTransformOutput",
              init: () => ({
                onFunctionRun: () => ({
                  transformOutput: transformOutputMock,
                }),
              }),
            }),
          ],
        });

        const checkpointNewRun = vi.fn().mockResolvedValue({
          data: {
            app_id: "app",
            fn_id: "fn",
            token: "token",
          },
        });
        const checkpointSteps = vi.fn().mockResolvedValue({});
        const checkpointStepsAsync = vi.fn().mockResolvedValue({});

        // Mock the checkpoint API to prevent actual HTTP calls
        Object.defineProperty(clientWithMiddleware, "inngestApi", {
          value: {
            checkpointNewRun,
            checkpointSteps,
            checkpointStepsAsync,
          },
          writable: true,
        });

        const fn = new InngestFunction(
          clientWithMiddleware,
          {
            id: "AsyncCheckpointStepTransformTest",
            triggers: [{ event: "foo" }],
            checkpointing: true,
          },
          async ({ step }) => {
            await step.run("test-step", () => {
              return { stepData: "hello" };
            });
            return { final: true };
          },
        );

        const execution = fn["createExecution"]({
          version: PREFERRED_CHECKPOINTING_EXECUTION_VERSION,
          partialOptions: {
            client: fn["client"],
            data: fromPartial({
              event: { name: "foo", data: { foo: "foo" } },
            }),
            runId: "run",
            stepState: {},
            stepCompletionOrder: [],
            reqArgs: [],
            headers: {},
            stepMode: StepMode.AsyncCheckpointing,
            queueItemId: "queue-item-id",
            internalFnId: "internal-fn-id",
          },
        });

        const executionResult = await execution.start();

        // In async checkpointing mode, transformOutput should be called for step data
        expect(transformOutputMock).toHaveBeenCalled();

        // Verify that transformOutput was called with step data
        const calls = transformOutputMock.mock.calls;
        const stepDataCall = calls.find(
          (call) =>
            call[0]?.result?.data !== undefined &&
            typeof call[0]?.result?.data === "object" &&
            "stepData" in call[0].result.data,
        );

        expect(stepDataCall).toBeDefined();
        // Async checkpointing uses checkpointStepsAsync, not checkpointNewRun or checkpointSteps
        expect(checkpointStepsAsync).toHaveBeenCalledTimes(1);
        expect(checkpointStepsAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            steps: expect.arrayContaining([
              expect.objectContaining({
                data: { encrypted: true, original: { stepData: "hello" } },
              }),
            ]),
          }),
        );
        expect(executionResult).toMatchObject({
          type: "steps-found",
          steps: expect.arrayContaining([
            expect.objectContaining({
              op: StepOpCode.RunComplete,
              data: {
                encrypted: true,
                original: { final: true },
              },
            }),
          ]),
        });
      });
    });
  });
});
