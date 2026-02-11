import type { Context } from "../../types.ts";
import { StepOpCode } from "../../types.ts";
import type { MemoizedOp } from "../execution/InngestExecution.ts";
import type { Middleware } from "./middleware.ts";

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
  private readonly middleware: Middleware.BaseMiddleware[];

  constructor(
    fnArg: Context.Any,
    getStepState: () => Record<string, MemoizedOp>,
    middleware: Middleware.BaseMiddleware[] = [],
  ) {
    this.fnArg = fnArg;
    this.getStepState = getStepState;
    this.middleware = middleware;
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
    const stepInput = stepInputFromOp(stepKind, input.opts);

    const stepInfo = this.buildStepInfo({
      hashedId: input.hashedId,
      userlandId: input.userlandId,
      displayName: input.displayName,
      memoized: input.memoized,
      stepKind,
      input: stepInput,
    });

    // Apply transformStepInput middleware (forward order)
    const originalInput = stepInfo.input;
    const transformed = this.transformStepInput(stepInfo);
    stepInfo.options = transformed.stepOptions;
    // Preserve undefined if input wasn't changed from the initial empty array
    stepInfo.input =
      originalInput === undefined && transformed.input.length === 0
        ? undefined
        : transformed.input;

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
        mw.onStepStart({ stepInfo, ctx });
      }
    }
  }

  onStepEnd(stepInfo: Middleware.StepInfo, data: unknown): void {
    const ctx = this.fnArg;
    for (const mw of this.middleware) {
      if (mw?.onStepEnd) {
        mw.onStepEnd({ stepInfo, ctx, data });
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
        mw.onStepError({ stepInfo, ctx, error, isFinalAttempt });
      }
    }
  }

  onMemoizationEnd(): void {
    for (const mw of this.middleware) {
      if (mw?.onMemoizationEnd) {
        mw.onMemoizationEnd();
      }
    }
  }

  onRunStart(): void {
    const ctx = this.fnArg;
    for (const mw of this.middleware) {
      if (mw?.onRunStart) {
        mw.onRunStart({ ctx });
      }
    }
  }

  onRunEnd(data: unknown): void {
    const ctx = this.fnArg;
    for (const mw of this.middleware) {
      if (mw?.onRunEnd) {
        mw.onRunEnd({ ctx, data });
      }
    }
  }

  onRunError(error: Error, isFinalAttempt: boolean): void {
    const ctx = this.fnArg;
    for (const mw of this.middleware) {
      if (mw?.onRunError) {
        mw.onRunError({ ctx, error, isFinalAttempt });
      }
    }
  }
}

function stepKindFromOpCode(
  op: StepOpCode,
  opts?: Record<string, unknown>,
): Middleware.StepKind {
  switch (op) {
    case StepOpCode.InvokeFunction:
      return "invoke";
    case StepOpCode.StepPlanned:
      return opts?.type === "step.sendEvent" ? "sendEvent" : "run";
    case StepOpCode.Sleep:
      return "sleep";
    case StepOpCode.WaitForEvent:
      return "waitForEvent";
    default:
      return "unknown";
  }
}

function stepInputFromOp(
  stepKind: Middleware.StepKind,
  opts?: Record<string, unknown>,
): unknown[] | undefined {
  if (stepKind === "invoke" || stepKind === "waitForEvent") {
    return [opts];
  }
  return Array.isArray(opts?.input) ? (opts.input as unknown[]) : undefined;
}

/**
 * Build an onion-style middleware chain for `wrapRequest`.
 *
 * Iterates in reverse order (so first middleware is outermost)
 * and returns a zero-arg function that kicks off the chain.
 */
export function buildWrapRequestChain(
  middleware: Middleware.BaseMiddleware[],
  handler: () => Promise<Middleware.Response>,
  requestInfo: Middleware.Request,
): () => Promise<Middleware.Response> {
  let chain: () => Promise<Middleware.Response> = handler;
  for (let i = middleware.length - 1; i >= 0; i--) {
    const mw = middleware[i];
    if (mw?.wrapRequest) {
      const next = chain;
      chain = () => mw.wrapRequest!(next, { requestInfo });
    }
  }
  return chain;
}

/**
 * Build an onion-style middleware chain for `wrapClientRequest`.
 *
 * Same pattern as `buildWrapRequestChain` but wraps the outgoing HTTP call
 * in `client.send()` instead of the incoming execution request.
 */
export function buildWrapClientRequestChain(
  middleware: Middleware.BaseMiddleware[],
  handler: () => Promise<unknown>,
  payloads: Middleware.WrapClientRequestArgs["payloads"],
): () => Promise<unknown> {
  let chain: () => Promise<unknown> = handler;
  for (let i = middleware.length - 1; i >= 0; i--) {
    const mw = middleware[i];
    if (mw?.wrapClientRequest) {
      const next = chain;
      chain = () => mw.wrapClientRequest!(next, { payloads });
    }
  }
  return chain;
}
