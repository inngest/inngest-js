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
  SSEStepFrame,
  SSEStreamFrame,
} from "./components/execution/streaming.ts";

export {
  type RunStreamOptions,
  type SubscribeToRunOptions,
  streamRun,
  subscribeToRun,
} from "./stream.ts";
