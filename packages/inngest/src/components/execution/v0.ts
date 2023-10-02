import canonicalize from "canonicalize";
import { sha1 } from "hash.js";
import { z } from "zod";
import {
  ErrCode,
  deserializeError,
  functionStoppedRunningErr,
  prettyError,
  serializeError,
} from "../../helpers/errors";
import {
  resolveAfterPending,
  resolveNextTick,
  runAsPromise,
} from "../../helpers/promises";
import { type PartialK } from "../../helpers/types";
import {
  StepOpCode,
  failureEventErrorSchema,
  type AnyContext,
  type AnyHandler,
  type BaseContext,
  type ClientOptions,
  type EventPayload,
  type FailureEventArgs,
  type HashedOp,
  type IncomingOp,
  type OpStack,
  type OutgoingOp,
} from "../../types";
import { getHookStack, type RunHookStack } from "../InngestMiddleware";
import {
  createStepTools,
  getStepOptions,
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
} from "./InngestExecution";

export const createV0InngestExecution: InngestExecutionFactory = (options) => {
  return new V0InngestExecution(options);
};

export class V0InngestExecution
  extends InngestExecution
  implements IInngestExecution
{
  #state: V0ExecutionState;
  #execution: Promise<ExecutionResult> | undefined;
  #userFnToRun: AnyHandler;
  #fnArg: AnyContext;

  constructor(options: InngestExecutionOptions) {
    super(options);

    this.#userFnToRun = this.#getUserFnToRun();
    this.#state = this.#createExecutionState();
    this.#fnArg = this.#createFnArg();
  }

  public start() {
    this.debug("starting V0 execution");

    return (this.#execution ??= this.#start().then((result) => {
      this.debug("result:", result);
      return result;
    }));
  }

  async #start(): Promise<ExecutionResult> {
    this.#state.hooks = await this.#initializeMiddleware();

    try {
      await this.#transformInput();
      await this.#state.hooks.beforeMemoization?.();

      if (this.#state.opStack.length === 0 && !this.options.requestedRunStep) {
        await this.#state.hooks.afterMemoization?.();
        await this.#state.hooks.beforeExecution?.();
      }

      const userFnPromise = runAsPromise(() => this.#userFnToRun(this.#fnArg));

      let pos = -1;

      do {
        if (pos >= 0) {
          if (
            !this.options.requestedRunStep &&
            pos === this.#state.opStack.length - 1
          ) {
            await this.#state.hooks.afterMemoization?.();
            await this.#state.hooks.beforeExecution?.();
          }

          this.#state.tickOps = {};
          const incomingOp = this.#state.opStack[pos] as IncomingOp;
          this.#state.currentOp = this.#state.allFoundOps[incomingOp.id];

          if (!this.#state.currentOp) {
            /**
             * We're trying to resume the function, but we can't find where to go.
             *
             * This means that either the function has changed or there are async
             * actions in-between steps that we haven't noticed in previous
             * executions.
             *
             * Whichever the case, this is bad and we can't continue in this
             * undefined state.
             */
            throw new NonRetriableError(
              prettyError({
                whatHappened: " Your function was stopped from running",
                why: "We couldn't resume your function's state because it may have changed since the run started or there are async actions in-between steps that we haven't noticed in previous executions.",
                consequences:
                  "Continuing to run the function may result in unexpected behaviour, so we've stopped your function to ensure nothing unexpected happened!",
                toFixNow:
                  "Ensure that your function is either entirely step-based or entirely non-step-based, by either wrapping all asynchronous logic in `step.run()` calls or by removing all `step.*()` calls.",
                otherwise:
                  "For more information on why step functions work in this manner, see https://www.inngest.com/docs/functions/multi-step#gotchas",
                stack: true,
                code: ErrCode.NON_DETERMINISTIC_FUNCTION,
              })
            );
          }

          this.#state.currentOp.fulfilled = true;

          if (typeof incomingOp.data !== "undefined") {
            this.#state.currentOp.resolve(incomingOp.data);
          } else {
            this.#state.currentOp.reject(incomingOp.error);
          }
        }

        await resolveAfterPending();
        this.#state.reset();
        pos++;
      } while (pos < this.#state.opStack.length);

      await this.#state.hooks.afterMemoization?.();

      const discoveredOps = Object.values(this.#state.tickOps).map<OutgoingOp>(
        tickOpToOutgoing
      );

      const runStep =
        this.options.requestedRunStep ||
        this.#getEarlyExecRunStep(discoveredOps);

      if (runStep) {
        const userFnOp = this.#state.allFoundOps[runStep];
        const stepToRun = userFnOp?.fn;

        if (!stepToRun) {
          throw new Error(
            `Bad stack; executor requesting to run unknown step "${runStep}"`
          );
        }

        const outgoingUserFnOp = {
          ...tickOpToOutgoing(userFnOp),
          op: StepOpCode.RunStep,
        };

        await this.#state.hooks.beforeExecution?.();
        this.#state.executingStep = true;

        const result = await runAsPromise(stepToRun)
          .finally(() => {
            this.#state.executingStep = false;
          })
          .catch(async (error: Error) => {
            return await this.#transformOutput({ error }, outgoingUserFnOp);
          })
          .then(async (data) => {
            await this.#state.hooks?.afterExecution?.();
            return await this.#transformOutput({ data }, outgoingUserFnOp);
          });

        const { type: _type, ...rest } = result;

        return { type: "step-ran", step: { ...outgoingUserFnOp, ...rest } };
      }

      if (!discoveredOps.length) {
        const fnRet = await Promise.race([
          userFnPromise.then((data) => ({ type: "complete", data } as const)),
          resolveNextTick().then(() => ({ type: "incomplete" } as const)),
        ]);

        if (fnRet.type === "complete") {
          await this.#state.hooks.afterExecution?.();

          const allOpsFulfilled = Object.values(this.#state.allFoundOps).every(
            (op) => {
              return op.fulfilled;
            }
          );

          if (allOpsFulfilled) {
            return await this.#transformOutput({ data: fnRet.data });
          }
        } else if (!this.#state.hasUsedTools) {
          this.#state.nonStepFnDetected = true;
          const data = await userFnPromise;
          await this.#state.hooks.afterExecution?.();
          return await this.#transformOutput({ data });
        } else {
          const hasOpsPending = Object.values(this.#state.allFoundOps).some(
            (op) => {
              return op.fulfilled === false;
            }
          );

          if (!hasOpsPending) {
            throw new NonRetriableError(
              functionStoppedRunningErr(
                ErrCode.ASYNC_DETECTED_AFTER_MEMOIZATION
              )
            );
          }
        }
      }

      await this.#state.hooks.afterExecution?.();

      return {
        type: "steps-found",
        steps: discoveredOps as [OutgoingOp, ...OutgoingOp[]],
      };
    } catch (error) {
      return await this.#transformOutput({ error });
    } finally {
      await this.#state.hooks.beforeResponse?.();
    }
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

  #createExecutionState(): V0ExecutionState {
    const state: V0ExecutionState = {
      allFoundOps: {},
      tickOps: {},
      tickOpHashes: {},
      currentOp: undefined,
      hasUsedTools: false,
      reset: () => {
        state.tickOpHashes = {};
        state.allFoundOps = { ...state.allFoundOps, ...state.tickOps };
      },
      nonStepFnDetected: false,
      executingStep: false,
      opStack: this.options.stepCompletionOrder.reduce<IncomingOp[]>(
        (acc, stepId) => {
          const stepState = this.options.stepState[stepId];
          if (!stepState) {
            return acc;
          }

          return [...acc, stepState];
        },
        []
      ),
    };

    return state;
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

  #createFnArg(): AnyContext {
    // Start referencing everything
    this.#state.tickOps = this.#state.allFoundOps;

    /**
     * Create a unique hash of an operation using only a subset of the operation's
     * properties; will never use `data` and will guarantee the order of the
     * object so we don't rely on individual tools for that.
     *
     * If the operation already contains an ID, the current ID will be used
     * instead, so that users can provide their own IDs.
     */
    const hashOp = (
      /**
       * The op to generate a hash from. We only use a subset of the op's
       * properties when creating the hash.
       */
      op: PartialK<HashedOp, "id">
    ): HashedOp => {
      /**
       * It's difficult for v0 to understand whether or not an op has
       * historically contained a custom ID, as all step usage now require them.
       *
       * For this reason, we make the assumption that steps in v0 do not have a
       * custom ID and generate one for them as we would in all recommendations
       * and examples.
       */
      const obj = {
        parent: this.#state.currentOp?.id ?? null,
        op: op.op,
        name: op.name as string,
        opts: op.opts ?? null,
      };

      const collisionHash = _internals.hashData(obj);

      const pos = (this.#state.tickOpHashes[collisionHash] =
        (this.#state.tickOpHashes[collisionHash] ?? -1) + 1);

      return {
        ...op,
        id: _internals.hashData({ pos, ...obj }),
      };
    };

    const stepHandler: StepHandler = ({ args, matchOp, opts }) => {
      if (this.#state.nonStepFnDetected) {
        if (opts?.nonStepExecuteInline && opts.fn) {
          return Promise.resolve(opts.fn(...args));
        }

        throw new NonRetriableError(
          functionStoppedRunningErr(ErrCode.STEP_USED_AFTER_ASYNC)
        );
      }

      if (this.#state.executingStep) {
        throw new NonRetriableError(
          prettyError({
            whatHappened: "Your function was stopped from running",
            why: "We detected that you have nested `step.*` tooling.",
            consequences: "Nesting `step.*` tooling is not supported.",
            stack: true,
            toFixNow:
              "Make sure you're not using `step.*` tooling inside of other `step.*` tooling. If you need to compose steps together, you can create a new async function and call it from within your step function, or use promise chaining.",
            otherwise:
              "For more information on step functions with Inngest, see https://www.inngest.com/docs/functions/multi-step",
            code: ErrCode.NESTING_STEPS,
          })
        );
      }

      this.#state.hasUsedTools = true;

      const stepOptions = getStepOptions(args[0]);
      const opId = hashOp(matchOp(stepOptions, ...args.slice(1)));

      return new Promise<unknown>((resolve, reject) => {
        this.#state.tickOps[opId.id] = {
          ...opId,
          ...(opts?.fn ? { fn: () => opts.fn?.(...args) } : {}),
          resolve,
          reject,
          fulfilled: false,
        };
      });
    };

    const step = createStepTools(this.options.client, stepHandler);

    const fnArg = {
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

  /**
   * Using middleware, transform input before running.
   */
  async #transformInput() {
    const inputMutations = await this.#state.hooks?.transformInput?.({
      ctx: { ...this.#fnArg },
      steps: Object.values(this.options.stepState),
      fn: this.options.fn,
    });

    if (inputMutations?.ctx) {
      this.#fnArg = inputMutations.ctx;
    }

    if (inputMutations?.steps) {
      this.#state.opStack = [...inputMutations.steps];
    }
  }

  #getEarlyExecRunStep(ops: OutgoingOp[]): string | undefined {
    if (ops.length !== 1) return;

    const op = ops[0];

    if (
      op &&
      op.op === StepOpCode.StepPlanned &&
      typeof op.opts === "undefined"
    ) {
      return op.id;
    }
  }

  /**
   * Using middleware, transform output before returning.
   */
  async #transformOutput(
    dataOrError: Parameters<
      NonNullable<RunHookStack["transformOutput"]>
    >[0]["result"],
    step?: Readonly<Omit<OutgoingOp, "id">>
  ): Promise<ExecutionResult> {
    const output = { ...dataOrError };

    if (typeof output.error !== "undefined") {
      output.data = serializeError(output.error);
    }

    const transformedOutput = await this.#state.hooks?.transformOutput?.({
      result: { ...output },
      step,
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

    return { type: "function-resolved", data };
  }
}

