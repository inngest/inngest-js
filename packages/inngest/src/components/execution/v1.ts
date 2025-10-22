import { trace } from "@opentelemetry/api";
import hashjs from "hash.js";
import { z } from "zod/v3";
import { headerKeys, internalEvents } from "../../helpers/consts.ts";
import {
  deserializeError,
  ErrCode,
  minifyPrettyError,
  prettyError,
  serializeError,
} from "../../helpers/errors.js";
import { undefinedToNull } from "../../helpers/functions.js";
import {
  createDeferredPromise,
  createDeferredPromiseWithStack,
  createTimeoutPromise,
  resolveAfterPending,
  runAsPromise,
} from "../../helpers/promises.ts";
import type { MaybePromise, Simplify } from "../../helpers/types.ts";
import {
  type BaseContext,
  type Context,
  type EventPayload,
  type FailureEventArgs,
  type Handler,
  jsonErrorSchema,
  type OutgoingOp,
  StepOpCode,
} from "../../types.ts";
import { version } from "../../version.ts";
import type { Inngest } from "../Inngest.ts";
import { getHookStack, type RunHookStack } from "../InngestMiddleware.ts";
import {
  createStepTools,
  type FoundStep,
  getStepOptions,
  invokePayloadSchema,
  STEP_INDEXING_SUFFIX,
  type StepHandler,
} from "../InngestStepTools.ts";
import { NonRetriableError } from "../NonRetriableError.ts";
import { RetryAfterError } from "../RetryAfterError.ts";
import { StepError } from "../StepError.ts";
import { getAsyncCtx, getAsyncLocalStorage } from "./als.ts";
import {
  type ExecutionResult,
  type IInngestExecution,
  InngestExecution,
  type InngestExecutionFactory,
  type InngestExecutionOptions,
  type MemoizedOp,
} from "./InngestExecution.ts";
import { clientProcessorMap } from "./otel/access.ts";

const { sha1 } = hashjs;

export const createV1InngestExecution: InngestExecutionFactory = (options) => {
  return new V1InngestExecution(options);
};

class V1InngestExecution extends InngestExecution implements IInngestExecution {
  private state: V1ExecutionState;
  private fnArg: Context.Any;
  private checkpointHandlers: CheckpointHandlers;
  private timeoutDuration = 1000 * 10;
  private execution: Promise<ExecutionResult> | undefined;
  private userFnToRun: Handler.Any;

  /**
   * If we're supposed to run a particular step via `requestedRunStep`, this
   * will be a `Promise` that resolves after no steps have been found for
   * `timeoutDuration` milliseconds.
   *
   * If we're not supposed to run a particular step, this will be `undefined`.
   */
  private timeout?: ReturnType<typeof createTimeoutPromise>;

  constructor(options: InngestExecutionOptions) {
    super(options);

    this.userFnToRun = this.getUserFnToRun();
    this.state = this.createExecutionState();
    this.fnArg = this.createFnArg();
    this.checkpointHandlers = this.createCheckpointHandlers();
    this.initializeTimer(this.state);

    this.debug(
      "created new V1 execution for run;",
      this.options.requestedRunStep
        ? `wanting to run step "${this.options.requestedRunStep}"`
        : "discovering steps",
    );

    this.debug("existing state keys:", Object.keys(this.state.stepState));
  }

  /**
   * Idempotently start the execution of the user's function.
   */
  public start() {
    if (!this.execution) {
      this.debug("starting V1 execution");

      const tracer = trace.getTracer("inngest", version);

      this.execution = getAsyncLocalStorage().then((als) => {
        return als.run(
          { app: this.options.client, ctx: this.fnArg },
          async () => {
            return tracer.startActiveSpan("inngest.execution", (span) => {
              clientProcessorMap.get(this.options.client)?.declareStartingSpan({
                span,
                runId: this.options.runId,
                traceparent: this.options.headers[headerKeys.TraceParent],
                tracestate: this.options.headers[headerKeys.TraceState],
              });

              return this._start()
                .then((result) => {
                  this.debug("result:", result);
                  return result;
                })
                .finally(() => {
                  span.end();
                });
            });
          },
        );
      });
    }

    return this.execution;
  }

