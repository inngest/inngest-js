import Debug, { type Debugger } from "debug";
import { debugPrefix, ExecutionVersion } from "../../helpers/consts.ts";
import type { ServerTiming } from "../../helpers/ServerTiming.ts";
import type { MaybePromise, Simplify } from "../../helpers/types.ts";
import type {
  Context,
  IncomingOp,
  InternalCheckpointingOptions,
  OutgoingOp,
  StepMode,
} from "../../types.ts";
import type { Inngest } from "../Inngest.ts";
import type { ActionResponse } from "../InngestCommHandler.ts";
import type { InngestFunction } from "../InngestFunction.ts";
import type {
  MetadataKind,
  MetadataOpcode,
  MetadataScope,
} from "../InngestMetadata.ts";
import type { Middleware } from "../middleware/middleware.ts";

// Re-export ExecutionVersion so it's correctly recognized as an enum and not
// just a type. This can be lost when bundling if we don't re-export it here.
// See `pnpm run test:dist`.
export { ExecutionVersion };

/**
 * The possible results of an execution.
 */
export interface ExecutionResults {
  "function-resolved": {
    data: unknown;
    deferredGroups?: { id: string; name: string }[];
  };
  "step-ran": { step: OutgoingOp; retriable?: boolean | string };
  "function-rejected": {
    error: unknown;
    retriable: boolean | string;
    deferredGroups?: { id: string; name: string }[];
  };
  "steps-found": { steps: [OutgoingOp, ...OutgoingOp[]] };
  "step-not-found": { step: OutgoingOp };

  /**
   * Indicates that we need to relinquish control back to Inngest in order to
   * change step modes.
   */
  "change-mode": {
    to: StepMode;
    token: string;
  };
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
  result: ExecutionResult,
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
 * The preferred execution version that will be used by the SDK when handling
 * brand new runs where the Executor is allowing us to choose.
 *
 * Changing this should not ever be a breaking change, as this will only change
 * new runs, not existing ones.
 */
export const PREFERRED_ASYNC_EXECUTION_VERSION =
  ExecutionVersion.V2 satisfies ExecutionVersion;

/**
 * Options for creating a new {@link InngestExecution} instance.
 */
export interface InngestExecutionOptions {
  client: Inngest.Any;
  fn: InngestFunction.Any;

  /**
   * The UUID that represents this function in Inngest.
   *
   * This is used to reference the function during async checkpointing, when we
   * know the function/run already exists and just wish to reference it
   * directly.
   */
  internalFnId?: string;
  reqArgs: unknown[];
  runId: string;
  data: Omit<Context.Any, "step" | "group">;
  stepState: Record<string, MemoizedOp>;
  stepCompletionOrder: string[];
  stepMode: StepMode;
  checkpointingConfig?: InternalCheckpointingOptions;

  /**
   * If this execution is being run from a queue job, this will be an identifier
   * used to reference this execution in Inngest. SDKs are expected to parrot
   * this back in some responses to correctly attribute actions to this queue
   * item.
   */
  queueItemId?: string;

  /**
   * Headers to be sent with any request to Inngest during this execution.
   */
  headers: Record<string, string>;
  requestedRunStep?: string;
  timer?: ServerTiming;
  isFailureHandler?: boolean;
  disableImmediateExecution?: boolean;

  /**
   * Information about the incoming HTTP request that triggered this execution.
   * Used by middleware `wrapRequest` hooks.
   */
  requestInfo?: Middleware.Request;

  /**
   * Pre-created middleware instances to use for this execution. When provided,
   * the execution will use these instead of instantiating new ones from the
   * client. This ensures `wrapRequest` and other hooks share state on `this`.
   */
  middlewareInstances?: Middleware.BaseMiddleware[];

  /**
   * Provide the ability to transform the context passed to the function before
   * the execution starts.
   */
  transformCtx?: (ctx: Readonly<Context.Any>) => Context.Any;

  /**
   * A hook that is called to create an {@link ActionResponse} from the returned
   * value of an execution.
   *
   * This is required for checkpointing executions.
   */
  createResponse?: (data: unknown) => MaybePromise<ActionResponse>;

  /**
   * If this execution is a deferred run, this is the ID of the defer group
   * callback to execute after the main function completes.
   */
  deferGroupId?: string;

  /**
   * The result of the original function execution, passed to the defer
   * callback when running a deferred execution.
   */
  deferResult?: unknown;

  /**
   * The error from the original function execution, passed to the defer
   * callback when running a deferred execution.
   */
  deferError?: unknown;

  /**
   * Whether the parent function ran to completion (resolved or rejected).
   * When false, the parent failed before finishing and the SDK should reject
   * unmemoized steps during deferred replay instead of hanging.
   */
  deferRunEnded?: boolean;
}

export type InngestExecutionFactory = (
  options: InngestExecutionOptions,
) => IInngestExecution;

export class InngestExecution {
  protected debug: Debugger;

  constructor(protected options: InngestExecutionOptions) {
    this.debug = Debug(`${debugPrefix}:${this.options.runId}`);
  }
}

export interface IInngestExecution {
  version: ExecutionVersion;
  start(): Promise<ExecutionResult>;

  addMetadata(
    stepId: string,
    kind: MetadataKind,
    scope: MetadataScope,
    op: MetadataOpcode,
    values: Record<string, unknown>,
  ): boolean;

  /**
   * Register a deferred group callback to be executed after the function
   * completes.
   */
  registerDefer(name: string, callback: DeferCallback): void;

  /**
   * Cancel a previously registered deferred group, preventing it from being
   * included in the response.
   */
  cancelDefer(name: string): void;
}

/**
 * Arguments passed to a defer group callback when it is executed.
 */
export interface DeferCallbackArgs {
  /** The resolved value of the original function, if it succeeded. */
  result?: unknown;
  /** The error from the original function, if it failed. */
  error?: unknown;
}

/**
 * A callback registered via `group.defer()` that will be executed after the
 * function completes.
 */
export type DeferCallback = (args: DeferCallbackArgs) => Promise<void> | void;

/**
 * A handle returned by `group.defer()` that allows cancellation.
 */
export interface DeferHandle {
  /** Cancel this deferred group so it is not executed. */
  cancel: () => void;
}
