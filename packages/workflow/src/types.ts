import type { Context, EventPayload, OutgoingOp } from "inngest";

/**
 * The shape of the input file read by the workflow runner.
 */
export interface WorkflowInput {
  /** The triggering event. */
  event: EventPayload;
  /** Additional batch events. Defaults to [event] if omitted. */
  events?: EventPayload[];
  /** Completed step state: mapping of hashed step ID to memoized data. */
  state: Record<string, { id: string; data?: unknown; error?: unknown }>;
  /** Hashed step IDs in their completion order. */
  stack: string[];
  /** Unique run identifier. */
  runId: string;
  /** Retry attempt number (zero-indexed). */
  attempt: number;
  /** Target a specific planned step for execution. */
  plannedStep?: string;
}

/**
 * Options passed to {@link run}.
 */
export interface RunOptions {
  /** The workflow input containing event data and step state. */
  input: WorkflowInput;
  /** Restrict which step tools are available to the handler. */
  allowedStepTools?: string[];
  /**
   * Called with the resulting opcodes from execution. Every execution outcome
   * is normalized to `OutgoingOp[]`:
   *
   * - **Steps discovered** — ops with `StepPlanned`, `Sleep`, `WaitForEvent`,
   *   `InvokeFunction`, etc. The orchestrator should process these and call
   *   back with completed step state.
   *
   * - **Function resolved** — a single op with `RunComplete` and the return
   *   value in `data`. The workflow is finished.
   *
   * - **Retriable error** — a single op with `StepError` and the error in
   *   `error`. If the error was a `RetryAfterError`, `opts.retryAfter`
   *   contains the duration string (e.g. `"30s"`).
   *
   * - **Non-retriable error** — a single op with `StepFailed`. Do not retry.
   *
   * @example Handling results
   * ```typescript
   * await run(handler, {
   *   input,
   *   onResult: async (ops) => {
   *     for (const op of ops) {
   *       switch (op.op) {
   *         case "RunComplete":
   *           console.log("Done:", op.data);
   *           break;
   *         case "StepError":
   *           console.log("Retriable error:", op.error);
   *           break;
   *         case "StepFailed":
   *           console.log("Fatal error:", op.error);
   *           break;
   *         default:
   *           console.log("Step discovered:", op.op, op.displayName);
   *       }
   *     }
   *   },
   * });
   * ```
   */
  onResult?: (ops: OutgoingOp[]) => Promise<void> | void;
}

/**
 * The context object passed to a workflow handler.
 */
export interface WorkflowContext {
  /** Inngest step tools for durable execution. */
  step: Context.Any["step"];
  /** The triggering event data. */
  event: EventPayload;
  /** All events in the batch. */
  events: EventPayload[];
  /** Unique run identifier. */
  runId: string;
  /** Current zero-indexed retry attempt. */
  attempt: number;
}

/**
 * A workflow handler function.
 */
export type WorkflowHandler = (ctx: WorkflowContext) => Promise<unknown>;
