import Debug, { type Debugger } from "debug";
import { type Simplify } from "type-fest";
import { type MaybePromise } from "type-plus";
import { type ServerTiming } from "../../helpers/ServerTiming";
import { debugPrefix } from "../../helpers/consts";
import { type Context, type IncomingOp, type OutgoingOp } from "../../types";
import { type Inngest } from "../Inngest";
import { type ActionResponse } from "../InngestCommHandler";
import { type InngestFunction } from "../InngestFunction";

/**
 * The possible results of an execution.
 */
export interface ExecutionResults {
  "function-resolved": { data: unknown };
  "step-ran": { step: OutgoingOp };
  "function-rejected": { error: unknown; retriable: boolean | string };
  "steps-found": { steps: [OutgoingOp, ...OutgoingOp[]] };
  "step-not-found": { step: OutgoingOp };
}

export type ExecutionResult = {
  [K in keyof ExecutionResults]: Simplify<{ type: K } & ExecutionResults[K]>;
}[keyof ExecutionResults];

export type ExecutionResultHandler<T = ActionResponse> = (
  result: ExecutionResult
) => MaybePromise<T>;

export type ExecutionResultHandlers<T = ActionResponse> = {
  [E in ExecutionResult as E["type"]]: (result: E) => MaybePromise<T>;
};

export interface MemoizedOp extends IncomingOp {
  fulfilled?: boolean;
  seen?: boolean;
}

export enum ExecutionVersion {
  V0 = 0,
  V1 = 1,
}

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
  requestedRunStep?: string;
  timer?: ServerTiming;
  isFailureHandler?: boolean;
  disableImmediateExecution?: boolean;
}

export type InngestExecutionFactory = (
  options: InngestExecutionOptions
) => IInngestExecution;

export class InngestExecution {
  protected debug: Debugger;

  constructor(protected options: InngestExecutionOptions) {
    this.options = options;
    this.debug = Debug(debugPrefix).extend(this.options.runId);
  }
}

export interface IInngestExecution {
  start(): Promise<ExecutionResult>;
}