  /**
   * Starts execution of the user's function and the core loop.
   */
  private async _start(): Promise<ExecutionResult> {
    try {
      const allCheckpointHandler = this.getCheckpointHandler("");
      this.state.hooks = await this.initializeMiddleware();
      await this.startExecution();

      for await (const checkpoint of this.state.loop) {
        await allCheckpointHandler(checkpoint);

        const handler = this.getCheckpointHandler(checkpoint.type);
        const result = await handler(checkpoint);

        if (result) {
          return result;
        }
      }
    } catch (error) {
      return await this.transformOutput({ error });
    } finally {
      void this.state.loop.return();
      await this.state.hooks?.beforeResponse?.();
    }

    /**
     * If we're here, the generator somehow finished without returning a value.
     * This should never happen.
     */
    throw new Error("Core loop finished without returning a value");
  }

  /**
   * Creates a handler for every checkpoint type, defining what to do when we
   * reach that checkpoint in the core loop.
   */
  private createCheckpointHandlers(): CheckpointHandlers {
    return {
      /**
       * Run for all checkpoints. Best used for logging or common actions.
       * Use other handlers to return values and interrupt the core loop.
       */
      "": (checkpoint) => {
        this.debug("checkpoint:", checkpoint);
      },

      /**
       * The user's function has completed and returned a value.
       */
      "function-resolved": async (checkpoint) => {
        return await this.transformOutput({ data: checkpoint.data });
      },

      /**
       * The user's function has thrown an error.
       */
      "function-rejected": async (checkpoint) => {
        return await this.transformOutput({ error: checkpoint.error });
      },

      /**
       * We've found one or more steps. Here we may want to run a step or report
       * them back to Inngest.
       */
      "steps-found": async ({ steps }) => {
        const stepResult = await this.tryExecuteStep(steps);
        if (stepResult) {
          const transformResult = await this.transformOutput(stepResult);

          /**
           * Transforming output will always return either function rejection or
           * resolution. In most cases, this can be immediately returned, but in
           * this particular case we want to handle it differently.
           */
          if (transformResult.type === "function-resolved") {
            return {
              type: "step-ran",
              ctx: transformResult.ctx,
              ops: transformResult.ops,
              step: _internals.hashOp({
                ...stepResult,
                data: transformResult.data,
              }),
            };
          } else if (transformResult.type === "function-rejected") {
            const stepForResponse = _internals.hashOp({
              ...stepResult,
              error: transformResult.error,
            });

            if (stepResult.op === StepOpCode.StepFailed) {
              const ser = serializeError(transformResult.error);
              stepForResponse.data = {
                __serialized: true,
                name: ser.name,
                message: ser.message,
                stack: "",
              };
            }

            return {
              type: "step-ran",
              ctx: transformResult.ctx,
              ops: transformResult.ops,
              retriable: transformResult.retriable,
              step: stepForResponse,
            };
          }

          return transformResult;
        }

        const newSteps = await this.filterNewSteps(
          Array.from(this.state.steps.values()),
        );
        if (newSteps) {
          return {
            type: "steps-found",
            ctx: this.fnArg,
            ops: this.ops,
            steps: newSteps,
          };
        }

        return;
      },

      /**
       * While trying to find a step that Inngest has told us to run, we've
       * timed out or have otherwise decided that it doesn't exist.
       */
      "step-not-found": ({ step }) => {
        return { type: "step-not-found", ctx: this.fnArg, ops: this.ops, step };
      },
    };
  }

  private getCheckpointHandler(type: keyof CheckpointHandlers) {
    return this.checkpointHandlers[type] as (
      checkpoint: Checkpoint,
    ) => MaybePromise<ExecutionResult | undefined>;
  }

  private async tryExecuteStep(
    steps: FoundStep[],
  ): Promise<OutgoingOp | undefined> {
    const hashedStepIdToRun =
      this.options.requestedRunStep || this.getEarlyExecRunStep(steps);
    if (!hashedStepIdToRun) {
      return;
    }

    const step = steps.find(
      (step) => step.hashedId === hashedStepIdToRun && step.fn,
    );

    if (step) {
      return await this.executeStep(step);
    }

    /**
     * Ensure we reset the timeout if we have a requested run step but couldn't
     * find it, but also that we don't reset if we found and executed it.
     */
    return void this.timeout?.reset();
  }

