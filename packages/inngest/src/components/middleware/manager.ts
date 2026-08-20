import { timeStr } from "../../helpers/strings.ts";
import type { Logger } from "../../middleware/logger.ts";
import type { Context, StepOpCode } from "../../types.ts";
import {
  type AsyncContext,
  getAsyncCtxSync,
  runWithAsyncCtx,
} from "../execution/als.ts";
import type { MemoizedOp } from "../execution/InngestExecution.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import type { Middleware } from "./middleware.ts";
import {
  isSleepInput,
  optsFromStepInput,
  stepInputFromOpts,
  stepTypeFromOpCode,
  UnreachableError,
} from "./utils.ts";

type ExecutionContext = NonNullable<AsyncContext["execution"]>;

export interface StepInfoOptions {
  hashedId: string;
  userlandId: string;
  displayName?: string;
  memoized: boolean;
  stepType: Middleware.StepType;
  input?: unknown[];
}

export interface ApplyToStepInput {
  op: StepOpCode;
  opts?: Record<string, unknown>;
  hashedId: string;
  userlandId: string;
  displayName?: string;
  memoized: boolean;
}

export interface PreparedStep {
  entryPoint: () => Promise<unknown>;

  /**
   * Only used for sleep steps. The sleep's wake-up time must be in the op name,
   * and that may be changed by the `transformStepInput` hook. The user-facing
   * name is actually the op's `displayName` field (yes, that's confusing).
   */
  opName?: string;

  /**
   * For step kinds where middleware input maps to the outgoing op's opts
   * (e.g. invoke, waitForEvent). Derived by reversing `stepInputFromOpts`.
   */
  opOpts?: Record<string, unknown>;

  setActualHandler: (handler: () => Promise<unknown>) => void;
  stepInfo: Middleware.StepInfo;
}

/**
 * Manages middleware. Hides middleware complexity from elsewhere in the
 * codebase. Not for for public use.
 *
 * A MiddlewareManager is created once per execution request by the execution
 * engine, so fields on this class should be treated as request-scoped state.
 */
export class MiddlewareManager {
  private readonly fnArg: Context.Any;
  private readonly getStepState: () => Record<string, MemoizedOp>;

  /**
   * Whether any middleware defines `transformStepInput`. Used for perf
   * optimization.
   */
  private readonly hasTransformStepInput: boolean;

  /**
   * Whether memoization has ended. Used for idempotency, since memoization must
   * only call once per request.
   */
  private memoizationEnded = false;

  private readonly fn: InngestFunction.Any;
  private readonly middleware: Middleware.BaseMiddleware[];
  private readonly internalLogger: Logger;

  /**
   * Tracks recursion guard state per async execution branch. Parallel memoized
   * sibling steps get separate branches, so one step's wrapStep does not hide
   * another step's middleware. Steps created by a middleware inside its own
   * wrapStep keep the declaring branch, so that same middleware is skipped for
   * those nested steps instead of recursively prepending/planning forever.
   */
  private readonly activeWrapStepByExecution = new WeakMap<
    ExecutionContext,
    Set<Middleware.BaseMiddleware>
  >();

  /**
   * Fallback recursion guard for runtimes without AsyncLocalStorage. This
   * preserves the legacy best-effort behavior for edge runtimes that cannot
   * isolate concurrent async branches.
   *
   * TODO: Remove this when we have a hard requirement for AsyncLocalStorage
   * (i.e. no fallbacks).
   */
  private readonly activeWrapStep = new Set<Middleware.BaseMiddleware>();

  constructor(
    fnArg: Context.Any,
    getStepState: () => Record<string, MemoizedOp>,
    middleware: Middleware.BaseMiddleware[] = [],
    fn: InngestFunction.Any,
    logger: Logger,
  ) {
    this.fnArg = fnArg;
    this.getStepState = getStepState;
    this.middleware = middleware;
    this.fn = fn;
    this.internalLogger = logger;

    this.hasTransformStepInput = middleware.some((mw) =>
      Boolean(mw?.transformStepInput),
    );
  }

  hasMiddleware(): boolean {
    return this.middleware.length > 0;
  }

