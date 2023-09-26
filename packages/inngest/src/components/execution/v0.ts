import {
  type BaseContext,
  type ClientOptions,
  type HashedOp,
} from "../../types";
import { getHookStack, type RunHookStack } from "../InngestMiddleware";
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

  constructor(options: InngestExecutionOptions) {
    super(options);

    this.#state = this.#createExecutionState();
  }

  public start() {
    this.debug("starting execution");

    return (this.#execution ??= this.#start().then((result) => {
      this.debug("result:", result);
      return result;
    }));
  }

  async #start(): Promise<ExecutionResult> {
    this.#state.hooks = await this.#initializeMiddleware();

    return { type: "function-resolved", data: {} };
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
    };

    return state;
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
}
