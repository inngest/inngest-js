import { timeStr } from "../../helpers/strings.ts";
import type { Logger } from "../../middleware/logger.ts";
import type { Context, StepOpCode } from "../../types.ts";
import type { MemoizedOp } from "../execution/InngestExecution.ts";
import type { Middleware } from "./middleware.ts";
import {
  isTimeStrInput,
  optsFromStepInput,
  stepInputFromOpts,
  stepTypeFromOpCode,
  UnreachableError,
} from "./utils.ts";

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

  private readonly functionInfo: Middleware.FunctionInfo;
  private readonly middleware: Middleware.BaseMiddleware[];
  private readonly logger: Logger;

  /**
   * Infinite recursion guard for `wrapStep`. Prevents a middleware from
   * wrapping steps it creates inside its own `wrapStep` via `ctx.step.run`.
   */
  private readonly activeWrapStep = new Set<Middleware.BaseMiddleware>();

  constructor(
    fnArg: Context.Any,
    getStepState: () => Record<string, MemoizedOp>,
    middleware: Middleware.BaseMiddleware[] = [],
    functionInfo: Middleware.FunctionInfo,
    logger: Logger,
  ) {
    this.fnArg = fnArg;
    this.getStepState = getStepState;
    this.middleware = middleware;
    this.functionInfo = functionInfo;
    this.logger = logger;

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
    const stepType = stepTypeFromOpCode(input.op, input.opts, this.logger);
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
      if (!isTimeStrInput(stepInfo.input[0])) {
        throw new Error("Sleep time must be a string, number, or Date");
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
      functionInfo: this.functionInfo,
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
            functionInfo: this.functionInfo,
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
      functionInfo: this.functionInfo,
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

          // Infinite recursion guard: skip if this middleware is already
          // executing
          if (this.activeWrapStep.has(mw)) {
            return next();
          }

          this.activeWrapStep.add(mw);

          // Remove from active while inside next() so only the middleware
          // that directly calls ctx.step.run() is guarded.
          const guardedNext = () => {
            this.activeWrapStep.delete(mw);
            return next().finally(() => {
              this.activeWrapStep.add(mw);
            });
          };

          return mw.wrapStep!({
            ctx: this.fnArg,
            functionInfo: this.functionInfo,
            next: guardedNext,
            stepInfo,
          }).finally(() => {
            this.activeWrapStep.delete(mw);
          });
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
            functionInfo: this.functionInfo,
            stepInfo,
          });
        } catch (error) {
          this.logger.error(
            {
              error,
              hook: "onStepStart",
              mw: mw.constructor.name,
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
            functionInfo: this.functionInfo,
            output,
            stepInfo,
          });
        } catch (error) {
          this.logger.error(
            {
              error,
              hook: "onStepComplete",
              mw: mw.constructor.name,
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
            functionInfo: this.functionInfo,
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
            functionInfo: this.functionInfo,
            isFinalAttempt,
            stepInfo,
          });
        } catch (error) {
          this.logger.error(
            {
              error,
              hook: "onStepError",
              mw: mw.constructor.name,
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
            functionInfo: this.functionInfo,
          });
        } catch (error) {
          this.logger.error(
            {
              error,
              hook: "onMemoizationEnd",
              mw: mw.constructor.name,
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
            functionInfo: this.functionInfo,
          });
        } catch (error) {
          this.logger.error(
            {
              error,
              hook: "onRunStart",
              mw: mw.constructor.name,
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
            functionInfo: this.functionInfo,
            output,
          });
        } catch (error) {
          this.logger.error(
            {
              error,
              hook: "onRunComplete",
              mw: mw.constructor.name,
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
            functionInfo: this.functionInfo,
            isFinalAttempt,
          });
        } catch (error) {
          this.logger.error(
            {
              error,
              hook: "onRunError",
              mw: mw.constructor.name,
            },
            "middleware error",
          );
        }
      }
    }
  }
}