  /**
   * Derives step-kind, extracts input, runs `transformStepInput` middleware,
   * and creates a deferred handler entry point. Does NOT build the wrapStep
   * chain — the caller should do that after any post-processing (e.g. ID
   * collision resolution) so middleware sees final values.
   */
  async applyToStep(input: ApplyToStepInput): Promise<PreparedStep> {
    const stepType = stepTypeFromOpCode(
      input.op,
      input.opts,
      this.internalLogger,
    );
    const stepInput = stepInputFromOpts(stepType, input.opts);

    const stepInfo = this.buildStepInfo({
      hashedId: input.hashedId,
      userlandId: input.userlandId,
      displayName: input.displayName,
      memoized: input.memoized,
      stepType,
      input: stepInput,
    });

    // Only run transformStepInput if at least one middleware defines it.  This
    // avoids some allocations that are unnecessary when no middleware will read
    // or mutate them.
    if (this.hasTransformStepInput) {
      const originalInput = stepInfo.input;
      const transformed = await this.transformStepInput(stepInfo);
      stepInfo.options = transformed.stepOptions;

      // Preserve undefined if input wasn't changed from the initial empty array
      if (originalInput === undefined && transformed.input.length === 0) {
        stepInfo.input = undefined;
      } else {
        stepInfo.input = transformed.input;
      }
    }

    // For sleep steps, if middleware transformed the input, re-derive the op
    // name (which encodes the wake-up time). If there's no input, the matchOp
    // already set the name directly.
    let opName: string | undefined;
    if (stepType === "sleep" && stepInfo.input !== undefined) {
      if (!isSleepInput(stepInfo.input[0])) {
        throw new Error(
          "Sleep time must be a string, number, Date, or Temporal.Duration",
        );
      }
      opName = timeStr(stepInfo.input[0]);
    }

    // Reverse the input→opts mapping for step kinds where the whole opts
    // object was wrapped as input (e.g. invoke, waitForEvent).
    const opOpts = optsFromStepInput(stepType, stepInfo.input);

    // Deferred handler pattern — actual handler set later based on memoization
    let actualHandler: (() => Promise<unknown>) | undefined;
    const entryPoint = async () => {
      if (!actualHandler) {
        throw new Error("Handler not initialized");
      }
      return actualHandler();
    };
    const setActualHandler = (handler: () => Promise<unknown>) => {
      actualHandler = handler;
    };

    return {
      entryPoint,
      opName,
      opOpts,
      setActualHandler,
      stepInfo,
    };
  }

  private buildStepInfo(opts: StepInfoOptions): Middleware.StepInfo {
    return {
      hashedId: opts.hashedId,
      input: opts.input,
      memoized: opts.memoized,
      options: {
        id: opts.userlandId,
        ...(opts.displayName !== undefined && { name: opts.displayName }),
      },
      stepType: opts.stepType,
    };
  }

  private buildSteps(): Middleware.TransformFunctionInputArgs["steps"] {
    const result: Middleware.TransformFunctionInputArgs["steps"] = {};
    const stepState = this.getStepState();

    for (const [id, op] of Object.entries(stepState)) {
      if (op.error !== undefined) {
        result[id] = {
          type: "error" as const,
          error: op.error,
        };
      } else if (op.input !== undefined) {
        result[id] = {
          type: "input" as const,
          input: op.input,
        };
      } else {
        result[id] = {
          type: "data" as const,
          data: op.data,
        };
      }
    }

    return result;
  }

  /**
   * Apply transformFunctionInput middleware in forward order.
   * Each middleware builds on the previous result.
   */
  async transformFunctionInput(): Promise<Middleware.TransformFunctionInputArgs> {
    let result: Middleware.TransformFunctionInputArgs = {
      ctx: this.fnArg,
      fn: this.fn,
      steps: this.buildSteps(),
    };

    for (const mw of this.middleware) {
      if (mw?.transformFunctionInput) {
        result = await mw.transformFunctionInput(result);
      }
    }

    return result;
  }

  /**
   * Wrap a run handler with wrapFunctionHandler middlewares (reverse order for
   * onion layering, same pattern as wrapStepHandler).
   */
  wrapRunHandler(handler: () => Promise<unknown>): () => Promise<unknown> {
    let chain: () => Promise<unknown> = handler;
    for (let i = this.middleware.length - 1; i >= 0; i--) {
      const mw = this.middleware[i];
      if (mw?.wrapFunctionHandler) {
        const next = chain;
        chain = () =>
          mw.wrapFunctionHandler!({
            ctx: this.fnArg,
            fn: this.fn,
            next,
          });
      }
    }
    return chain;
  }

