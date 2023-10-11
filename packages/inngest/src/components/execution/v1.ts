import { sha1 } from "hash.js";
import { type Simplify } from "type-fest";
import { z } from "zod";
import { logPrefix } from "../../helpers/consts";
import {
  ErrCode,
  deserializeError,
  prettyError,
  serializeError,
} from "../../helpers/errors";
import { undefinedToNull } from "../../helpers/functions";
import {
  createDeferredPromise,
  createTimeoutPromise,
  resolveAfterPending,
  runAsPromise,
} from "../../helpers/promises";
import { type MaybePromise } from "../../helpers/types";
import {
  StepOpCode,
  failureEventErrorSchema,
  type AnyContext,
  type AnyHandler,
  type BaseContext,
  type ClientOptions,
  type EventPayload,
  type FailureEventArgs,
  type OutgoingOp,
} from "../../types";
import { getHookStack, type RunHookStack } from "../InngestMiddleware";
import {
  STEP_INDEXING_SUFFIX,
  createStepTools,
  getStepOptions,
  type FoundStep,
  type StepHandler,
} from "../InngestStepTools";
import { NonRetriableError } from "../NonRetriableError";
import { RetryAfterError } from "../RetryAfterError";
import {
  InngestExecution,
  type ExecutionResult,
  type IInngestExecution,
  type InngestExecutionFactory,
  type InngestExecutionOptions,
  type MemoizedOp,
} from "./InngestExecution";

export const createV1InngestExecution: InngestExecutionFactory = (options) => {
  return new V1InngestExecution(options);
};

class V1InngestExecution extends InngestExecution implements IInngestExecution {
  #state: V1ExecutionState;
  #fnArg: AnyContext;
  #checkpointHandlers: CheckpointHandlers;
  #timeoutDuration = 1000 * 10;
  #execution: Promise<ExecutionResult> | undefined;
  #userFnToRun: AnyHandler;

  /**
   * If we're supposed to run a particular step via `requestedRunStep`, this
   * will be a `Promise` that resolves after no steps have been found for
   * `timeoutDuration` milliseconds.
   *
   * If we're not supposed to run a particular step, this will be `undefined`.
   */
  #timeout?: ReturnType<typeof createTimeoutPromise>;

  constructor(options: InngestExecutionOptions) {
    super(options);

    this.#userFnToRun = this.#getUserFnToRun();
    this.#state = this.#createExecutionState();
    this.#fnArg = this.#createFnArg();
    this.#checkpointHandlers = this.#createCheckpointHandlers();
    this.#initializeTimer(this.#state);

    this.debug(
      "created new V1 execution for run;",
      this.options.requestedRunStep
        ? `wanting to run step "${this.options.requestedRunStep}"`
        : "discovering steps"
    );

    this.debug("existing state keys:", Object.keys(this.#state.stepState));
  }

  /**
   * Idempotently start the execution of the user's function.
   */
  public start() {
    this.debug("starting V1 execution");

    return (this.#execution ??= this.#start().then((result) => {
      this.debug("result:", result);
      return result;
    }));
  }

  /**
   * Starts execution of the user's function and the core loop.
   */
  async #start(): Promise<ExecutionResult> {
    try {
      const allCheckpointHandler = this.#getCheckpointHandler("");
      this.#state.hooks = await this.#initializeMiddleware();
      await this.#startExecution();

      for await (const checkpoint of this.#state.loop) {
        await allCheckpointHandler(checkpoint);

        const handler = this.#getCheckpointHandler(checkpoint.type);
        const result = await handler(checkpoint);

        if (result) {
          return result;
        }
      }
    } catch (error) {
      return await this.#transformOutput({ error });
    } finally {
      void this.#state.loop.return();
      await this.#state.hooks?.beforeResponse?.();
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
  #createCheckpointHandlers(): CheckpointHandlers {
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
        return await this.#transformOutput({ data: checkpoint.data });
      },

      /**
       * The user's function has thrown an error.
       */
      "function-rejected": async (checkpoint) => {
        return await this.#transformOutput({ error: checkpoint.error });
      },

      /**
       * We've found one or more steps. Here we may want to run a step or report
       * them back to Inngest.
       */
      "steps-found": async ({ steps }) => {
        const stepResult = await this.#tryExecuteStep(steps);
        if (stepResult) {
          const transformResult = await this.#transformOutput(stepResult);

          /**
           * Transforming output will always return either function rejection or
           * resolution. In most cases, this can be immediately returned, but in
           * this particular case we want to handle it differently.
           */
          if (transformResult.type === "function-resolved") {
            return {
              type: "step-ran",
              step: _internals.hashOp({
                ...stepResult,
                data: { data: transformResult.data },
              }),
            };
          }

          return transformResult;
        }

        const newSteps = await this.#filterNewSteps(
          Object.values(this.#state.steps)
        );
        if (newSteps) {
          return {
            type: "steps-found",
            steps: newSteps,
          };
        }
      },

