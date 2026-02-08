import type { Context, StepOptions } from "../../types.ts";
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

export interface PreparedStepHandler {
  wrappedHandler: () => Promise<unknown>;
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
   * Consolidates step-kind derivation, step-input extraction, deferred handler
   * creation, and middleware wrapping into a single call.
   */
  applyToStep(input: ApplyToStepInput): PreparedStepHandler {
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

    // Deferred handler pattern — actual handler set later based on memoization
    let actualHandler: (() => Promise<unknown>) | undefined;
    const middlewareEntryPoint = async () => {
      if (!actualHandler) {
        throw new Error("Handler not initialized");
      }
      return actualHandler();
    };
    const setActualHandler = (handler: () => Promise<unknown>) => {
      actualHandler = handler;
    };

    const wrapped = this.wrapStepHandler(middlewareEntryPoint, stepInfo);

    return {
      wrappedHandler: wrapped.handler,
      setActualHandler,
      stepInfo: wrapped.stepInfo,
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
      ctx: {
        event: this.fnArg.event,
        events: this.fnArg.events,
        step: this.fnArg.step,
      },
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
    const transforms: Middleware.WrapFunctionHandlerReturn[] = [];
    for (let i = this.middleware.length - 1; i >= 0; i--) {
      const mw = this.middleware[i];
      if (mw?.wrapFunctionHandler) {
        transforms.push(mw.wrapFunctionHandler());
      }
    }

    if (transforms.length === 0) return handler;

    const ctx = this.fnArg;
    let chain: () => Promise<unknown> = handler;
    for (const transform of transforms) {
      const next = chain;
      chain = () => transform({ next, ctx });
    }
    return chain;
  }

  /**
   * Wrap a step handler with wrapStep middlewares (reverse order for
   * onion layering).  Returns the wrapped handler and potentially modified
   * stepInfo.
   */
  wrapStepHandler(
    handler: () => Promise<unknown>,
    stepInfo: Middleware.StepInfo,
  ): { handler: () => Promise<unknown>; stepInfo: Middleware.StepInfo } {
    // Collect transform functions by calling wrapStep
    // in reverse order (so first middleware becomes outermost in chain)
    const transforms: Middleware.WrapStepReturn[] = [];
    for (let i = this.middleware.length - 1; i >= 0; i--) {
      const mw = this.middleware[i];
      if (mw?.wrapStep) {
        transforms.push(mw.wrapStep(stepInfo));
      }
    }

    if (transforms.length === 0) {
      return { handler, stepInfo };
    }

    // Build next chain from innermost to outermost.
    // Innermost: write final stepOptions/input back to stepInfo, then call handler.
    const originalInput = stepInfo.input;
    let chain: (args: {
      stepOptions: StepOptions;
      input: unknown[];
    }) => Promise<unknown> = async ({ stepOptions, input }) => {
      stepInfo.options = stepOptions;
      // Preserve undefined if input wasn't changed from the initial empty array
      stepInfo.input =
        originalInput === undefined && input.length === 0 ? undefined : input;
      return handler();
    };

    const ctx = this.fnArg;
    for (const transform of transforms) {
      const next = chain;
      chain = ({ stepOptions, input }) =>
        transform({ next, ctx, stepOptions, input });
    }

    const outerChain = chain;
    const wrappedHandler = () =>
      outerChain({
        stepOptions: { ...stepInfo.options },
        input: [...(stepInfo.input ?? [])],
      });

    return { handler: wrappedHandler, stepInfo };
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

  onRunError(error: Error): void {
    const ctx = this.fnArg;
    for (const mw of this.middleware) {
      if (mw?.onRunError) {
        mw.onRunError({ ctx, error });
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
 * Collects transforms in reverse order (so first middleware is outermost)
 * and returns a zero-arg function that kicks off the chain.
 */
export function buildWrapRequestChain(
  middleware: Middleware.BaseMiddleware[],
  handler: () => Promise<Middleware.Response>,
  requestInfo: Middleware.Request,
): () => Promise<Middleware.Response> {
  const transforms: Middleware.WrapRequestReturn[] = [];
  for (let i = middleware.length - 1; i >= 0; i--) {
    const mw = middleware[i];
    if (mw?.wrapRequest) {
      transforms.push(mw.wrapRequest({ requestInfo }));
    }
  }

  if (transforms.length === 0) return handler;

  let chain: () => Promise<Middleware.Response> = handler;
  for (const transform of transforms) {
    const next = chain;
    chain = () => transform({ next });
  }
  return chain;
}
