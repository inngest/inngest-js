import Debug, { type Debugger } from "debug";
import { type ServerTiming } from "../../helpers/ServerTiming.js";
import { debugPrefix } from "../../helpers/consts.js";
import { type MaybePromise, type Simplify } from "../../helpers/types.js";
import { type Context, type IncomingOp, type OutgoingOp } from "../../types.js";
import { type Inngest } from "../Inngest.js";
import { type ActionResponse } from "../InngestCommHandler.js";
import { type InngestFunction } from "../InngestFunction.js";

/**
 * The possible results of an execution.
 */
export interface ExecutionResults {
  "function-resolved": { data: unknown };
  "step-ran": { step: OutgoingOp; retriable?: boolean | string };
  "function-rejected": { error: unknown; retriable: boolean | string };
  "steps-found": { steps: [OutgoingOp, ...OutgoingOp[]] };
  "step-not-found": { step: OutgoingOp };
}

export type ExecutionResult = {
  [K in keyof ExecutionResults]: Simplify<
    {
      type: K;
      ctx: Context.Any;
      ops: Record<string, MemoizedOp>;
    } & ExecutionResults[K]
  >;
}[keyof ExecutionResults];

export type ExecutionResultHandler<T = ActionResponse> = (
  result: ExecutionResult
) => MaybePromise<T>;

export type ExecutionResultHandlers<T = ActionResponse> = {
  [E in ExecutionResult as E["type"]]: (result: E) => MaybePromise<T>;
};

export interface MemoizedOp extends IncomingOp {
  /**
   * If the step has been hit during this run, these will be the arguments
   * passed to it.
   */
  rawArgs?: unknown[];
  fulfilled?: boolean;

  /**
   * The promise that has been returned to userland code.
   */
  promise?: Promise<unknown>;
  seen?: boolean;
}

/**
 * The execution models the SDK is aware of.
 *
 * This is used in a number of places to ensure all execution versions are
 * accounted for for a given operation.
 */
export enum ExecutionVersion {
  V0 = 0,
  V1 = 1,
  V2 = 2,
}

/**
 * The preferred execution version that will be used by the SDK when handling
 * brand new runs where the Executor is allowing us to choose.
 *
 * Changing this should not ever be a breaking change, as this will only change
 * new runs, not existing ones.
 */
export const PREFERRED_EXECUTION_VERSION =
  ExecutionVersion.V1 satisfies ExecutionVersion;

/**
 * Options for creating a new {@link InngestExecution} instance.
 */
export interface InngestExecutionOptions {
  client: Inngest.Any;
  fn: InngestFunction.Any;
  reqArgs: unknown[];
  runId: string;
  data: Omit<Context.Any, "step">;
  stepState: Record<string, MemoizedOp>;
  stepCompletionOrder: string[];

  /**
   * Headers to be sent with any request to Inngest during this execution.
   */
  headers: Record<string, string>;
  requestedRunStep?: string;
  timer?: ServerTiming;
  isFailureHandler?: boolean;
  disableImmediateExecution?: boolean;

  /**
   * Provide the ability to transform the context passed to the function before
   * the execution starts.
   */
  transformCtx?: (ctx: Readonly<Context.Any>) => Context.Any;
}

export type InngestExecutionFactory = (
  options: InngestExecutionOptions
) => IInngestExecution;

export class InngestExecution {
  protected debug: Debugger;

  constructor(protected options: InngestExecutionOptions) {
    this.debug = Debug(`${debugPrefix}:${this.options.runId}`);
  }
}

export interface IInngestExecution {
  start(): Promise<ExecutionResult>;
}
