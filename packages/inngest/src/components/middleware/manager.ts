import { getLogger } from "../../helpers/log.ts";
import { timeStr } from "../../helpers/strings.ts";
import type { Context, StepOpCode } from "../../types.ts";
import type { MemoizedOp } from "../execution/InngestExecution.ts";
import type { Middleware } from "./middleware.ts";
import {
  isTimeStrInput,
  optsFromStepInput,
  stepInputFromOpts,
  stepKindFromOpCode,
} from "./utils.ts";

export interface StepInfoOptions {
  hashedId: string;
  userlandId: string;
  displayName?: string;
  memoized: boolean;
  stepKind: Middleware.StepKind;
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
   * Whether memoization has ended. Used for idempotency.
   */
  private memoizationEnded = false;

  private readonly middleware: Middleware.BaseMiddleware[];

  constructor(
    fnArg: Context.Any,
    getStepState: () => Record<string, MemoizedOp>,
    middleware: Middleware.BaseMiddleware[] = [],
  ) {
    this.fnArg = fnArg;
    this.getStepState = getStepState;
    this.middleware = middleware;

    this.hasTransformStepInput = middleware.some(
      (mw) => !!mw?.transformStepInput,
    );
  }

  hasMiddleware(): boolean {
    return this.middleware.length > 0;
  }

