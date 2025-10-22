import { Context, EventPayload, InngestFunction } from "inngest";
import {
  errors,
  InngestExecution,
  InngestExecutionV1,
  ServerTiming,
} from "inngest/internals";
import { StepOpCode } from "inngest/types";
import { ulid } from "ulid";
import { InngestTestRun } from "./InngestTestRun.js";
import type { Mock } from "./spy.js";
import {
  createDeferredPromise,
  createMockEvent,
  type DeepPartial,
  mockCtx,
} from "./util.js";

/**
 * A test engine for running Inngest functions in a test environment, providing
 * the ability to assert inputs, outputs, and step usage, as well as mocking
 * with support for popular testing libraries.
 */
export namespace InngestTestEngine {
  /**
   * Options for creating a new {@link InngestTestEngine} instance.
   */
  export interface Options {
    /**
     * The function to test.
     *
     * TODO Potentially later allow many functions such that we can invoke and
     * send events.
     */
    function: InngestFunction.Like;

    /**
     * The event payloads to send to the function. If none is given, an
     * "inngest/function.invoked" event will be mocked.
     */
    events?: [EventPayload, ...EventPayload[]];

    /**
     * Previous step state to use for this execution. If not provided, none will
     * be used. It's recommended to use `run.waitFor()`, where this will be
     * filled automatically as the run progresses.
     */
    steps?: MockedStep[];

    /**
     * The human-readable ID of the step that this execution is attempting to
     * run. This is mostly an internal detail; it's recommended to use
     * `run.waitFor()`, where this will be filled automatically as the run
     * progresses.
     */
    targetStepId?: string;

    /**
     * An internal option to disable immediate execution of steps during
     * parallelism. It's recommended to use `run.waitFor()`, where this will be
     * filled automatically as the run progresses.
     */
    disableImmediateExecution?: boolean;

    /**
     * Request arguments that will be passed to the function execution.
     *
     * These can be used by middleware that relies on particular serve handler usage.
     * If not provided, an empty array will be used.
     */
    reqArgs?: unknown[];

    /**
     * A function that can transform the context sent to the function upon
     * execution, useful for mocking steps, events, or tracking property
     * accesses with proxies.
     *
     * By default, this will change all `step.*` tools to be mocked functions so
     * that you can assert their usage, input, and output. If you specify this
     * option yourself, you'll overwrite this behavior.
     *
     * If you wish to keep this behaviour and make additional changes, you can
     * use the `mockContext` function exported from this module.
     *
     * @example Transforming in addition to the defaults
     * ```ts
     * import { mockCtx } from "@inngest/test";
     *
     * {
     *   transformCtx: (rawCtx) => {
     *     const ctx = mockCtx(rawCtx);
     *
     *     // your other changes
     *
     *     return ctx;
     *   },
     * }
     * ```
     */
    transformCtx?: (ctx: Context.Any) => Context.Any;
  }

  export interface MockedStep {
    id: string;
    idIsHashed?: boolean;
    handler: () => any;
  }

  export type DeepMock<T> = T extends (...args: any[]) => any
    ? Mock<T>
    : T extends object
      ? { [K in keyof T]: DeepMock<T[K]> }
      : T;

  /**
   * A mocked context object that allows you to assert step usage, input, and
   * output.
   */
  export interface MockContext extends Omit<Context.Any, "step"> {
    step: DeepMock<Context.Any["step"]>;
  }

  /**
   * Options that can be passed to an existing execution or run to continue
   * execution.
   */
  export type InlineOptions = Omit<Options, "function">;

  /**
   * Options that can be passed to an initial execution that then waits for a
   * particular checkpoint to occur.
   */
  export type ExecuteOptions<
    T extends InngestTestRun.CheckpointKey = InngestTestRun.CheckpointKey,
  > = InlineOptions & {
    /**
     * An optional subset of the checkpoint to match against. Any checkpoint of
     * this type will be matched.
     *
     * When providing a `subset`, use `expect` tooling such as
     * `expect.stringContaining` to match partial values.
     */
    subset?: DeepPartial<InngestTestRun.Checkpoint<T>>;
  };

  export type ExecuteStepOptions = InlineOptions & {
    subset?: DeepPartial<InngestTestRun.Checkpoint<"steps-found">>;
  };

