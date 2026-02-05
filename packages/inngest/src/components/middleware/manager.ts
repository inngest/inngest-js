import type { Context } from "../../types.ts";
import type { MemoizedOp } from "../execution/InngestExecution.ts";
import type { Middleware } from "./middleware.ts";

type StepKind = "run" | "sendEvent" | "invoke";

export interface StepInfoOptions {
  hashedId: string;
  userlandId: string;
  displayName?: string;
  memoized: boolean;
  stepKind: StepKind;
  input?: unknown[];
}

/**
 * Manages middleware. Hides middleware complexity from elsewhere in the
 * codebase. Not for for public use.
 */
export class MiddlewareManager {
  private readonly fnArg: Context.Any;
  private readonly getStepState: () => Record<string, MemoizedOp>;
  private readonly middleware: Middleware.BaseMiddleware[];
  private readonly runId: string;

  constructor(
    fnArg: Context.Any,
    runId: string,
    getStepState: () => Record<string, MemoizedOp>,
    middleware: Middleware.BaseMiddleware[] = [],
  ) {
    this.fnArg = fnArg;
    this.runId = runId;
    this.getStepState = getStepState;
    this.middleware = middleware;
  }

  hasMiddleware(): boolean {
    return this.middleware.length > 0;
  }

  /**
   * Build RunInfo from the current execution context.
   */
  buildRunInfo(): Middleware.RunInfo {
    return {
      attempt: this.fnArg.attempt,
      event: this.fnArg.event,
      events: this.fnArg.events,
      runId: this.runId,
      step: this.fnArg.step,
      steps: this.buildStepsForRunInfo(),
    };
  }

  buildStepInfo(opts: StepInfoOptions): Middleware.StepInfo {
    return {
      hashedId: opts.hashedId,
      id: opts.userlandId,
      input: opts.input,
      memoized: opts.memoized,
      name: opts.displayName ?? opts.userlandId,
      stepKind: opts.stepKind,
    };
  }

  private buildStepsForRunInfo(): Middleware.RunInfo["steps"] {
    const result: Middleware.RunInfo["steps"] = {};
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
   * Wrap a run handler with transformRunInput middlewares (reverse order for
   * onion layering). Returns the wrapped handler and potentially modified
   * runInfo.
   */
  wrapRunHandler(
    handler: () => Promise<unknown>,
    runInfo: Middleware.RunInfo,
  ): { handler: () => Promise<unknown>; runInfo: Middleware.RunInfo } {
    let wrappedHandler = handler;
    let currentRunInfo = runInfo;

    for (let i = this.middleware.length - 1; i >= 0; i--) {
      const mw = this.middleware[i];
      if (mw?.transformRunInput) {
        const transformed = mw.transformRunInput({
          handler: wrappedHandler,
          runInfo: currentRunInfo,
        });
        wrappedHandler = transformed.handler;
        currentRunInfo = transformed.runInfo;
      }
    }

    return { handler: wrappedHandler, runInfo: currentRunInfo };
  }

  /**
   * Wrap a step handler with transformStepInput middlewares (reverse order for
   * onion layering).  Returns the wrapped handler and potentially modified
   * stepInfo.
   */
  wrapStepHandler(
    handler: () => Promise<unknown>,
    stepInfo: Middleware.StepInfo,
    runInfo: Middleware.RunInfo,
  ): { handler: () => Promise<unknown>; stepInfo: Middleware.StepInfo } {
    let wrappedHandler = handler;
    let currentStepInfo = stepInfo;

    for (let i = this.middleware.length - 1; i >= 0; i--) {
      const mw = this.middleware[i];
      if (mw?.transformStepInput) {
        const transformed = mw.transformStepInput({
          handler: wrappedHandler,
          stepInfo: currentStepInfo,
          runInfo,
        });
        wrappedHandler = transformed.handler;
        currentStepInfo = transformed.stepInfo;
      }
    }

    return { handler: wrappedHandler, stepInfo: currentStepInfo };
  }

  transformRunOutput(output: unknown, runInfo: Middleware.RunInfo): unknown {
    let result = output;

    for (const mw of this.middleware) {
      if (mw?.transformRunOutput) {
        result = mw.transformRunOutput({ output: result, runInfo });
      }
    }

    return result;
  }

  transformRunError(error: Error, runInfo: Middleware.RunInfo): Error {
    let result = error;

    for (const mw of this.middleware) {
      if (mw?.transformRunError) {
        result = mw.transformRunError({ error: result, runInfo });
      }
    }

    return result;
  }

  transformStepOutput(
    output: unknown,
    stepInfo: Middleware.StepInfo,
    runInfo: Middleware.RunInfo,
  ): unknown {
    let result = output;

    for (const mw of this.middleware) {
      if (mw?.transformStepOutput) {
        result = mw.transformStepOutput({
          output: result,
          stepInfo,
          runInfo,
        });
      }
    }

    return result;
  }

  transformStepError(
    error: Error,
    stepInfo: Middleware.StepInfo,
    runInfo: Middleware.RunInfo,
  ): Error {
    let result = error;

    for (const mw of this.middleware) {
      if (mw?.transformStepError) {
        result = mw.transformStepError({
          error: result,
          stepInfo,
          runInfo,
        });
      }
    }

    return result;
  }

  onStepStart(
    stepInfo: Middleware.StepInfo,
    runInfo: Middleware.RunInfo,
  ): void {
    for (const mw of this.middleware) {
      if (mw?.onStepStart) {
        mw.onStepStart({ stepInfo, runInfo });
      }
    }
  }

  onStepEnd(
    stepInfo: Middleware.StepInfo,
    runInfo: Middleware.RunInfo,
    data: unknown,
  ): void {
    for (const mw of this.middleware) {
      if (mw?.onStepEnd) {
        mw.onStepEnd({ stepInfo, runInfo, data });
      }
    }
  }

  onStepError(
    stepInfo: Middleware.StepInfo,
    runInfo: Middleware.RunInfo,
    error: Error,
  ): void {
    for (const mw of this.middleware) {
      if (mw?.onStepError) {
        mw.onStepError({ stepInfo, runInfo, error });
      }
    }
  }
}
