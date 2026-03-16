/**
 * Client-side utilities for interacting with Inngest Durable Endpoints.
 *
 * @example
 * ```ts
 * import { RunStream } from "inngest/durable-endpoints";
 *
 * const stream = new RunStream({ url: "/api/demo" });
 * stream.onData((chunk) => console.log(chunk));
 * await stream.start();
 * ```
 *
 * @module
 */
export {
  RunStream,
  subscribeToRun,
  type RunStreamOptions,
  type SubscribeToRunOptions,
} from "./stream.ts";

export type {
  SSEFrame,
  SSEMetadataFrame,
  SSEStreamFrame,
  SSEResultFrame,
  SSEStepFrame,
  SSERedirectFrame,
  RawSSEEvent,
} from "./components/execution/streaming.ts";