  /**
   * A mocked state object that allows you to assert step usage, input, and
   * output.
   */
  export type MockState = Record<string, Promise<unknown>>;

  /**
   * The output of an individual function execution.
   */
  export interface ExecutionOutput<
    T extends InngestTestRun.CheckpointKey = InngestTestRun.CheckpointKey,
  > {
    /**
     * The result of the execution.
     */
    result: InngestTestRun.Checkpoint<T>;

    /**
     * The mocked context object that allows you to assert step usage, input,
     * and output.
     *
     * @TODO This type may vary is `transformCtx` is given.
     */
    ctx: InngestTestEngine.MockContext;

    /**
     * The mocked state object that allows you to assert step usage, input, and
     * output.
     */
    state: InngestTestEngine.MockState;

    /**
     * An {@link InngestTestRun} instance that allows you to wait for specific
     * checkpoints in the execution.
     */
    run: InngestTestRun;
  }
}

interface InternalMemoizedOp extends InngestExecution.MemoizedOp {
  __lazyMockHandler?: (state: { data?: any; error?: any }) => Promise<void>;
  __mockResult?: Promise<any>;
}

/**
 * A test engine for running Inngest functions in a test environment, providing
 * the ability to assert inputs, outputs, and step usage, as well as mocking
 * with support for popular testing libraries.
 */
export class InngestTestEngine {
  protected options: InngestTestEngine.Options;

  constructor(options: InngestTestEngine.Options) {
    this.options = options;
  }

  /**
   * Create a new test engine with the given inline options merged with the
   * existing options.
   */
  public clone(
    inlineOpts?: InngestTestEngine.InlineOptions,
  ): InngestTestEngine {
    return new InngestTestEngine({ ...this.options, ...inlineOpts });
  }

  /**
   * Start a run from the given state and keep executing the function until a
   * specific checkpoint is reached.
   *
   * Is a shortcut for and uses `run.waitFor()`.
   */
  public async execute<T extends InngestTestRun.CheckpointKey>(
    /**
     * Options and state to start the run with.
     */
    inlineOpts?: InngestTestEngine.ExecuteOptions<T>,
  ): Promise<InngestTestRun.RunOutput> {
    const output = await this.individualExecution(inlineOpts);

    const resolutionHandler = (
      output: InngestTestEngine.ExecutionOutput<"function-resolved">,
    ) => {
      return {
        ctx: output.ctx,
        state: output.state,
        result: output.result.data,
      };
    };

    const rejectionHandler = (
      output: InngestTestEngine.ExecutionOutput<"function-rejected">,
    ) => {
      if (
        typeof output === "object" &&
        output !== null &&
        "ctx" in output &&
        "state" in output
      ) {
        let error = output.result.error;
        if (!error) {
          if (
            "step" in output.result &&
            typeof output.result.step === "object" &&
            output.result.step !== null &&
            "error" in output.result.step &&
            output.result.step.error
          ) {
            error = output.result.step.error;
          } else {
            error = new Error(
              "Function rejected without a visible error; this is a bug",
            );
          }
        }

        return {
          ctx: output.ctx,
          state: output.state,
          error,
        };
      }

      throw output;
    };

    if (output.result.type === "function-resolved") {
      return resolutionHandler(
        output as InngestTestEngine.ExecutionOutput<"function-resolved">,
      );
    } else if (output.result.type === "function-rejected") {
      return rejectionHandler(
        output as InngestTestEngine.ExecutionOutput<"function-rejected">,
      );
    } else if (output.result.type === "step-ran") {
      // Any error halts execution until retries are modelled
      if (
        (output as InngestTestEngine.ExecutionOutput<"step-ran">).result.step
          .error
      ) {
        return rejectionHandler(
          output as InngestTestEngine.ExecutionOutput<"function-rejected">,
        );
      }
    }

    return output.run
      .waitFor("function-resolved")
      .then<InngestTestRun.RunOutput>(resolutionHandler)
      .catch<InngestTestRun.RunOutput>(rejectionHandler);
  }