  /**
   * Given a list of outgoing ops, decide if we can execute an op early and
   * return the ID of the step to execute if we can.
   */
  private getEarlyExecRunStep(steps: FoundStep[]): string | undefined {
    /**
     * We may have been disabled due to parallelism, in which case we can't
     * immediately execute unless explicitly requested.
     */
    if (this.options.disableImmediateExecution) return;

    const unfulfilledSteps = steps.filter((step) => !step.fulfilled);
    if (unfulfilledSteps.length !== 1) return;

    const op = unfulfilledSteps[0];

    if (
      op &&
      op.op === StepOpCode.StepPlanned
      // TODO We must individually check properties here that we do not want to
      // execute on, such as retry counts. Nothing exists here that falls in to
      // this case, but should be accounted for when we add them.
      // && typeof op.opts === "undefined"
    ) {
      return op.hashedId;
    }

    return;
  }

  private async filterNewSteps(
    foundSteps: FoundStep[],
  ): Promise<[OutgoingOp, ...OutgoingOp[]] | undefined> {
    if (this.options.requestedRunStep) {
      return;
    }

    /**
     * Gather any steps that aren't memoized and report them.
     */
    const newSteps = foundSteps.filter((step) => !step.fulfilled);

    if (!newSteps.length) {
      return;
    }

    /**
     * Warn if we've found new steps but haven't yet seen all previous
     * steps. This may indicate that step presence isn't determinate.
     */
    let knownSteps = 0;
    for (const step of foundSteps) {
      if (step.fulfilled) {
        knownSteps++;
      }
    }
    const foundAllCompletedSteps = this.state.stepsToFulfill === knownSteps;

    if (!foundAllCompletedSteps) {
      // TODO Tag
      console.warn(
        prettyError({
          type: "warn",
          whatHappened: "Function may be indeterminate",
          why: "We found new steps before seeing all previous steps, which may indicate that the function is non-deterministic.",
          consequences:
            "This may cause unexpected behaviour as Inngest executes your function.",
          reassurance:
            "This is expected if a function is updated in the middle of a run, but may indicate a bug if not.",
        }),
      );
    }

    /**
     * We're finishing up; let's trigger the last of the hooks.
     */
    await this.state.hooks?.afterMemoization?.();
    await this.state.hooks?.beforeExecution?.();
    await this.state.hooks?.afterExecution?.();

    const stepList = newSteps.map<OutgoingOp>((step) => ({
      displayName: step.displayName,
      op: step.op,
      id: step.hashedId,
      name: step.name,
      opts: step.opts,
      userland: step.userland,
    })) as [OutgoingOp, ...OutgoingOp[]];

    /**
     * We also run `onSendEvent` middleware hooks against `step.invoke()` steps
     * to ensure that their `data` is transformed correctly.
     */
    return await this.transformNewSteps(stepList);
  }

  /**
   * Using middleware, transform any newly-found steps before returning them to
   * an Inngest Server.
   */
  private async transformNewSteps<T extends [OutgoingOp, ...OutgoingOp[]]>(
    steps: T,
  ): Promise<T> {
    return Promise.all(
      steps.map(async (step) => {
        if (step.op !== StepOpCode.InvokeFunction) {
          return step;
        }

        const onSendEventHooks = await getHookStack(
          this.options.fn["middleware"],
          "onSendEvent",
          undefined,
          {
            transformInput: (prev, output) => {
              return { ...prev, ...output };
            },
            transformOutput: (prev, output) => {
              return {
                result: { ...prev.result, ...output?.result },
              };
            },
          },
        );

        /**
         * For each event being sent, create a new `onSendEvent` hook stack to
         * process it. We do this as middleware hooks are intended to run once
         * during each lifecycle (onFunctionRun or onSendEvent) and here, a hook
         * is run for every single event.
         *
         * This is done because a developer can use this hook to filter out
         * events entirely; if we batch all of the events together, we can't
         * tell which ones were filtered out if we're processing >1 invocation
         * here.
         */
        const transformedPayload = await onSendEventHooks.transformInput?.({
          payloads: [
            {
              ...(step.opts?.payload ?? {}),
              name: internalEvents.FunctionInvoked,
            },
          ],
        });

        const newPayload = invokePayloadSchema.parse(
          transformedPayload?.payloads?.[0] ?? {},
        );

        return {
          ...step,
          opts: {
            ...step.opts,
            payload: {
              ...(step.opts?.payload ?? {}),
              ...newPayload,
            },
          },
        };
      }),
    ) as Promise<T>;
  }

