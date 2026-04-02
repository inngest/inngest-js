import type { Context, EventPayload, InngestFunction, OutgoingOp } from "inngest";

/**
 * The shape of the input file read by the workflow runner.
 */
export interface WorkflowInput {
  /** The triggering event. */
  event: EventPayload;
  /** Additional batch events. Defaults to [event] if omitted. */
  events?: EventPayload[];
  /** Pre-computed step state: mapping of hashed step ID to memoized data. */
  stepState: Record<string, { id: string; data?: unknown; error?: unknown }>;
  /** Hashed step IDs in their completion order. */
  stepCompletionOrder: string[];
  /** Unique run identifier. */
  runId: string;
  /** Retry attempt number (zero-indexed). */
  attempt: number;
  /** Target a specific step for execution. */
  requestedRunStep?: string;
  /** Override allowed step tools at runtime. */
  allowedStepTools?: string[];
}

/**
 * Callbacks invoked by the runner after execution completes.
 */
export interface WorkflowCallbacks {
  /** Called when steps are discovered or a step has been executed. */
  onStep?: (steps: OutgoingOp[]) => Promise<void> | void;
  /** Called when the workflow function resolves successfully. */
  onComplete?: (data: unknown) => Promise<void> | void;
  /** Called when the workflow function rejects. */
  onError?: (
    error: unknown,
    retriable: boolean | string
  ) => Promise<void> | void;
}

/**
 * Options passed to {@link run}.
 */
export interface RunOptions extends WorkflowCallbacks {
  /** Path to read input from. Defaults to "/tmp/input". */
  inputPath?: string;
}

/**
 * Configuration for creating a workflow.
 */
export interface WorkflowConfig {
  /** The workflow handler, receiving step tools and event data. */
  handler: (ctx: {
    step: Context.Any["step"];
    event: EventPayload;
    events: EventPayload[];
    runId: string;
    attempt: number;
  }) => Promise<unknown>;
  /** Restrict which step tools are available to the handler. */
  allowedStepTools?: string[];
}

/**
 * A workflow ready to be executed via {@link run}.
 */
export interface WorkflowFunction {
  fn: InngestFunction.Any;
  config: WorkflowConfig;
}
