/**
 * Client-side utilities for interacting with Inngest Durable Endpoints.
 *
 * @example
 * ```ts
 * import { streamRun } from "inngest/experimental/durable-endpoints";
 *
 * await streamRun("/api/demo", {
 *   onData: (chunk) => console.log(chunk),
 * });
 * ```
 *
 * @module
 */
export type {
  RawSseEvent,
  SseFrame,
  SseMetadataFrame,
  SseRedirectFrame,
  SseResultFrame,
  SseStepCompletedFrame,
  SseStepErroredFrame,
  SseStepFrame,
  SseStepRunningFrame,
  SseStreamFrame,
  StepErrorData,
} from "../components/execution/streaming.ts";

export {
  type RunStreamOptions,
  type StepErrorInfo,
  type SubscribeToRunOptions,
  streamRun,
  subscribeToRun,
} from "../stream.ts";
