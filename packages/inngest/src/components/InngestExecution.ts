import Debug, { type Debugger } from "debug";
import { type Simplify } from "type-fest";
import { z } from "zod";
import { type ServerTiming } from "../helpers/ServerTiming";
import { deserializeError, prettyError } from "../helpers/errors";
import {
  createDeferredPromise,
  createTimeoutPromise,
} from "../helpers/promises";
import { type MaybePromise } from "../helpers/types";
import {
  StepOpCode,
  failureEventErrorSchema,
  type AnyContext,
  type AnyHandler,
  type BaseContext,
  type ClientOptions,
  type EventPayload,
  type FailureEventArgs,
  type IncomingOp,
  type OutgoingOp,
  type StepRunResponse,
} from "../types";
import { type AnyInngest } from "./Inngest";
import { type AnyInngestFunction } from "./InngestFunction";
import { getHookStack, type RunHookStack } from "./InngestMiddleware";
import { createStepTools, type FoundStep } from "./InngestStepTools";

/**
 * Types of checkpoints that can be reached during execution.
 */
interface Checkpoints {
  "steps-found": { steps: [FoundStep, ...FoundStep[]] };
  "function-rejected": { error: unknown };
  "function-resolved": { data: unknown };
  "step-not-found": { step: OutgoingOp };
  "middleware-error": { error: unknown };
}

/**
 * The possible results of an execution.
 */
interface ExecutionResults {
  "function-resolved": { data: unknown };
  "step-ran": { step: OutgoingOp };
  "function-rejected": { error: unknown };
  "steps-found": { steps: [OutgoingOp, ...OutgoingOp[]] };
  "step-not-found": { step: OutgoingOp };
}

/**
 * Options for creating a new {@link InngestExecution} instance.
 */
export interface InngestExecutionOptions {
  client: AnyInngest;
  fn: AnyInngestFunction;
  data: unknown;
  stepState: Record<string, MemoizedOp>;
  requestedRunStep?: string;
  timer?: ServerTiming;
  isFailureHandler?: boolean;
}

export class InngestExecution {
  options: InngestExecutionOptions;
  state: ExecutionState;
  fnArg: AnyContext;
  checkpointHandlers: CheckpointHandlers;
  timeoutDuration = 1000 * 10;
  #execution: Promise<ExecutionResult> | undefined;
  #debug: Debugger = Debug("inngest");
  #userFnToRun: AnyHandler;

  /**
   * If we're supposed to run a particular step via `requestedRunStep`, this
   * will be a `Promise` that resolves after no steps have been found for
   * `timeoutDuration` milliseconds.
   *
   * If we're not supposed to run a particular step, this will be `undefined`.
   */
  timeout?: ReturnType<typeof createTimeoutPromise>;

  constructor(options: InngestExecutionOptions) {
    this.options = options;

    this.#userFnToRun = this.#getUserFnToRun();
    this.state = this.#createExecutionState(this.options.stepState);
    this.fnArg = this.#createFnArg(this.state);
    this.checkpointHandlers = this.#createCheckpointHandlers();
    this.#initializeTimer(this.state);

    this.#debug = this.#debug.extend(this.fnArg.runId);

    this.#debug(
      "created new execution for run;",
      this.options.requestedRunStep
        ? `wanting to run step "${this.options.requestedRunStep}"`
        : "discovering steps"
    );