  /**
   * Start a run from the given state and keep executing the function until the
   * given step has run.
   */
  public async executeStep(
    /**
     * The ID of the step to execute.
     */
    stepId: string,

    /**
     * Options and state to start the run with.
     */
    inlineOpts?: InngestTestEngine.ExecuteOptions,
  ): Promise<InngestTestRun.RunStepOutput> {
    const { run, result: resultaaa } = await this.individualExecution({
      ...inlineOpts,
      // always overwrite this so it's easier to capture non-runnable steps in
      // the same flow.
      disableImmediateExecution: true,
    });

    const foundSteps = await run.waitFor("steps-found", {
      steps: [{ id: stepId }],
    });

    const hashedStepId = InngestExecutionV1._internals.hashId(stepId);

    const step = foundSteps.result.steps.find(
      (step) => step.id === hashedStepId,
    );

    // never found the step? Unexpected.
    if (!step) {
      throw new Error(
        `Step "${stepId}" not found, but execution was still paused. This is a bug.`,
      );
    }

    // if this is not a runnable step, return it now
    // runnable steps should return void
    //
    // some of these ops are nonsensical for the checkpoint we're waiting for,
    // but we consider them anyway to ensure that this type requires attention
    // if we add more opcodes
    const baseRet: InngestTestRun.RunStepOutput = {
      ctx: foundSteps.ctx,
      state: foundSteps.state,
      step,
    };

    const opHandlers: Record<
      StepOpCode,
      () => InngestTestRun.RunStepOutput | void
    > = {
      // runnable, so do nothing now
      [StepOpCode.StepPlanned]: () => {},

      [StepOpCode.InvokeFunction]: () => baseRet,
      [StepOpCode.Sleep]: () => baseRet,
      [StepOpCode.StepError]: () => ({ ...baseRet, error: step.error }),
      [StepOpCode.StepNotFound]: () => baseRet,
      [StepOpCode.StepRun]: () => ({ ...baseRet, result: step.data }),
      [StepOpCode.WaitForEvent]: () => baseRet,
      [StepOpCode.WaitForSignal]: () => baseRet,
      [StepOpCode.Step]: () => ({ ...baseRet, result: step.data }),
      [StepOpCode.AiGateway]: () => baseRet,
      [StepOpCode.Gateway]: () => baseRet,
    };

    const result = opHandlers[step.op]();
    if (result) {
      return result;
    }

    // otherwise, run the step and return the output
    const runOutput = await run.waitFor("step-ran", {
      step: { id: stepId },
    });

    return {
      ctx: runOutput.ctx,
      state: runOutput.state,
      result: runOutput.result.step.data,
      error: runOutput.result.step.error,
      step: runOutput.result.step,
    };
  }

  /**
   * Start a run from the given state and keep executing the function until a
   * specific checkpoint is reached.
   *
   * Is a shortcut for and uses `run.waitFor()`.
   *
   * @TODO This is a duplicate of `execute` and will probably be removed; it's a
   * very minor convenience method that deals too much with the internals.
   */
  protected async executeAndWaitFor<T extends InngestTestRun.CheckpointKey>(
    /**
     * The checkpoint to wait for.
     */
    checkpoint: T,

    /**
     * Options and state to start the run with.
     */
    inlineOpts?: InngestTestEngine.ExecuteOptions<T>,
  ): Promise<InngestTestEngine.ExecutionOutput<T>> {
    const { run } = await this.individualExecution(inlineOpts);

    return run.waitFor(checkpoint, inlineOpts?.subset);
  }