  private async executeStep({
    id,
    name,
    opts,
    fn,
    displayName,
    userland,
  }: FoundStep): Promise<OutgoingOp> {
    this.timeout?.clear();
    await this.state.hooks?.afterMemoization?.();
    await this.state.hooks?.beforeExecution?.();

    const outgoingOp: OutgoingOp = {
      id,
      op: StepOpCode.StepRun,
      name,
      opts,
      displayName,
      userland,
    };
    this.state.executingStep = outgoingOp;

    const store = await getAsyncCtx();

    if (store) {
      store.executingStep = {
        id,
        name: displayName,
      };
    }

    this.debug(`executing step "${id}"`);

    return runAsPromise(fn)
      .finally(async () => {
        if (store) {
          delete store.executingStep;
        }

        await this.state.hooks?.afterExecution?.();
      })
      .then<OutgoingOp>((data) => {
        return {
          ...outgoingOp,
          data,
        };
      })
      .catch<OutgoingOp>((error) => {
        let errorIsRetriable = true;

        if (error instanceof NonRetriableError) {
          errorIsRetriable = false;
        } else if (
          this.fnArg.maxAttempts &&
          this.fnArg?.maxAttempts - 1 === this.fnArg.attempt
        ) {
          errorIsRetriable = false;
        }

        if (errorIsRetriable) {
          return {
            ...outgoingOp,
            op: StepOpCode.StepError,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            error,
          };
        } else {
          return {
            ...outgoingOp,
            op: StepOpCode.StepFailed,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            error,
          };
        }
      });
  }

  /**
   * Starts execution of the user's function, including triggering checkpoints
   * and middleware hooks where appropriate.
   */
  private async startExecution(): Promise<void> {
    /**
     * Mutate input as neccessary based on middleware.
     */
    await this.transformInput();

    /**
     * Start the timer to time out the run if needed.
     */
    void this.timeout?.start();

    await this.state.hooks?.beforeMemoization?.();

    /**
     * If we had no state to begin with, immediately end the memoization phase.
     */
    if (this.state.allStateUsed()) {
      await this.state.hooks?.afterMemoization?.();
      await this.state.hooks?.beforeExecution?.();
    }

    /**
     * Trigger the user's function.
     */
    runAsPromise(() => this.userFnToRun(this.fnArg))
      .finally(async () => {
        await this.state.hooks?.afterMemoization?.();
        await this.state.hooks?.beforeExecution?.();
        await this.state.hooks?.afterExecution?.();
      })
      .then((data) => {
        this.state.setCheckpoint({ type: "function-resolved", data });
      })
      .catch((error) => {
        this.state.setCheckpoint({ type: "function-rejected", error });
      });
  }

  /**
   * Using middleware, transform input before running.
   */
  private async transformInput() {
    const inputMutations = await this.state.hooks?.transformInput?.({
      ctx: { ...this.fnArg },
      steps: Object.values(this.state.stepState),
      fn: this.options.fn,
      reqArgs: this.options.reqArgs,
    });

    if (inputMutations?.ctx) {
      this.fnArg = inputMutations.ctx;
    }

    if (inputMutations?.steps) {
      this.state.stepState = Object.fromEntries(
        inputMutations.steps.map((step) => [step.id, step]),
      );
    }
  }

  /**
   * Using middleware, transform output before returning.
   */
  private async transformOutput(
    dataOrError: Parameters<
      NonNullable<RunHookStack["transformOutput"]>
    >[0]["result"],
  ): Promise<ExecutionResult> {
    const output = { ...dataOrError } as Partial<OutgoingOp>;

    const isStepExecution = Boolean(this.state.executingStep);

    const transformedOutput = await this.state.hooks?.transformOutput?.({
      result: { ...output },
      step: this.state.executingStep,
    });

    const { data, error } = { ...output, ...transformedOutput?.result };

    if (!isStepExecution) {
      await this.state.hooks?.finished?.({
        result: { ...(typeof error !== "undefined" ? { error } : { data }) },
      });
    }

    if (typeof error !== "undefined") {
      /**
       * Ensure we give middleware the chance to decide on retriable behaviour
       * by looking at the error returned from output transformation.
       */
      let retriable: boolean | string = !(
        error instanceof NonRetriableError ||
        (error instanceof StepError &&
          error === this.state.recentlyRejectedStepError)
      );
      if (retriable && error instanceof RetryAfterError) {
        retriable = error.retryAfter;
      }

      const serializedError = minifyPrettyError(serializeError(error));

      return {
        type: "function-rejected",
        ctx: this.fnArg,
        ops: this.ops,
        error: serializedError,
        retriable,
      };
    }

    return {
      type: "function-resolved",
      ctx: this.fnArg,
      ops: this.ops,
      data: undefinedToNull(data),
    };
  }

