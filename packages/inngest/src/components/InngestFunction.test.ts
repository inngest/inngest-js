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
import type { Mock } from "vitest";
import { ExecutionVersion, internalEvents } from "../helpers/consts.ts";
import {
  ErrCode,
  OutgoingResultError,
  serializeError,
} from "../helpers/errors.ts";
import type { IsEqual } from "../helpers/types.ts";
import {
  type EventPayload,
  Middleware,
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
import { _internals as _engineInternals } from "./execution/engine.ts";
import {
  type ExecutionResult,
  type ExecutionResults,
  type InngestExecutionOptions,
  PREFERRED_ASYNC_EXECUTION_VERSION,
} from "./execution/InngestExecution.ts";
import { InngestFunction } from "./InngestFunction.ts";
import { STEP_INDEXING_SUFFIX } from "./InngestStepTools.ts";

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
  logger: mockLogger,
  /**
   * Create some test middleware that purposefully takes time for every hook.
   * This ensures that the engine accounts for the potential time taken by
   * middleware to run.
   */
  middleware: [
    class MockMiddleware extends Middleware.BaseMiddleware {
      #delay() {
        return new Promise<void>((resolve) =>
          setTimeout(() => setTimeout(resolve)),
        );
      }

      override async wrapFunctionHandler({
        next,
      }: Middleware.WrapFunctionHandlerArgs) {
        await this.#delay();
        return next();
      }
    },
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

          beforeAll(async () => {
            vi.restoreAllMocks();
            vi.spyOn(ProxyLogger.prototype, "flush").mockImplementation(
              async () => {
                /* noop */
              },
            );

            fn = new InngestFunction(
              createClient(opts),
              { id: "Foo", triggers: [{ event: "foo" }] },
              flowFn,
            );

            const execution = fn["createExecution"]({
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
    const getHashDataSpy = () => vi.spyOn(_engineInternals, "hashOp");

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
      specs: {
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
      },
    ) => {
      const { hashes, tests } = specs;

      const processedHashes = Object.fromEntries(
        Object.entries(hashes).map(([key, value]) => {
          return [key, _engineInternals.hashId(value)];
        }),
      ) as typeof hashes;

      describe(fnName, () => {
        // biome-ignore lint/complexity/noForEach: intentional
        Object.entries(tests(processedHashes)).forEach(([name, t]) => {
          describe(name, () => {
            let hashDataSpy: ReturnType<typeof getHashDataSpy>;
            let tools: T;
            let ret: Awaited<ReturnType<typeof runFnWithStack>> | undefined;
            let retErr: Error | undefined;
            beforeAll(() => {
              vi.restoreAllMocks();
              vi.resetModules();
              clearLogger();
              clearConsole();
              hashDataSpy = getHashDataSpy();
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
                    const call = mockLogger.warn.mock.calls[i];
                    const found = call?.some((arg: unknown) => {
                      if (typeof arg === "string") {
                        return arg.includes(warning);
                      }
                      if (arg && typeof arg === "object") {
                        return JSON.stringify(arg).includes(warning);
                      }
                      return false;
                    });
                    expect(found).toBe(true);
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
                    const serialized = JSON.stringify(
                      call,
                      (_key: string, value: unknown) => {
                        if (value instanceof Error) {
                          return serializeError(value);
                        }
                        return value;
                      },
                    );

                    expect(serialized).toContain(error);
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

            if (
              ret &&
              (ret.type === "step-ran" || ret.type === "steps-found")
            ) {
              test("output hashes match expected shape", () => {
                // Horrible syntax for TS 4.7+ compatibility - lack of narrowing
                const outgoingOps: OutgoingOp[] =
                  ret!.type === "step-ran"
                    ? [(ret as Extract<typeof ret, { type: "step-ran" }>)!.step]
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
    };

    testFn(
      "simple A to B",
      () => {
        const A = vi.fn(() => "A");
        const B = vi.fn(() => "B");

        const fn = inngest.createFunction(
          { id: "name", triggers: [{ event: "foo" }] },
          async ({ step: { run } }) => {
            await run("A", A);
            await run("B", B);
          },
        );

        return { fn, steps: { A, B } };
      },
      {
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
    );

    testFn(
      "change path based on data",
      () => {
        const A = vi.fn(() => "A");
        const B = vi.fn(() => "B");

        const fn = inngest.createFunction(
          { id: "name", triggers: [{ event: "foo" }] },
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
            stack: {
              [foo]: { id: foo, data: { name: "foo", data: { foo: "foo" } } },
            },
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
            stack: {
              [foo]: { id: foo, data: { name: "foo", data: { foo: "bar" } } },
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
              [foo]: {
                id: foo,
                data: { name: "foo", data: { foo: "bar" } },
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
    );

    testFn(
      "Promise.all",
      () => {
        const A = vi.fn(() => "A");
        const B = vi.fn(() => "B");
        const C = vi.fn(() => "C");

        const fn = inngest.createFunction(
          { id: "name", triggers: [{ event: "foo" }] },
          async ({ step: { run } }) => {
            await Promise.all([run("A", A), run("B", B)]);
            await run("C", C);
          },
        );

        return { fn, steps: { A, B, C } };
      },
      {
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
    );

    testFn(
      "Promise.race",
      () => {
        const A = vi.fn(() => Promise.resolve("A"));
        const B = vi.fn(() => Promise.resolve("B"));
        const AWins = vi.fn(() => Promise.resolve("A wins"));
        const BWins = vi.fn(() => Promise.resolve("B wins"));

        const fn = inngest.createFunction(
          { id: "name", triggers: [{ event: "foo" }] },
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
          { id: "name", triggers: [{ event: "foo" }] },
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
                  displayName: "B wins",
                }),
              ],
            },
            disableImmediateExecution: true,
          },
        }),
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
          { id: "name", triggers: [{ event: "foo" }] },
          async ({ step: { run } }) => {
            await run(id, A);
            await run(id, B);
            await run(id, C);
          },
        );

        return { fn, steps: { A, B, C } };
      },
      {
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
    );

    testFn(
      "step indexing synchronously",
      () => {
        const A = vi.fn(() => "A");
        const B = vi.fn(() => "B");
        const C = vi.fn(() => "C");

        const id = "A";

        const fn = inngest.createFunction(
          { id: "name", triggers: [{ event: "foo" }] },
          async ({ step: { run } }) => {
            await Promise.all([run(id, A), run(id, B), run(id, C)]);
          },
        );

        return { fn, steps: { A, B, C } };
      },
      {
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
    );

    testFn(
      "step indexing in parallel",
      () => {
        const A = vi.fn(() => "A");
        const B = vi.fn(() => "B");

        const id = "A";
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

        const fn = inngest.createFunction(
          { id: "name", triggers: [{ event: "foo" }] },
          async ({ step: { run } }) => {
            await run(id, A);
            await wait(200);
            await run(id, B);
          },
        );

        return { fn, steps: { A, B } };
      },
      {
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
          { id: "name", triggers: [{ event: "foo" }] },
          async ({ step: { run } }) => {
            await Promise.all([run(id, A), run(id, B)]);
            await wait(200);
            await run(id, C);
          },
        );

        return { fn, steps: { A, B, C } };
      },
      {
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
          { id: "name", triggers: [{ event: "foo" }] },
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
    );

    testFn(
      "throws a NonRetriableError when one is thrown inside a step",
      () => {
        const A = vi.fn(() => {
          throw new NonRetriableError("A error message");
        });

        const fn = inngest.createFunction(
          { id: "Foo", triggers: [{ event: "foo" }] },
          async ({ step: { run } }) => {
            await run("A", A);
          },
        );

        return { fn, steps: { A } };
      },
      {
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
    );

    testFn(
      "throws a NonRetriableError when thrown inside the main function body",
      () => {
        const fn = inngest.createFunction(
          { id: "Foo", triggers: [{ event: "foo" }] },
          async () => {
            throw new NonRetriableError("Error message");
          },
        );

        return { fn, steps: {} };
      },
      {
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
    );

    testFn(
      "NonRetriableError in step should use StepFailed opcode (not StepError) even on early attempts",
      () => {
        const A = vi.fn(() => {
          throw new NonRetriableError("Should not retry this step");
        });

        const fn = inngest.createFunction(
          { id: "Foo", triggers: [{ event: "foo" }] },
          async ({ step: { run } }) => {
            await run("A", A);
          },
        );

        return { fn, steps: { A } };
      },
      {
        hashes: {
          A: "A",
        },
        tests: ({ A }) => ({
          "first run executes A, which throws NonRetriableError -> should use StepFailed":
            {
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
    );

    testFn(
      "detects NonRetriableError by name when instanceof fails",
      () => {
        const fn = inngest.createFunction(
          { id: "Foo", triggers: [{ event: "foo" }] },
          async () => {
            const error = new Error("Simulated monorepo error");
            error.name = "NonRetriableError";
            throw error;
          },
        );

        return { fn, steps: {} };
      },
      {
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
    );

    testFn(
      "detects RetryAfterError by name when instanceof fails",
      () => {
        const fn = inngest.createFunction(
          { id: "Foo", triggers: [{ event: "foo" }] },
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
    );

    testFn(
      "throws a retriable error when a string is thrown inside the main function body",
      () => {
        const fn = inngest.createFunction(
          { id: "Foo", triggers: [{ event: "foo" }] },
          async () => {
            throw "foo";
          },
        );

        return { fn, steps: {} };
      },
      {
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
    );

    testFn(
      "throws a retriable error when an empty object is thrown inside the main function body",
      () => {
        const fn = inngest.createFunction(
          { id: "Foo", triggers: [{ event: "foo" }] },
          async () => {
            throw {};
          },
        );

        return { fn, steps: {} };
      },
      {
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
    );

    testFn(
      "handle onFailure calls",
      () => {
        const A = vi.fn(() => "A");
        const B = vi.fn(() => "B");

        const fn = inngest.createFunction(
          {
            id: "name",
            triggers: [{ event: "foo" }],
            onFailure: async ({ step: { run } }) => {
              await run("A", A);
              await run("B", B);
            },
          },
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
          { id: "name", triggers: [{ event: "foo" }] },
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
                expect(mockLogger.info.mock.calls).toEqual([["info1"], ["A"]]);
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
              triggers: [{ event: "test" }],
              onFailure: ({ error, event }) => {
                assertType<`${internalEvents.FunctionFailed}`>(event.name);
                assertType<FailureEventPayload>(event);
                assertType<Error>(error);
              },
            },
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
      });

      const fn = inngest.createFunction(
        {
          id: "testfn",
          triggers: [{ event: "foo" }],
          onFailure: () => {
            // no-op
          },
        },
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
            {
              id: "test",
              cancelOn: [{ event: "anything" }],
              triggers: [{ event: "test" }],
            },
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
              triggers: [{ event: "test" }],
            },
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
      });

      const fn = inngest.createFunction(
        {
          id: "testfn",
          cancelOn: [{ event: "baz", match: "data.title" }],
          triggers: [{ event: "foo" }],
        },
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

  // TODO: Rewrite sync mode middleware tests with new middleware system.
  // The old InngestMiddleware transformOutput tests were removed because
  // the new Middleware.BaseMiddleware system uses different hooks.
  describe.todo("sync mode (checkpointing) middleware");
});

describe("PREFERRED execution version constants", () => {
  test("PREFERRED_ASYNC_EXECUTION_VERSION is V2", () => {
    expect(PREFERRED_ASYNC_EXECUTION_VERSION).toBe(ExecutionVersion.V2);
  });
});