  /**
   * Apply transformStepInput middleware in forward order.
   * Each middleware builds on the previous result.
   */
  private async transformStepInput(
    stepInfo: Middleware.StepInfo,
  ): Promise<Middleware.TransformStepInputArgs> {
    let result: Middleware.TransformStepInputArgs = {
      fn: this.fn,
      stepInfo: {
        hashedId: stepInfo.hashedId,
        memoized: stepInfo.memoized,
        stepType: stepInfo.stepType,
      },
      stepOptions: { ...stepInfo.options },
      input: [...(stepInfo.input ?? [])],
    };

    for (const mw of this.middleware) {
      if (mw?.transformStepInput) {
        result = await mw.transformStepInput(result);
      }
    }

    return result;
  }

  /**
   * Wrap a step handler with wrapStep middlewares (reverse order for
   * onion layering). Returns the wrapped handler.
   *
   * Build the wrapStep onion around the resolver for the value returned to user
   * code for this step. Keep recursion protection scoped to the current async
   * branch so parallel steps work properly: a step created by middleware before
   * it calls next() skips that same middleware, but unrelated parallel steps
   * still run through it.
   */
  buildWrapStepChain(
    handler: () => Promise<unknown>,
    stepInfo: Middleware.StepInfo,
  ): () => Promise<unknown> {
    let chain: () => Promise<unknown> = handler;
    for (let i = this.middleware.length - 1; i >= 0; i--) {
      const mw = this.middleware[i];
      if (mw?.wrapStep) {
        const next = chain;
        chain = () => {
          if (!mw.wrapStep) {
            throw new UnreachableError("wrapStep is undefined");
          }

          const asyncContext = getAsyncCtxSync();
          const asyncExecution = asyncContext?.execution;

          // Use the current async execution branch as the guard boundary: it
          // lets parallel sibling steps each run through this middleware, while
          // steps created inside this middleware's own wrapStep inherit the
          // branch and skip this middleware to avoid recursive planning.
          let activeWrapStep: Set<Middleware.BaseMiddleware>;
          if (asyncExecution) {
            const storedActiveWrapStep =
              this.activeWrapStepByExecution.get(asyncExecution);
            if (storedActiveWrapStep) {
              activeWrapStep = storedActiveWrapStep;
            } else {
              activeWrapStep = new Set<Middleware.BaseMiddleware>();
            }
          } else {
            activeWrapStep = this.activeWrapStep;
          }

          // Infinite recursion guard: skip if this middleware is already
          // executing in this async branch.
          if (activeWrapStep.has(mw)) {
            return next();
          }

          // Clone guard state for ALS-backed executions before entering this
          // middleware. That preserves recursion history for this branch
          // without sharing in-flight middleware state with sibling branches.
          let branchActiveWrapStep: Set<Middleware.BaseMiddleware>;
          if (asyncExecution) {
            branchActiveWrapStep = new Set(activeWrapStep);
          } else {
            branchActiveWrapStep = activeWrapStep;
          }

          const runWrapStep = () => {
            branchActiveWrapStep.add(mw);

            // Remove from active while inside next() so only the middleware
            // that directly calls ctx.step.run() is guarded.
            const guardedNext = () => {
              branchActiveWrapStep.delete(mw);
              return next().finally(() => {
                branchActiveWrapStep.add(mw);
              });
            };

            return mw.wrapStep!({
              ctx: this.fnArg,
              fn: this.fn,
              next: guardedNext,
              stepInfo,
            }).finally(() => {
              branchActiveWrapStep.delete(mw);
            });
          };

          // Give this wrapStep call its own ALS execution object. Async work
          // spawned from here, including ctx.step.run() before next(), sees
          // this branch's guard state.
          if (!asyncContext || !asyncExecution) {
            return runWrapStep();
          }

          const branchExecution = { ...asyncExecution };
          this.activeWrapStepByExecution.set(
            branchExecution,
            branchActiveWrapStep,
          );

          return runWithAsyncCtx(
            {
              ...asyncContext,
              execution: branchExecution,
            },
            runWrapStep,
          );
        };
      }
    }
    return chain;
  }