    this.#debug("existing state keys:", Object.keys(this.state.stepState));
  }

  /**
   * Idempotently start the execution of the user's function.
   */
  public start(): Promise<ExecutionResult> {
    this.#debug("starting execution");

    return (this.#execution ??= this.#start().then((result) => {
      this.#debug("result:", result);
      return result;
    }));
  }

  /**
   * Starts execution of the user's function and the core loop.
   */
  async #start(): Promise<ExecutionResult> {
    try {
      const allCheckpointHandler = this.#getCheckpointHandler("");
      this.state.hooks = await this.#initializeMiddleware();
      await this.#startExecution();

      for await (const checkpoint of this.state.loop) {
        await allCheckpointHandler(checkpoint);

        const handler = this.#getCheckpointHandler(checkpoint.type);
        const result = await handler(checkpoint);

        if (result) {
          return result;
        }
      }
    } finally {
      void this.state.loop.return();
      await this.state.hooks?.beforeResponse?.();
    }

    throw new Error("TODO generator finished or blew up");
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
        this.#debug("checkpoint:", checkpoint);
      },

      /**
       * Middleware has thrown an error.
       */
      "middleware-error": async (checkpoint) => {
        /**
         * TODO Middleware-specific error log pls
         */
        const { data, error } = await this.#transformOutput({
          result: { error: checkpoint.error },
          step: this.state.executingStep,
        });

        if (typeof error !== "undefined") {
          return { type: "function-rejected", error };
        }

        return { type: "function-resolved", data };
      },

      /**
       * The user's function has completed and returned a value.
       */
      "function-resolved": async (checkpoint) => {
        const { data, error } = await this.#transformOutput({
          result: { data: checkpoint.data },
          step: this.state.executingStep,
        });

        if (typeof error !== "undefined") {
          return { type: "function-rejected", error };
        }

        return { type: "function-resolved", data };
      },

      /**
       * The user's function has thrown an error.
       */
      "function-rejected": async (checkpoint) => {
        const { data, error } = await this.#transformOutput({
          result: { error: checkpoint.error },
          step: this.state.executingStep,
        });

        if (typeof error !== "undefined") {
          return { type: "function-rejected", error };
        }

        return { type: "function-resolved", data };
      },

      /**
       * We've found one or more steps. Here we may want to run a step or report
       * them back to Inngest.
       */
      "steps-found": async ({ steps }) => {
        const stepResult = await this.#tryExecuteStep(steps);
        if (stepResult) {
          const middlewareStepResult = await this.#transformOutput({
            result: stepResult,
            step: this.state.executingStep,
          });

          if (typeof middlewareStepResult.error !== "undefined") {
            // TODO Is this correct?
            return {
              type: "function-rejected",
              error: middlewareStepResult.error,
            };
          }

          return {
            type: "step-ran",
            step: { ...stepResult, ...middlewareStepResult },
          };
        }

        const newSteps = await this.#filterNewSteps(steps);
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
    return this.checkpointHandlers[type] as (
      checkpoint: Checkpoint
    ) => MaybePromise<ExecutionResult | void>;
  }

  async #tryExecuteStep(steps: FoundStep[]): Promise<OutgoingOp | void> {
    if (!this.options.requestedRunStep) {
      return;
    }

    const step = steps.find(
      (step) => step.id === this.options.requestedRunStep && step.fn
    );

    if (step) {
      this.timeout?.clear(); // TODO duplicate clean-up; bad
      return await this.#executeStep(step);
    }

    return void this.timeout?.reset();
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
    const stepsToFulfil = Object.keys(this.state.stepState).length;
    const fulfilledSteps = steps.filter((step) => step.fulfilled).length;
    const foundAllCompletedSteps = stepsToFulfil === fulfilledSteps;

    if (!foundAllCompletedSteps) {
      console.warn(
        prettyError({
          whatHappened: "bad mate",
          reassurance: "not cool",
          why: "state looks wrong",
          consequences: "may be over-sensitive; needs tests",
        })
      );
    }

    /**
     * We're finishing up; let's trigger the last of the hooks.
     */
    await this.state.hooks?.afterMemoization?.();
    await this.state.hooks?.beforeExecution?.();
    await this.state.hooks?.afterExecution?.();

    return newSteps.map<OutgoingOp>((step) => ({
      op: step.op,
      id: step.id,
      name: step.name,
      opts: step.opts,
    })) as [OutgoingOp, ...OutgoingOp[]];
  }

  async #executeStep({ id, name, opts, fn }: FoundStep): Promise<OutgoingOp> {
    await this.state.hooks?.afterMemoization?.();
    await this.state.hooks?.beforeExecution?.();

    this.state.executingStep = { op: StepOpCode.RunStep, name, opts };
    this.#debug(`executing step "${id}"`);
    const outgoingOp: OutgoingOp = { id, op: StepOpCode.RunStep, name, opts };

    return (
      Promise.resolve(fn?.())
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        .finally(async () => {
          await this.state.hooks?.afterExecution?.();
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
    Promise.resolve(this.#userFnToRun(this.fnArg))
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      .finally(async () => {
        await this.state.hooks?.afterMemoization?.();
        await this.state.hooks?.beforeExecution?.();
        await this.state.hooks?.afterExecution?.();
      })
      .then((data) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        this.state.setCheckpoint({ type: "function-resolved", data });
      })
      .catch((error) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        this.state.setCheckpoint({ type: "function-rejected", error });
      });
  }

  /**
   * Using middleware, transform input before running.
   */
  async #transformInput() {
    const inputMutations = await this.state.hooks?.transformInput?.({
      ctx: { ...this.fnArg },
      steps: Object.values(this.state.stepState),
      fn: this.options.fn,
    });

    if (inputMutations?.ctx) {
      this.fnArg = inputMutations.ctx;
    }

    if (inputMutations?.steps) {
      this.state.stepState = inputMutations.steps.reduce(
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
    arg: Parameters<NonNullable<RunHookStack["transformOutput"]>>[0]
  ): Promise<Pick<OutgoingOp, "data" | "error">> {
    return {
      ...arg.result,
      ...(await this.state.hooks?.transformOutput?.(arg))?.result,
    };
  }

  #createExecutionState(
    stepState: InngestExecutionOptions["stepState"]
  ): ExecutionState {
    let { promise: checkpointPromise, resolve: checkpointResolve } =
      createDeferredPromise<Checkpoint>();

    const loop: ExecutionState["loop"] = (async function* (
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
      this.timeout?.clear();
    });

    const state: ExecutionState = {
      stepState,
      steps: {},
      loop,
      setCheckpoint: (checkpoint: Checkpoint) => {
        ({ promise: checkpointPromise, resolve: checkpointResolve } =
          checkpointResolve(checkpoint));
      },
      allStateUsed: () => {
        return Object.values(state.stepState).every((step) => {
          return step.fulfilled;
        });
      },
    };

    return state;
  }

  #createFnArg(state: ExecutionState): AnyContext {
    const step = createStepTools(this.options.client, state);

    let fnArg = {
      ...(this.options.data as { event: EventPayload }),
      step,
    } as AnyContext;

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

  #getUserFnToRun(): AnyHandler {
    if (!this.options.isFailureHandler) {
      return this.options.fn["fn"];
    }

    if (!this.options.fn["onFailureFn"]) {
      throw new Error("TODO");
    }

    return this.options.fn["onFailureFn"];
  }

  #initializeTimer(state: ExecutionState): void {
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

  async #initializeMiddleware(): Promise<RunHookStack> {
    const ctx = this.options.data as Pick<
      Readonly<
        BaseContext<
          ClientOptions,
          string,
          Record<string, (...args: unknown[]) => unknown>
        >
      >,
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
      },
      {
        errorHandler: (error) => {
          this.state.setCheckpoint({ type: "middleware-error", error });
        },
      }
    );

    return hooks;
  }
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

type ExecutionResult = {
  [K in keyof ExecutionResults]: Simplify<{ type: K } & ExecutionResults[K]>;
}[keyof ExecutionResults];

export type ExecutionResultHandler = (
  result: ExecutionResult
) => MaybePromise<StepRunResponse>;

export type ExecutionResultHandlers = {
  [E in ExecutionResult as E["type"]]: (
    result: E
  ) => MaybePromise<StepRunResponse>;
};

interface MemoizedOp extends IncomingOp {
  fulfilled?: boolean;
}

export interface ExecutionState {
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
}