      /**
       * While trying to find a step that Inngest has told us to run, we've
       * timed out or have otherwise decided that it doesn't exist.
       */
      "step-not-found": ({ step }) => {
        return { type: "step-not-found", step };
      },
    };
  }

  #getCheckpointHandler(type: keyof CheckpointHandlers) {
    return this.#checkpointHandlers[type] as (
      checkpoint: Checkpoint
    ) => MaybePromise<ExecutionResult | void>;
  }

  async #tryExecuteStep(steps: FoundStep[]): Promise<OutgoingOp | void> {
    const hashedStepIdToRun =
      this.options.requestedRunStep || this.#getEarlyExecRunStep(steps);
    if (!hashedStepIdToRun) {
      return;
    }

    const step = steps.find(
      (step) => step.hashedId === hashedStepIdToRun && step.fn
    );

    if (step) {
      return await this.#executeStep(step);
    }

    /**
     * Ensure we reset the timeout if we have a requested run step but couldn't
     * find it, but also that we don't reset if we found and executed it.
     */
    void this.#timeout?.reset();
  }

  /**
   * Given a list of outgoing ops, decide if we can execute an op early and
   * return the ID of the step to execute if we can.
   */
  #getEarlyExecRunStep(steps: FoundStep[]): string | void {
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
      op.op === StepOpCode.StepPlanned &&
      typeof op.opts === "undefined"
    ) {
      return op.hashedId;
    }
  }

  async #filterNewSteps(
    steps: FoundStep[]
  ): Promise<[OutgoingOp, ...OutgoingOp[]] | void> {
    if (this.options.requestedRunStep) {
      return;
    }

    /**
     * Gather any steps that aren't memoized and report them.
     */
    const newSteps = steps.filter((step) => !step.fulfilled);

    if (!newSteps.length) {
      return;
    }

    /**
     * Warn if we've found new steps but haven't yet seen all previous
     * steps. This may indicate that step presence isn't determinate.
     */
    const stepsToFulfil = Object.keys(this.#state.stepState).length;
    const fulfilledSteps = steps.filter((step) => step.fulfilled).length;
    const foundAllCompletedSteps = stepsToFulfil === fulfilledSteps;

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
        })
      );
    }

    /**
     * We're finishing up; let's trigger the last of the hooks.
     */
    await this.#state.hooks?.afterMemoization?.();
    await this.#state.hooks?.beforeExecution?.();
    await this.#state.hooks?.afterExecution?.();

    return newSteps.map<OutgoingOp>((step) => ({
      displayName: step.displayName,
      op: step.op,
      id: step.hashedId,
      name: step.name,
      opts: step.opts,
    })) as [OutgoingOp, ...OutgoingOp[]];
  }

  async #executeStep({ id, name, opts, fn, displayName }: FoundStep): Promise<OutgoingOp> {
    this.#timeout?.clear();
    await this.#state.hooks?.afterMemoization?.();
    await this.#state.hooks?.beforeExecution?.();

    const outgoingOp: OutgoingOp = { id, op: StepOpCode.RunStep, name, opts, displayName };
    this.#state.executingStep = outgoingOp;
    this.debug(`executing step "${id}"`);

    return (
      runAsPromise(fn)
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        .finally(async () => {
          await this.#state.hooks?.afterExecution?.();
        })
        .then<OutgoingOp>((data) => {
          return {
            ...outgoingOp,
            data,
          };
        })
        .catch<OutgoingOp>((error) => {
          return {
            ...outgoingOp,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            error,
          };
        })
    );
  }

  /**
   * Starts execution of the user's function, including triggering checkpoints
   * and middleware hooks where appropriate.
   */
  async #startExecution(): Promise<void> {
    /**
     * Mutate input as neccessary based on middleware.
     */
    await this.#transformInput();

    /**
     * Start the timer to time out the run if needed.
     */
    void this.#timeout?.start();

    await this.#state.hooks?.beforeMemoization?.();

    /**
     * If we had no state to begin with, immediately end the memoization phase.
     */
    if (this.#state.allStateUsed()) {
      await this.#state.hooks?.afterMemoization?.();
      await this.#state.hooks?.beforeExecution?.();
    }

    /**
     * Trigger the user's function.
     */
    runAsPromise(() => this.#userFnToRun(this.#fnArg))
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      .finally(async () => {
        await this.#state.hooks?.afterMemoization?.();
        await this.#state.hooks?.beforeExecution?.();
        await this.#state.hooks?.afterExecution?.();
      })
      .then((data) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        this.#state.setCheckpoint({ type: "function-resolved", data });
      })
      .catch((error) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        this.#state.setCheckpoint({ type: "function-rejected", error });
      });
  }

  /**
   * Using middleware, transform input before running.
   */
  async #transformInput() {
    const inputMutations = await this.#state.hooks?.transformInput?.({
      ctx: { ...this.#fnArg },
      steps: Object.values(this.#state.stepState),
      fn: this.options.fn,
    });

    if (inputMutations?.ctx) {
      this.#fnArg = inputMutations.ctx;
    }

    if (inputMutations?.steps) {
      this.#state.stepState = inputMutations.steps.reduce(
        (steps, step) => ({
          ...steps,
          [step.id]: step,
        }),
        {}
      );
    }
  }

  /**
   * Using middleware, transform output before returning.
   */
  async #transformOutput(
    dataOrError: Parameters<
      NonNullable<RunHookStack["transformOutput"]>
    >[0]["result"]
  ): Promise<ExecutionResult> {
    const output = { ...dataOrError };

    if (typeof output.error !== "undefined") {
      output.data = serializeError(output.error);
    }

    const transformedOutput = await this.#state.hooks?.transformOutput?.({
      result: { ...output },
      step: this.#state.executingStep,
    });

    const { data, error } = { ...output, ...transformedOutput?.result };

    if (typeof error !== "undefined") {
      /**
       * Ensure we give middleware the chance to decide on retriable behaviour
       * by looking at the error returned from output transformation.
       */
      let retriable: boolean | string = !(error instanceof NonRetriableError);
      if (retriable && error instanceof RetryAfterError) {
        retriable = error.retryAfter;
      }

      const serializedError = serializeError(error);

      return { type: "function-rejected", error: serializedError, retriable };
    }

    return { type: "function-resolved", data: undefinedToNull(data) };
  }

  #createExecutionState(): V1ExecutionState {
    let { promise: checkpointPromise, resolve: checkpointResolve } =
      createDeferredPromise<Checkpoint>();

    const loop: V1ExecutionState["loop"] = (async function* (
      cleanUp?: () => void
    ) {
      try {
        while (true) {
          yield await checkpointPromise;
        }
      } finally {
        cleanUp?.();
      }
    })(() => {
      this.#timeout?.clear();
    });

    const state: V1ExecutionState = {
      stepState: this.options.stepState,
      steps: {},
      loop,
      hasSteps: Boolean(Object.keys(this.options.stepState).length),
      stepCompletionOrder: this.options.stepCompletionOrder,
      setCheckpoint: (checkpoint: Checkpoint) => {
        ({ promise: checkpointPromise, resolve: checkpointResolve } =
          checkpointResolve(checkpoint));
      },
      allStateUsed: () => {
        return Object.values(state.stepState).every((step) => {
          return step.seen;
        });
      },
    };

    return state;
  }

  #createFnArg(): AnyContext {
    const step = this.#createStepTools();

    let fnArg = {
      ...(this.options.data as { event: EventPayload }),
      step,
    } as AnyContext;

    /**
     * Handle use of the `onFailure` option by deserializing the error.
     */
    if (this.options.isFailureHandler) {
      const eventData = z
        .object({ error: failureEventErrorSchema })
        .parse(fnArg.event?.data);

      (fnArg as Partial<Pick<FailureEventArgs, "error">>) = {
        ...fnArg,
        error: deserializeError(eventData.error),
      };
    }

    return fnArg;
  }

  #createStepTools(): ReturnType<
    typeof createStepTools<ClientOptions, Record<string, EventPayload>, string>
  > {
    /**
     * A list of steps that have been found and are being rolled up before being
     * reported to the core loop.
     */
    let foundStepsToReport: FoundStep[] = [];

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
     * Given a colliding step ID, maybe warn the user about parallel indexing.
     */
    const maybeWarnOfParallelIndexing = (collisionId: string) => {
      if (warnOfParallelIndexing) {
        return;
      }

      const stepExists = Boolean(this.#state.steps[collisionId]);

      const stepFoundThisTick = foundStepsToReport.some((step) => {
        return step.id === collisionId;
      });

      if (stepExists && !stepFoundThisTick) {
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
          })
        );
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

      foundStepsReportPromise = resolveAfterPending()
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

          for (let i = 0; i < this.#state.stepCompletionOrder.length; i++) {
            const handled = foundStepsToReport
              .find((step) => {
                return step.hashedId === this.#state.stepCompletionOrder[i];
              })
              ?.handle();

            if (handled) {
              return void reportNextTick();
            }
          }

          // If we've handled no steps in this "tick," roll up everything we've
          // found and report it.
          const steps = [...foundStepsToReport] as [FoundStep, ...FoundStep[]];
          foundStepsToReport = [];

          return void this.#state.setCheckpoint({
            type: "steps-found",
            steps: steps,
          });
        });
    };

    /**
     * A helper used to push a step to the list of steps to report.
     */
    const pushStepToReport = (step: FoundStep) => {
      foundStepsToReport.push(step);
      reportNextTick();
    };

    const stepHandler: StepHandler = async ({
      args,
      matchOp,
      opts,
    }): Promise<unknown> => {
      await beforeExecHooksPromise;

      if (!this.#state.hasSteps && opts?.nonStepExecuteInline && opts.fn) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        return runAsPromise(() => opts.fn?.(...args));
      }

      if (this.#state.executingStep) {
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
            whatHappened: "We detected that you have nested `step.*` tooling.",
            consequences: "Nesting `step.*` tooling is not supported.",
            type: "warn",
            reassurance:
              "It's possible to see this warning if steps are separated by regular asynchronous calls, which is fine.",
            stack: true,
            toFixNow:
              "Make sure you're not using `step.*` tooling inside of other `step.*` tooling. If you need to compose steps together, you can create a new async function and call it from within your step function, or use promise chaining.",
            code: ErrCode.NESTING_STEPS,
          })
        );
      }

      const stepOptions = getStepOptions(args[0]);
      const opId = matchOp(stepOptions, ...args.slice(1));

      if (this.#state.steps[opId.id]) {
        const originalId = opId.id;
        maybeWarnOfParallelIndexing(originalId);

        for (let i = 1; ; i++) {
          const newId = [originalId, STEP_INDEXING_SUFFIX, i].join("");

          if (!this.#state.steps[newId]) {
            opId.id = newId;
            break;
          }
        }

        console.debug(
          `${logPrefix} debug - Step "${originalId}" already exists; automatically indexing to "${opId.id}"`
        );
      }

      const { promise, resolve, reject } = createDeferredPromise();
      const hashedId = _internals.hashId(opId.id);
      const stepState = this.#state.stepState[hashedId];
      if (stepState) {
        stepState.seen = true;
      }

      const step: FoundStep = {
        ...opId,
        hashedId,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        fn: opts?.fn ? () => opts.fn?.(...args) : undefined,
        fulfilled: Boolean(stepState),
        displayName: opId.displayName ?? opId.id,
        handled: false,
        handle: () => {
          if (step.handled) {
            return false;
          }

          step.handled = true;

          if (stepState) {
            stepState.fulfilled = true;

            if (typeof stepState.data !== "undefined") {
              resolve(stepState.data);
            } else {
              reject(stepState.error);
            }
          }

          return true;
        },
      };

      this.#state.steps[opId.id] = step;
      this.#state.hasSteps = true;
      pushStepToReport(step);

      /**
       * If this is the last piece of state we had, we've now finished
       * memoizing.
       */
      if (!beforeExecHooksPromise && this.#state.allStateUsed()) {
        await (beforeExecHooksPromise = (async () => {
          await this.#state.hooks?.beforeExecution?.();
          await this.#state.hooks?.afterMemoization?.();
        })());
      }

      return promise;
    };

    return createStepTools(this.options.client, stepHandler);
  }

  #getUserFnToRun(): AnyHandler {
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

  #initializeTimer(state: V1ExecutionState): void {
    if (!this.options.requestedRunStep) {
      return;
    }

    this.#timeout = createTimeoutPromise(this.#timeoutDuration);

    void this.#timeout.then(async () => {
      await this.#state.hooks?.afterMemoization?.();
      await this.#state.hooks?.beforeExecution?.();
      await this.#state.hooks?.afterExecution?.();

      state.setCheckpoint({
        type: "step-not-found",
        step: {
          id: this.options.requestedRunStep as string,
          op: StepOpCode.StepNotFound,
        },
      });
    });
  }

  async #initializeMiddleware(): Promise<RunHookStack> {
    const ctx = this.options.data as Pick<
      Readonly<BaseContext<ClientOptions, string>>,
      "event" | "events" | "runId"
    >;

    const hooks = await getHookStack(
      this.options.fn["middleware"],
      "onFunctionRun",
      {
        ctx,
        fn: this.options.fn,
        steps: Object.values(this.options.stepState),
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
          };
        },
        transformOutput: (prev, output) => {
          return {
            result: { ...prev.result, ...output?.result },
            step: prev.step,
          };
        },
      }
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
    checkpoint: C
  ) => MaybePromise<ExecutionResult | void>;
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
   * A map of step IDs to their functions to run. The executor can request a
   * specific step to run, so we need to store the function to run here.
   */
  steps: Record<string, FoundStep>;

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