  async onStepStart(stepInfo: Middleware.StepInfo): Promise<void> {
    for (const mw of this.middleware) {
      if (mw?.onStepStart) {
        try {
          await mw.onStepStart({
            ctx: this.fnArg,
            fn: this.fn,
            stepInfo,
          });
        } catch (err) {
          this.internalLogger.error(
            {
              err,
              hook: "onStepStart",
              mw: mw.id,
            },
            "middleware error",
          );
        }
      }
    }
  }

  async onStepComplete(
    stepInfo: Middleware.StepInfo,
    output: unknown,
  ): Promise<void> {
    for (const mw of this.middleware) {
      if (mw?.onStepComplete) {
        try {
          await mw.onStepComplete({
            ctx: this.fnArg,
            fn: this.fn,
            output,
            stepInfo,
          });
        } catch (err) {
          this.internalLogger.error(
            {
              err,
              hook: "onStepComplete",
              mw: mw.id,
            },
            "middleware error",
          );
        }
      }
    }
  }

  /**
   * Build a wrapStepHandler chain around the actual step handler.
   * Called once per `step.run` attempt (not for memoized steps).
   * Simpler than buildWrapStepChain — no recursion guard needed.
   */
  buildWrapStepHandlerChain(
    handler: () => Promise<unknown>,
    stepInfo: Middleware.StepInfo,
  ): () => Promise<unknown> {
    let chain: () => Promise<unknown> = handler;
    for (let i = this.middleware.length - 1; i >= 0; i--) {
      const mw = this.middleware[i];
      if (mw?.wrapStepHandler) {
        const next = chain;
        chain = () =>
          mw.wrapStepHandler!({
            ctx: this.fnArg,
            fn: this.fn,
            next,
            stepInfo,
          });
      }
    }
    return chain;
  }

  async onStepError(
    stepInfo: Middleware.StepInfo,
    error: Error,
    isFinalAttempt: boolean,
  ): Promise<void> {
    for (const mw of this.middleware) {
      if (mw?.onStepError) {
        try {
          await mw.onStepError({
            ctx: this.fnArg,
            error,
            fn: this.fn,
            isFinalAttempt,
            stepInfo,
          });
        } catch (err) {
          this.internalLogger.error(
            {
              err,
              hook: "onStepError",
              mw: mw.id,
            },
            "middleware error",
          );
        }
      }
    }
  }

  /**
   * Idempotent: safe to call from every code path that might end memoization.
   */
  async onMemoizationEnd(): Promise<void> {
    if (this.memoizationEnded) {
      return;
    }
    this.memoizationEnded = true;

    for (const mw of this.middleware) {
      if (mw?.onMemoizationEnd) {
        try {
          await mw.onMemoizationEnd({
            ctx: this.fnArg,
            fn: this.fn,
          });
        } catch (err) {
          this.internalLogger.error(
            {
              err,
              hook: "onMemoizationEnd",
              mw: mw.id,
            },
            "middleware error",
          );
        }
      }
    }
  }

  async onRunStart(): Promise<void> {
    for (const mw of this.middleware) {
      if (mw?.onRunStart) {
        try {
          await mw.onRunStart({
            ctx: this.fnArg,
            fn: this.fn,
          });
        } catch (err) {
          this.internalLogger.error(
            {
              err,
              hook: "onRunStart",
              mw: mw.id,
            },
            "middleware error",
          );
        }
      }
    }
  }

  async onRunComplete(output: unknown): Promise<void> {
    for (const mw of this.middleware) {
      if (mw?.onRunComplete) {
        try {
          await mw.onRunComplete({
            ctx: this.fnArg,
            fn: this.fn,
            output,
          });
        } catch (err) {
          this.internalLogger.error(
            {
              err,
              hook: "onRunComplete",
              mw: mw.id,
            },
            "middleware error",
          );
        }
      }
    }
  }

  async onRunError(error: Error, isFinalAttempt: boolean): Promise<void> {
    for (const mw of this.middleware) {
      if (mw?.onRunError) {
        try {
          await mw.onRunError({
            ctx: this.fnArg,
            error,
            fn: this.fn,
            isFinalAttempt,
          });
        } catch (err) {
          this.internalLogger.error(
            {
              err,
              hook: "onRunError",
              mw: mw.id,
            },
            "middleware error",
          );
        }
      }
    }
  }
}