  /**
   * Execute the function with the given inline options.
   */
  protected async individualExecution(
    inlineOpts?: InngestTestEngine.InlineOptions,
  ): Promise<InngestTestEngine.ExecutionOutput> {
    const options = {
      ...this.options,
      ...inlineOpts,
    };

    const events = (options.events || [createMockEvent()]).map((event) => {
      // Make sure every event has some basic mocked data
      return {
        ...createMockEvent(),
        ...event,
      };
    }) as [EventPayload, ...EventPayload[]];

    const steps = (options.steps || []).map((step) => {
      return {
        ...step,
        id: step.idIsHashed
          ? step.id
          : InngestExecutionV1._internals.hashId(step.id),
      };
    });

    const stepState: Record<string, InngestExecution.MemoizedOp> = {};

    steps.forEach((step) => {
      const { promise: data, resolve: resolveData } = createDeferredPromise();
      const { promise: error, resolve: resolveError } = createDeferredPromise();

      const mockHandler = {
        ...(step as InngestExecution.MemoizedOp),
        data,
        error,
        __lazyMockHandler: async (state) => {
          resolveError(state.error);
          resolveData(state.data);
        },
      } satisfies InternalMemoizedOp;

      stepState[step.id] = mockHandler;
    });

    // Helper to execute the mock handler lazily
    const executeMockHandler = async (
      mockStep: InternalMemoizedOp
    ): Promise<void> => {
      if (mockStep.__mockResult) {
        return mockStep.__mockResult;
      }

      mockStep.__mockResult = new Promise<void>(async (resolve) => {
        try {
          const data = await (
            mockStep as InngestTestEngine.MockedStep
          ).handler();
          mockStep.__lazyMockHandler?.({ data });
        } catch (err) {
          mockStep.__lazyMockHandler?.({ error: errors.serializeError(err) });
        } finally {
          resolve();
        }
      });

      return mockStep.__mockResult;
    };

    // Helper to wrap a promise so it executes the handler on .then
    // We want to ensure we only call the handler when actually trying to await the promise.
    const wrapLazyPromise = <T>(
      promise: Promise<T>,
      mockStep: InternalMemoizedOp
    ): Promise<T> => {
      return new Proxy(promise, {
        get(target, prop) {
          if (prop === "then") {
            return function (
              this: Promise<T>,
              ...args: Parameters<Promise<T>["then"]>
            ) {
              return executeMockHandler(mockStep).then(() =>
                target.then(...args)
              );
            };
          }

          const value = target[prop as keyof Promise<T>];
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Promise<T>;
    };

    // Track mock step accesses; if we attempt to get a particular step then
    // assume we've found it and attempt to lazily run the handler to give us
    // time to return smarter mocked data based on input and other outputs.
    //
    // This gives us the ability for mocks be be async and return dynamic data.
    const mockStepState = new Proxy(stepState, {
      get(target, prop) {
        if (!(prop in target)) {
          return undefined;
        }

        const mockStep = target[
          prop as keyof typeof target
        ] as InternalMemoizedOp;

        // Wrap the mockStep in a proxy that intercepts promise access
        return new Proxy(mockStep, {
          get(stepTarget, stepProp) {
            const value = stepTarget[stepProp as keyof typeof stepTarget];

            // If accessing data or error promises, wrap them for lazy execution
            if (
              (stepProp === "data" || stepProp === "error") &&
              value instanceof Promise
            ) {
              return wrapLazyPromise(value, stepTarget);
            }

            return value;
          },
        });
      },
    });

    const runId = ulid();

    const execution = (options.function as InngestFunction.Any)[
      "createExecution"
    ]({
      version: InngestExecution.ExecutionVersion.V1,
      partialOptions: {
        runId,
        client: (options.function as InngestFunction.Any)["client"],
        data: {
          runId,
          attempt: 0, // TODO retries?
          event: events[0],
          events,
        },
        reqArgs: options.reqArgs || [],
        headers: {},
        stepCompletionOrder: steps.map((step) => step.id),
        stepState: mockStepState,
        disableImmediateExecution: Boolean(options.disableImmediateExecution),
        isFailureHandler: false, // TODO need to allow hitting an `onFailure` handler - not dynamically, but choosing it
        timer: new ServerTiming.ServerTiming(),
        requestedRunStep: options.targetStepId,
        transformCtx: this.options.transformCtx ?? mockCtx,
      },
    });

    const { ctx, ops, ...result } = await execution.start();

    const mockState: InngestTestEngine.MockState = await Object.keys(
      ops,
    ).reduce(
      async (acc, stepId) => {
        const op = ops[stepId];

        if (
          op?.seen === false ||
          !op?.rawArgs ||
          !op?.fulfilled ||
          !op?.promise
        ) {
          return acc;
        }

        return {
          ...(await acc),
          [stepId]: op.promise,
        };
      },
      Promise.resolve({}) as Promise<InngestTestEngine.MockState>,
    );

    InngestTestRun["updateState"](options, result);

    const run = new InngestTestRun({
      testEngine: this.clone(options),
    });

    return {
      result,
      ctx: ctx as unknown as InngestTestEngine.MockContext,
      state: mockState,
      run,
    };
  }
}