  private createExecutionState(): V1ExecutionState {
    const d = createDeferredPromiseWithStack<Checkpoint>();
    let checkpointResolve = d.deferred.resolve;
    const checkpointResults = d.results;

    const loop: V1ExecutionState["loop"] = (async function* (
      cleanUp?: () => void,
    ) {
      try {
        while (true) {
          const res = (await checkpointResults.next()).value;
          if (res) {
            yield res;
          }
        }
      } finally {
        cleanUp?.();
      }
    })(() => {
      this.timeout?.clear();
      void checkpointResults.return();
    });

    const stepsToFulfill = Object.keys(this.options.stepState).length;

    const state: V1ExecutionState = {
      stepState: this.options.stepState,
      stepsToFulfill,
      steps: new Map(),
      loop,
      hasSteps: Boolean(stepsToFulfill),
      stepCompletionOrder: [...this.options.stepCompletionOrder],
      remainingStepsToBeSeen: new Set(this.options.stepCompletionOrder),
      setCheckpoint: (checkpoint: Checkpoint) => {
        ({ resolve: checkpointResolve } = checkpointResolve(checkpoint));
      },
      allStateUsed: () => {
        return this.state.remainingStepsToBeSeen.size === 0;
      },
    };

    return state;
  }

  get ops(): Record<string, MemoizedOp> {
    return Object.fromEntries(this.state.steps);
  }

  private createFnArg(): Context.Any {
    const step = this.createStepTools();

    let fnArg = {
      ...(this.options.data as { event: EventPayload }),
      step,
    } as Context.Any;

    /**
     * Handle use of the `onFailure` option by deserializing the error.
     */
    if (this.options.isFailureHandler) {
      const eventData = z
        .object({ error: jsonErrorSchema })
        .parse(fnArg.event?.data);

      (fnArg as Partial<Pick<FailureEventArgs, "error">>) = {
        ...fnArg,
        error: deserializeError(eventData.error),
      };
    }

    return this.options.transformCtx?.(fnArg) ?? fnArg;
  }