interface TickOp extends HashedOp {
  fn?: (...args: unknown[]) => unknown;
  fulfilled: boolean;
  resolve: (value: unknown | PromiseLike<unknown>) => void;
  reject: (reason?: unknown) => void;
}

export interface V0ExecutionState {
  /**
   * The tree of all found ops in the entire invocation.
   */
  allFoundOps: Record<string, TickOp>;

  /**
   * All synchronous operations found in this particular tick. The array is
   * reset every tick.
   */
  tickOps: Record<string, TickOp>;

  /**
   * A hash of operations found within this tick, with keys being the hashed
   * ops themselves (without a position) and the values being the number of
   * times that op has been found.
   *
   * This is used to provide some mutation resilience to the op stack,
   * allowing us to survive same-tick mutations of code by ensuring per-tick
   * hashes are based on uniqueness rather than order.
   */
  tickOpHashes: Record<string, number>;

  /**
   * Tracks the current operation being processed. This can be used to
   * understand the contextual parent of any recorded operations.
   */
  currentOp: TickOp | undefined;

  /**
   * If we've found a user function to run, we'll store it here so a component
   * higher up can invoke and await it.
   */
  userFnToRun?: (...args: unknown[]) => unknown;

  /**
   * A boolean to represent whether the user's function is using any step
   * tools.
   *
   * If the function survives an entire tick of the event loop and hasn't
   * touched any tools, we assume that it is a single-step async function and
   * should be awaited as usual.
   */
  hasUsedTools: boolean;

