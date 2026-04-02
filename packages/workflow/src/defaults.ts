import fs from "node:fs/promises";
import type { OutgoingOp } from "inngest";
import type { WorkflowCallbacks } from "./types.js";

const DEFAULT_OUTPUT_PATH = "/tmp/output";

export const defaultOnStep: WorkflowCallbacks["onStep"] = async (
  steps: OutgoingOp[]
) => {
  await fs.writeFile(
    DEFAULT_OUTPUT_PATH,
    JSON.stringify({ type: "steps-found", steps }, null, 2)
  );
};

export const defaultOnComplete: WorkflowCallbacks["onComplete"] = async (
  data: unknown
) => {
  await fs.writeFile(
    DEFAULT_OUTPUT_PATH,
    JSON.stringify({ type: "function-resolved", data }, null, 2)
  );
};

export const defaultOnError: WorkflowCallbacks["onError"] = async (
  error: unknown,
  retriable: boolean | string
) => {
  await fs.writeFile(
    DEFAULT_OUTPUT_PATH,
    JSON.stringify({ type: "function-rejected", error, retriable }, null, 2)
  );
};