  private createStepTools(): ReturnType<typeof createStepTools> {
    /**
     * A list of steps that have been found and are being rolled up before being
     * reported to the core loop.
     */
    const foundStepsToReport: Map<string, FoundStep> = new Map();

    /**
     * A map of the subset of found steps to report that have not yet been
     * handled. Used for fast access to steps that need to be handled in order.
     */
    const unhandledFoundStepsToReport: Map<string, FoundStep> = new Map();

    /**
     * A map of the latest sequential step indexes found for each step ID. Used
     * to ensure that we don't index steps in parallel.
     *
     * Note that these must be sequential; if we've seen or assigned `a:1`,
     * `a:2` and `a:4`, the latest sequential step index is `2`.
     *
     */
    const expectedNextStepIndexes: Map<string, number> = new Map();

    /**
     * An ordered list of step IDs that have yet to be handled in this
     * execution. Used to ensure that we handle steps in the order they were
     * found and based on the `stepCompletionOrder` in this execution's state.
     */
    const remainingStepCompletionOrder: string[] =
      this.state.stepCompletionOrder.slice();

    /**
     * A promise that's used to ensure that step reporting cannot be run more than
     * once in a given asynchronous time span.
     */
    let foundStepsReportPromise: Promise<void> | undefined;

    /**
     * A promise that's used to represent middleware hooks running before
     * execution.
     */
    let beforeExecHooksPromise: Promise<void> | undefined;

    /**
     * A flag used to ensure that we only warn about parallel indexing once per
     * execution to avoid spamming the console.
     */
    let warnOfParallelIndexing = false;

    /**
     * Counts the number of times we've extended this tick.
     */
    let tickExtensionCount = 0;

    /**
     * Given a colliding step ID, maybe warn the user about parallel indexing.
     */
    const maybeWarnOfParallelIndexing = (collisionId: string) => {
      if (warnOfParallelIndexing) {
        return;
      }

      const stepExists = this.state.steps.has(collisionId);
      if (stepExists) {
        const stepFoundThisTick = foundStepsToReport.has(collisionId);
        if (!stepFoundThisTick) {
          warnOfParallelIndexing = true;

          console.warn(
            prettyError({
              type: "warn",
              whatHappened:
                "We detected that you have multiple steps with the same ID.",
              code: ErrCode.AUTOMATIC_PARALLEL_INDEXING,
              why: `This can happen if you're using the same ID for multiple steps across different chains of parallel work. We found the issue with step "${collisionId}".`,
              reassurance:
                "Your function is still running, though it may exhibit unexpected behaviour.",
              consequences:
                "Using the same IDs across parallel chains of work can cause unexpected behaviour.",
              toFixNow:
                "We recommend using a unique ID for each step, especially those happening in parallel.",
            }),
          );
        }
      }
    };

    /**
     * A helper used to report steps to the core loop. Used after adding an item
     * to `foundStepsToReport`.
     */
    const reportNextTick = () => {
      // Being explicit instead of using `??=` to appease TypeScript.
      if (foundStepsReportPromise) {
        return;
      }

      let extensionPromise: Promise<void>;
      if (++tickExtensionCount >= 10) {
        tickExtensionCount = 0;
        extensionPromise = new Promise((resolve) => setTimeout(resolve));
      } else {
        extensionPromise = resolveAfterPending();
      }

      foundStepsReportPromise = extensionPromise
        /**
         * Ensure that we wait for this promise to resolve before continuing.
         *
         * The groups in which steps are reported can affect how we detect some
         * more complex determinism issues like parallel indexing. This promise
         * can represent middleware hooks being run early, in the middle of
         * ingesting steps to report.
         *
         * Because of this, it's important we wait for this middleware to resolve
         * before continuing to report steps to ensure that all steps have a
         * chance to be reported throughout this asynchronous action.
         */
        .then(() => beforeExecHooksPromise)
        .then(() => {
          foundStepsReportPromise = undefined;

          for (let i = 0; i < remainingStepCompletionOrder.length; i++) {
            const nextStepId = remainingStepCompletionOrder[i];
            if (!nextStepId) {
              // Strange - skip this empty index
              continue;
            }

            const handled = unhandledFoundStepsToReport
              .get(nextStepId)
              ?.handle();
            if (handled) {
              remainingStepCompletionOrder.splice(i, 1);
              unhandledFoundStepsToReport.delete(nextStepId);
              return void reportNextTick();
            }
          }

          // If we've handled no steps in this "tick," roll up everything we've
          // found and report it.
          const steps = [...foundStepsToReport.values()] as [
            FoundStep,
            ...FoundStep[],
          ];
          foundStepsToReport.clear();
          unhandledFoundStepsToReport.clear();

          return void this.state.setCheckpoint({
            type: "steps-found",
            steps: steps,
          });
        });
    };

    /**
     * A helper used to push a step to the list of steps to report.
     */
    const pushStepToReport = (step: FoundStep) => {
      foundStepsToReport.set(step.id, step);
      unhandledFoundStepsToReport.set(step.hashedId, step);
      reportNextTick();
    };

    const stepHandler: StepHandler = async ({
      args,
      matchOp,
      opts,
    }): Promise<unknown> => {
      await beforeExecHooksPromise;

      const stepOptions = getStepOptions(args[0]);
      const opId = matchOp(stepOptions, ...args.slice(1));

      if (this.state.executingStep) {
        /**
         * If a step is found after asynchronous actions during another step's
         * execution, everything is fine. The problem here is if we've found
         * that a step nested inside another a step, which is something we don't
         * support at the time of writing.
         *
         * In this case, we could use something like Async Hooks to understand
         * how the step is being triggered, though this isn't available in all
         * environments.
         *
         * Therefore, we'll only show a warning here to indicate that this is
         * potentially an issue.
         */
        console.warn(
          prettyError({
            whatHappened: `We detected that you have nested \`step.*\` tooling in \`${
              opId.displayName ?? opId.id
            }\``,
            consequences: "Nesting `step.*` tooling is not supported.",
            type: "warn",
            reassurance:
              "It's possible to see this warning if steps are separated by regular asynchronous calls, which is fine.",
            stack: true,
            toFixNow:
              "Make sure you're not using `step.*` tooling inside of other `step.*` tooling. If you need to compose steps together, you can create a new async function and call it from within your step function, or use promise chaining.",
            code: ErrCode.NESTING_STEPS,
          }),
        );
      }

      if (this.state.steps.has(opId.id)) {
        const originalId = opId.id;
        maybeWarnOfParallelIndexing(originalId);

        const expectedNextIndex = expectedNextStepIndexes.get(originalId) ?? 1;
        for (let i = expectedNextIndex; ; i++) {
          const newId = originalId + STEP_INDEXING_SUFFIX + i;

          if (!this.state.steps.has(newId)) {
            expectedNextStepIndexes.set(originalId, i + 1);
            opId.id = newId;
            opId.userland.index = i;
            break;
          }
        }
      }

      const { promise, resolve, reject } = createDeferredPromise();
      const hashedId = _internals.hashId(opId.id);
      const stepState = this.state.stepState[hashedId];
      let isFulfilled = false;
      if (stepState) {
        stepState.seen = true;
        this.state.remainingStepsToBeSeen.delete(hashedId);

        if (typeof stepState.input === "undefined") {
          isFulfilled = true;
        }
      }

      let extraOpts: Record<string, unknown> | undefined;
      let fnArgs = [...args];

      if (
        typeof stepState?.input !== "undefined" &&
        Array.isArray(stepState.input)
      ) {
        switch (opId.op) {
          // `step.run()` has its function input affected
          case StepOpCode.StepPlanned: {
            fnArgs = [...args.slice(0, 2), ...stepState.input];

            extraOpts = { input: [...stepState.input] };
            break;
          }

          // `step.ai.infer()` has its body affected
          case StepOpCode.AiGateway: {
            extraOpts = {
              body: {
                ...(typeof opId.opts?.body === "object"
                  ? { ...opId.opts.body }
                  : {}),
                ...stepState.input[0],
              },
            };
            break;
          }
        }
      }

      const step: FoundStep = {
        ...opId,
        opts: { ...opId.opts, ...extraOpts },
        rawArgs: fnArgs, // TODO What is the right value here? Should this be raw args without affected input?
        hashedId,
        input: stepState?.input,

        fn: opts?.fn ? () => opts.fn?.(...fnArgs) : undefined,
        promise,
        fulfilled: isFulfilled,
        hasStepState: Boolean(stepState),
        displayName: opId.displayName ?? opId.id,
        handled: false,
        handle: () => {
          if (step.handled) {
            return false;
          }

          step.handled = true;

          if (isFulfilled && stepState) {
            stepState.fulfilled = true;

            // For some execution scenarios such as testing, `data`, `error`,
            // and `input` may be `Promises`. This could also be the case for
            // future middleware applications. For this reason, we'll make sure
            // the values are fully resolved before continuing.
            void Promise.all([
              stepState.data,
              stepState.error,
              stepState.input,
            ]).then(() => {
              if (typeof stepState.data !== "undefined") {
                resolve(stepState.data);
              } else {
                this.state.recentlyRejectedStepError = new StepError(
                  opId.id,
                  stepState.error,
                );
                reject(this.state.recentlyRejectedStepError);
              }
            });
          }

          return true;
        },
      };

      this.state.steps.set(opId.id, step);
      this.state.hasSteps = true;
      pushStepToReport(step);

      /**
       * If this is the last piece of state we had, we've now finished
       * memoizing.
       */
      if (!beforeExecHooksPromise && this.state.allStateUsed()) {
        // biome-ignore lint/suspicious/noAssignInExpressions: <explanation>
        await (beforeExecHooksPromise = (async () => {
          await this.state.hooks?.afterMemoization?.();
          await this.state.hooks?.beforeExecution?.();
        })());
      }

      return promise;
    };

    return createStepTools(this.options.client, this, stepHandler);
  }