  /**
   * A function that should be used to reset the state of the tools after a
   * tick has completed.
   */
  reset: () => void;

  /**
   * If `true`, any use of step tools will, by default, throw an error. We do
   * this when we detect that a function may be mixing step and non-step code.
   *
   * Created step tooling can decide how to manually handle this on a
   * case-by-case basis.
   *
   * In the future, we can provide a way for a user to override this if they
   * wish to and understand the danger of side-effects.
   *
   * Defaults to `false`.
   */
  nonStepFnDetected: boolean;

  /**
   * When true, we are currently executing a user's code for a single step
   * within a step function.
   */
  executingStep: boolean;

  /**
   * Initialized middleware hooks for this execution.
   *
   * Middleware hooks are cached to ensure they can only be run once, which
   * means that these hooks can be called in many different places to ensure we
   * handle all possible execution paths.
   */
  hooks?: RunHookStack;

  /**
   * The op stack to pass to the function as state, likely stored in
   * `ctx._state` in the Inngest payload.
   *
   * This must be provided in order to always be cognizant of step function
   * state and to allow for multi-step functions.
   */
  opStack: OpStack;
}

const tickOpToOutgoing = (op: TickOp): OutgoingOp => {
  return {
    op: op.op,
    id: op.id,
    name: op.name,
    opts: op.opts,
  };
};

/**
 * An operation ready to hash to be used to memoise step function progress.
 *
 * @internal
 */
export type UnhashedOp = {
  name: string;
  op: StepOpCode;
  opts: Record<string, unknown> | null;
  parent: string | null;
  pos?: number;
};

const hashData = (op: UnhashedOp): string => {
  return sha1().update(canonicalize(op)).digest("hex");
};

/**
 * Exported for testing.
 */
export const _internals = { hashData };
