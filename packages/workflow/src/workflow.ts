import fs from "node:fs/promises";
import { type EventPayload, type OutgoingOp, Inngest, InngestFunction } from "inngest";
import { ServerTiming } from "inngest/internals";
import { StepMode, StepOpCode } from "inngest/types";
import { createStepToolFilter } from "./filter.js";
import type {
  RunOptions,
  WorkflowHandler,
  WorkflowInput,
} from "./types.js";

const DEFAULT_INPUT_PATH = "/tmp/input";
const DEFAULT_OUTPUT_PATH = "/tmp/output";

/**
 * Read and parse a {@link WorkflowInput} from a JSON file.
 */
export async function readInput(
  filePath: string = DEFAULT_INPUT_PATH
): Promise<WorkflowInput> {
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw) as WorkflowInput;
}

/**
 * Write a result object as JSON to a file.
 */
export async function writeOutput(
  data: unknown,
  filePath: string = DEFAULT_OUTPUT_PATH
): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

/**
 * Execute a workflow handler and dispatch resulting opcodes to the
 * {@link RunOptions.onResult} callback.
 */
export async function run(
  handler: WorkflowHandler,
  options: RunOptions
): Promise<void> {
  const { input } = options;

  const client = new Inngest({ id: "workflow" });

  const fn = client.createFunction(
    { id: "workflow", triggers: [{ event: "*" }] },
    handler
  ) as unknown as InngestFunction.Any;

  const events = (input.events ?? [input.event]) as [
    EventPayload,
    ...EventPayload[,
  ];

  const allowedTools = options.allowedStepTools;
  const transformCtx = allowedTools
    ? createStepToolFilter(allowedTools)
    : undefined;

  const execution = fn["createExecution"]({
    partialOptions: {
      runId: input.runId,
      client: fn["client"],
      data: {
        runId: input.runId,
        attempt: input.attempt,
        event: input.event,
        events,
      },
      reqArgs: [],
      headers: {},
      stepCompletionOrder: input.stack,
      stepState: input.state,
      stepMode: StepMode.Async,
      disableImmediateExecution: false,
      isFailureHandler: false,
      timer: new ServerTiming.ServerTiming({
        info: () => { },
        warn: () => { },
        error: () => { },
        debug: () => { },
      }),
      requestedRunStep: input.plannedStep,
      transformCtx,
    },
  });

  const { ctx, ops, ...result } = await execution.start();

  let resultOps: OutgoingOp[];

  switch (result.type) {
    case "steps-found":
      resultOps = result.steps;
      break;
    case "step-ran":
      resultOps = [result.step];
      break;
    case "function-resolved":
      resultOps = [{
        id: "complete",
        op: StepOpCode.RunComplete,
        data: result.data,
      }];
      break;
    case "function-rejected": {
      const op = result.retriable === false
        ? StepOpCode.StepFailed
        : StepOpCode.StepError;
      resultOps = [{
        id: "error",
        op,
        error: result.error,
        ...(typeof result.retriable === "string"
          ? { opts: { retryAfter: result.retriable } }
          : {}),
      }];
      break;
    }
    case "step-not-found":
      resultOps = [{
        id: "error",
        op: StepOpCode.StepFailed,
        error: { message: `Step not found: ${result.step.id}` },
      }];
      break;
    default:
      resultOps = [];
      break;
  }

  await options.onResult?.(resultOps);
}