  private getUserFnToRun(): Handler.Any {
    if (!this.options.isFailureHandler) {
      return this.options.fn["fn"];
    }

    if (!this.options.fn["onFailureFn"]) {
      /**
       * Somehow, we've ended up detecting that this is a failure handler but
       * doesn't have an `onFailure` function. This should never happen.
       */
      throw new Error("Cannot find function `onFailure` handler");
    }

    return this.options.fn["onFailureFn"];
  }

  private initializeTimer(state: V1ExecutionState): void {
    if (!this.options.requestedRunStep) {
      return;
    }

    this.timeout = createTimeoutPromise(this.timeoutDuration);

    void this.timeout.then(async () => {
      await this.state.hooks?.afterMemoization?.();
      await this.state.hooks?.beforeExecution?.();
      await this.state.hooks?.afterExecution?.();

      state.setCheckpoint({
        type: "step-not-found",
        step: {
          id: this.options.requestedRunStep as string,
          op: StepOpCode.StepNotFound,
        },
      });
    });
  }

  private async initializeMiddleware(): Promise<RunHookStack> {
    const ctx = this.options.data as Pick<
      Readonly<BaseContext<Inngest.Any>>,
      "event" | "events" | "runId"
    >;

    const hooks = await getHookStack(
      this.options.fn["middleware"],
      "onFunctionRun",
      {
        ctx,
        fn: this.options.fn,
        steps: Object.values(this.options.stepState),
        reqArgs: this.options.reqArgs,
      },
      {
        transformInput: (prev, output) => {
          return {
            ctx: { ...prev.ctx, ...output?.ctx },
            fn: this.options.fn,
            steps: prev.steps.map((step, i) => ({
              ...step,
              ...output?.steps?.[i],
            })),
            reqArgs: prev.reqArgs,
          };
        },
        transformOutput: (prev, output) => {
          return {
            result: { ...prev.result, ...output?.result },
            step: prev.step,
          };
        },
      },
    );

    return hooks;
  }
}

