/**
 * Client-side utilities for interacting with Inngest Durable Endpoints.
 *
 * @example
 * ```ts
 * import { streamRun } from "inngest/durable-endpoints";
 *
 * await streamRun("/api/demo", {
 *   onData: (chunk) => console.log(chunk),
 * });
 * ```
 *
 * @module
 */
export type {
  RawSSEEvent,
  SSEFrame,
  SSEMetadataFrame,
  SSERedirectFrame,
  SSEResultFrame,
  SSEStepCompletedFrame,
  SSEStepErroredFrame,
  SSEStepFrame,
  SSEStepRunningFrame,
  SSEStreamFrame,
  StepErrorData,
} from "./components/execution/streaming.ts";

export {
  type RunStreamOptions,
  type StepErrorInfo,
  type SubscribeToRunOptions,
  streamRun,
  subscribeToRun,
} from "./stream.ts";
