import { jest } from "@jest/globals";
import {
  ExecutionVersion,
  type MemoizedOp,
} from "inngest/components/execution/InngestExecution";
import { _internals } from "inngest/components/execution/v1";
import type { InngestFunction } from "inngest/components/InngestFunction";
import { internalEvents } from "inngest/helpers/consts";
import { ServerTiming } from "inngest/helpers/ServerTiming";
import type { Context, EventPayload, OpStack } from "inngest/types";
import { ulid } from "ulid";
import { InngestTestRun } from "./InngestTestRun.js";
import { mockCtx } from "./util.js";

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
    function: InngestFunction.Any;

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
    steps?: OpStack;

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
     * import { mockCtx } from "inngest/test";
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

  /**
   * A mocked context object that allows you to assert step usage, input, and
   * output.
   */
  export interface MockContext extends Omit<Context.Any, "step"> {
    step: {
      [K in keyof Context.Any["step"]]: jest.Mock<Context.Any["step"][K]>;
    };
  }

  /**
   * Options that can be passed to an existing execution or run to continue
   * execution.
   */
  export type InlineOptions = Omit<Options, "function">;

  /**
   * A mocked state object that allows you to assert step usage, input, and
   * output.
   */
  export type MockState = Record<
    string,
    jest.Mock<(...args: unknown[]) => Promise<unknown>>
  >;

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
   *
   * @TODO Should be called `.clone()`?
   */
  public withDefaults(
    inlineOpts: InngestTestEngine.InlineOptions
  ): InngestTestEngine {
    return new InngestTestEngine({ ...this.options, ...inlineOpts });
  }

  /**
   * Execute the function with the given inline options.
   */
  public async execute(
    inlineOpts: InngestTestEngine.InlineOptions
  ): Promise<InngestTestEngine.ExecutionOutput> {
    const options = {
      ...this.options,
      ...inlineOpts,
    };

    const events = options.events || [
      { name: `${internalEvents.FunctionInvoked}`, data: {} },
    ];

    const steps = (options.steps || []).map((step) => ({
      ...step,
      id: _internals.hashId(step.id),
    }));

    const stepState: Record<string, MemoizedOp> = {};

    steps.forEach((step) => {
      stepState[step.id] = step as MemoizedOp;
    });

    const runId = ulid();

    const execution = options.function["createExecution"]({
      version: ExecutionVersion.V1,
      partialOptions: {
        runId,
        data: {
          runId,
          attempt: 0, // TODO retries?
          event: events[0],
          events,
        },
        reqArgs: [], // TODO allow passing?
        headers: {},
        stepCompletionOrder: steps.map((step) => step.id),
        stepState,
        disableImmediateExecution: Boolean(options.disableImmediateExecution),
        isFailureHandler: false, // TODO need to allow hitting an `onFailure` handler - not dynamically, but choosing it
        timer: new ServerTiming(),
        requestedRunStep: options.targetStepId,
        transformCtx: this.options.transformCtx ?? mockCtx,
      },
    });

    const { ctx, ops, ...result } = await execution.start();

    const mockState: InngestTestEngine.MockState = Object.keys(ops).reduce(
      (acc, stepId) => {
        const op = ops[stepId];

        if (op?.seen === false || !op?.rawArgs) {
          return acc;
        }

        const mock = jest.fn(async (...args: unknown[]) => {
          if ("error" in op) {
            throw op.error;
          }

          return op.data;
        });

        // execute it to show it was hit
        mock(op.rawArgs);

        return {
          ...acc,
          [stepId]: mock,
        };
      },
      {} as InngestTestEngine.MockState
    );

    // now proxy the mock state to always retrn some empty mock that hasn't been
    // called for missing keys
    const mockStateProxy = new Proxy(mockState, {
      get(target, prop) {
        if (prop in target) {
          return target[prop as keyof typeof target];
        }

        return jest.fn();
      },
    });

    const run = new InngestTestRun({
      testEngine: this.withDefaults(inlineOpts),
    });

    return {
      result,
      ctx: ctx as InngestTestEngine.MockContext,
      state: mockStateProxy,
      run,
    };
  }
}