/**
 * Types of checkpoints that can be reached during execution.
 */
export interface Checkpoints {
  "steps-found": { steps: [FoundStep, ...FoundStep[]] };
  "function-rejected": { error: unknown };
  "function-resolved": { data: unknown };
  "step-not-found": { step: OutgoingOp };
}

type Checkpoint = {
  [K in keyof Checkpoints]: Simplify<{ type: K } & Checkpoints[K]>;
}[keyof Checkpoints];

type CheckpointHandlers = {
  [C in Checkpoint as C["type"]]: (
    checkpoint: C,
  ) => MaybePromise<ExecutionResult | undefined>;
} & {
  "": (checkpoint: Checkpoint) => MaybePromise<void>;
};

export interface V1ExecutionState {
  /**
   * A value that indicates that we're executing this step. Can be used to
   * ensure steps are not accidentally nested until we support this across all
   * platforms.
   */
  executingStep?: Readonly<Omit<OutgoingOp, "id">>;

  /**
   * A map of step IDs to their data, used to fill previously-completed steps
   * with state from the executor.
   */
  stepState: Record<string, MemoizedOp>;

  /**
   * The number of steps we expect to fulfil based on the state passed from the
   * Executor.
   */
  stepsToFulfill: number;

  /**
   * A map of step IDs to their functions to run. The executor can request a
   * specific step to run, so we need to store the function to run here.
   */
  steps: Map<string, FoundStep>;

  /**
   * A flag which represents whether or not steps are understood to be used in
   * this function. This is used to determine whether or not we should run
   * some steps (such as `step.sendEvent`) inline as they are found.
   */
  hasSteps: boolean;

  /**
   * The core loop - a generator used to take an action upon finding the next
   * checkpoint. Manages the flow of execution and cleaning up after itself.
   */
  loop: AsyncGenerator<Checkpoint, void, void>;

  /**
   * A function that resolves the `Promise` returned by `waitForNextDecision`.
   */
  setCheckpoint: (data: Checkpoint) => void;

  /**
   * Initialized middleware hooks for this execution.
   *
   * Middleware hooks are cached to ensure they can only be run once, which
   * means that these hooks can be called in many different places to ensure we
   * handle all possible execution paths.
   */
  hooks?: RunHookStack;

  /**
   * Returns whether or not all state passed from the executor has been used to
   * fulfill found steps.
   */
  allStateUsed: () => boolean;

  /**
   * An ordered list of step IDs that represents the order in which their
   * execution was completed.
   */
  stepCompletionOrder: string[];

  /**
   * An set of step IDs that have yet to be seen in this execution. Used to
   * decide when to trigger middleware based on the current state.
   */
  remainingStepsToBeSeen: Set<string>;

  /**
   * If defined, this is the error that purposefully thrown when memoizing step
   * state in order to support per-step errors.
   *
   * We use this so that if the function itself rejects with the same error, we
   * know that it was entirely uncaught (or at the very least rethrown), so we
   * should send a `NonRetriableError` to stop needless execution of a function
   * that will continue to fail.
   *
   * TODO This is imperfect, as this state is currently kept around for longer
   * than it needs to be. It should disappear as soon as we've seen that the
   * error did not immediately throw. It may need to be refactored to work a
   * little more smoothly with the core loop.
   */
  recentlyRejectedStepError?: StepError;
}

const hashId = (id: string): string => {
  return sha1().update(id).digest("hex");
};

const hashOp = (op: OutgoingOp): OutgoingOp => {
  return {
    ...op,
    id: hashId(op.id),
  };
};

/**
 * Exported for testing.
 */
export const _internals = { hashOp, hashId };