  /**
   * Derives step-kind, extracts input, runs transformStepInput middleware,
   * and creates a deferred handler entry point. Does NOT build the wrapStep
   * chain — the caller should do that after any post-processing (e.g. ID
   * collision resolution) so middleware sees final values.
   */
  applyToStep(input: ApplyToStepInput): PreparedStep {
    const stepKind = stepKindFromOpCode(input.op, input.opts);
    const stepInput = stepInputFromOpts(stepKind, input.opts);

    const stepInfo = this.buildStepInfo({
      hashedId: input.hashedId,
      userlandId: input.userlandId,
      displayName: input.displayName,
      memoized: input.memoized,
      stepKind,
      input: stepInput,
    });

    // Only run transformStepInput if at least one middleware defines it.  This
    // avoids some allocations that are unnecessary when no middleware will read
    // or mutate them.
    if (this.hasTransformStepInput) {
      const originalInput = stepInfo.input;
      const transformed = this.transformStepInput(stepInfo);
      stepInfo.options = transformed.stepOptions;
      // Preserve undefined if input wasn't changed from the initial empty array
      stepInfo.input =
        originalInput === undefined && transformed.input.length === 0
          ? undefined
          : transformed.input;
    }

    // For sleep steps, if middleware transformed the input, re-derive the op
    // name (which encodes the wake-up time). If there's no input, the matchOp
    // already set the name directly.
    let opName: string | undefined;
    if (stepKind === "sleep" && stepInfo.input !== undefined) {
      if (!isTimeStrInput(stepInfo.input[0])) {
        throw new Error("Sleep time must be a string, number, or Date");
      }
      opName = timeStr(stepInfo.input[0]);
    }

    // Reverse the input→opts mapping for step kinds where the whole opts
    // object was wrapped as input (e.g. invoke, waitForEvent).
    const opOpts = optsFromStepInput(stepKind, stepInfo.input);

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
      stepKind: opts.stepKind,
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
  transformFunctionInput(): Middleware.TransformFunctionInputArgs {
    let result: Middleware.TransformFunctionInputArgs = {
      ctx: this.fnArg,
      steps: this.buildSteps(),
    };

    for (const mw of this.middleware) {
      if (mw?.transformFunctionInput) {
        result = mw.transformFunctionInput(result);
      }
    }

    return result;
  }

  /**
   * Wrap a run handler with wrapFunctionHandler middlewares (reverse order for
   * onion layering, same pattern as wrapStepHandler).
   */
  wrapRunHandler(handler: () => Promise<unknown>): () => Promise<unknown> {
    const ctx = this.fnArg;
    let chain: () => Promise<unknown> = handler;
    for (let i = this.middleware.length - 1; i >= 0; i--) {
      const mw = this.middleware[i];
      if (mw?.wrapFunctionHandler) {
        const next = chain;
        chain = () => mw.wrapFunctionHandler!(next, { ctx });
      }
    }
    return chain;
  }

  /**
   * Apply transformStepInput middleware in forward order.
   * Each middleware builds on the previous result.
   */
  private transformStepInput(
    stepInfo: Middleware.StepInfo,
  ): Middleware.TransformStepInputArgs {
    let result: Middleware.TransformStepInputArgs = {
      stepInfo: {
        hashedId: stepInfo.hashedId,
        memoized: stepInfo.memoized,
        stepKind: stepInfo.stepKind,
      },
      stepOptions: { ...stepInfo.options },
      input: [...(stepInfo.input ?? [])],
    };

    for (const mw of this.middleware) {
      if (mw?.transformStepInput) {
        result = mw.transformStepInput(result);
      }
    }

    return result;
  }

  /**
   * Wrap a step handler with wrapStep middlewares (reverse order for
   * onion layering). Returns the wrapped handler.
   */
  wrapStepHandler(
    handler: () => Promise<unknown>,
    stepInfo: Middleware.StepInfo,
  ): () => Promise<unknown> {
    const ctx = this.fnArg;
    let chain: () => Promise<unknown> = handler;
    for (let i = this.middleware.length - 1; i >= 0; i--) {
      const mw = this.middleware[i];
      if (mw?.wrapStep) {
        const next = chain;
        chain = () => mw.wrapStep!(next, { stepInfo, ctx });
      }
    }
    return chain;
  }

  onStepStart(stepInfo: Middleware.StepInfo): void {
    const ctx = this.fnArg;
    for (const mw of this.middleware) {
      if (mw?.onStepStart) {
        try {
          mw.onStepStart({ stepInfo, ctx });
        } catch (error) {
          getLogger().error("middleware error", {
            error,
            hook: "onStepStart",
            mw: mw.constructor.name,
          });
        }
      }
    }
  }

  onStepEnd(stepInfo: Middleware.StepInfo, data: unknown): void {
    const ctx = this.fnArg;
    for (const mw of this.middleware) {
      if (mw?.onStepEnd) {
        try {
          mw.onStepEnd({ stepInfo, ctx, data });
        } catch (error) {
          getLogger().error("middleware error", {
            error,
            hook: "onStepEnd",
            mw: mw.constructor.name,
          });
        }
      }
    }
  }

  onStepError(
    stepInfo: Middleware.StepInfo,
    error: Error,
    isFinalAttempt: boolean,
  ): void {
    const ctx = this.fnArg;
    for (const mw of this.middleware) {
      if (mw?.onStepError) {
        try {
          mw.onStepError({ stepInfo, ctx, error, isFinalAttempt });
        } catch (error) {
          getLogger().error("middleware error", {
            error,
            hook: "onStepError",
            mw: mw.constructor.name,
          });
        }
      }
    }
  }

  /**
   * Idempotent: safe to call from every code path that might end memoization.
   */
  onMemoizationEnd(): void {
    if (this.memoizationEnded) {
      return;
    }
    this.memoizationEnded = true;

    for (const mw of this.middleware) {
      if (mw?.onMemoizationEnd) {
        try {
          mw.onMemoizationEnd();
        } catch (error) {
          getLogger().error("middleware error", {
            error,
            hook: "onMemoizationEnd",
            mw: mw.constructor.name,
          });
        }
      }
    }
  }

  onRunStart(): void {
    const ctx = this.fnArg;
    for (const mw of this.middleware) {
      if (mw?.onRunStart) {
        try {
          mw.onRunStart({ ctx });
        } catch (error) {
          getLogger().error("middleware error", {
            error,
            hook: "onRunStart",
            mw: mw.constructor.name,
          });
        }
      }
    }
  }

  onRunEnd(data: unknown): void {
    const ctx = this.fnArg;
    for (const mw of this.middleware) {
      if (mw?.onRunEnd) {
        try {
          mw.onRunEnd({ ctx, data });
        } catch (error) {
          getLogger().error("middleware error", {
            error,
            hook: "onRunEnd",
            mw: mw.constructor.name,
          });
        }
      }
    }
  }

  onRunError(error: Error, isFinalAttempt: boolean): void {
    const ctx = this.fnArg;
    for (const mw of this.middleware) {
      if (mw?.onRunError) {
        try {
          mw.onRunError({ ctx, error, isFinalAttempt });
        } catch (error) {
          getLogger().error("middleware error", {
            error,
            hook: "onRunError",
            mw: mw.constructor.name,
          });
        }
      }
    }
  }
}
