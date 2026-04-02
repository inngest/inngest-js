import fs from "node:fs/promises";
import { type EventPayload, Inngest, InngestFunction } from "inngest";
import { ServerTiming } from "inngest/internals";
import { StepMode } from "inngest/types";
import { defaultOnComplete, defaultOnError, defaultOnStep } from "./defaults.js";
import { createStepToolFilter } from "./filter.js";
import type {
  RunOptions,
  WorkflowConfig,
  WorkflowFunction,
  WorkflowInput,
} from "./types.js";

/**
 * Create a workflow function that can be executed locally via {@link run}.
 */
export function createWorkflow(config: WorkflowConfig): WorkflowFunction {
  const client = new Inngest({ id: "workflow" });

  const fn = client.createFunction(
    {
      id: "workflow",
      triggers: [{ event: "*" }],
    },
    config.handler
  );

  return { fn: fn as unknown as InngestFunction.Any, config };
}

/**
 * Execute a workflow by reading input from disk, running the Inngest execution
 * engine, and dispatching results to callbacks.
 *
 * When no callbacks are provided, results are written to `/tmp/output`.
 */
export async function run(
  workflow: WorkflowFunction,
  options?: RunOptions
): Promise<void> {
  const inputPath = options?.inputPath ?? "/tmp/input";
  const raw = await fs.readFile(inputPath, "utf-8");
  const input: WorkflowInput = JSON.parse(raw);

  const { fn } = workflow;
  const events = (input.events ?? [input.event]) as [
    EventPayload,
    ...EventPayload[],
  ];

  const allowedTools =
    input.allowedStepTools ?? workflow.config.allowedStepTools;
  const transformCtx = allowedTools
    ? createStepToolFilter(allowedTools)
    : undefined;

  const execution = (fn as InngestFunction.Any)["createExecution"]({
    partialOptions: {
      runId: input.runId,
      client: (fn as InngestFunction.Any)["client"],
      data: {
        runId: input.runId,
        attempt: input.attempt,
        event: input.event,
        events,
      },
      reqArgs: [],
      headers: {},
      stepCompletionOrder: input.stepCompletionOrder,
      stepState: input.stepState,
      stepMode: StepMode.Async,
      disableImmediateExecution: false,
      isFailureHandler: false,
      timer: new ServerTiming.ServerTiming({
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      }),
      requestedRunStep: input.requestedRunStep,
      transformCtx,
    },
  });

  const { ctx, ops, ...result } = await execution.start();

  const onStep = options?.onStep ?? defaultOnStep!;
  const onComplete = options?.onComplete ?? defaultOnComplete!;
  const onError = options?.onError ?? defaultOnError!;

  switch (result.type) {
    case "steps-found":
      await onStep(result.steps);
      break;
    case "step-ran":
      await onStep([result.step]);
      break;
    case "function-resolved":
      await onComplete(result.data);
      break;
    case "function-rejected":
      await onError(result.error, result.retriable);
      break;
    case "step-not-found":
      await onError(
        new Error(`Step not found: ${result.step.id}`),
        false
      );
      break;
  }
}
