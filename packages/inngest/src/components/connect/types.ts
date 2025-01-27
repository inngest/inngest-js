import type { Inngest } from "inngest";
import { SDKResponse } from "inngest/proto/src/components/connect/protobuf/connect.js";
import { type RegisterOptions } from "../../types.js";
import { type InngestFunction } from "../InngestFunction.js";

export interface ConnectHandlerOptions extends RegisterOptions {
  /**
   * An array of the functions to serve and register with Inngest.
   */
  functions: readonly InngestFunction.Any[];

  instanceId: string;
  maxConcurrency?: number;
  abortSignal?: AbortSignal;
}

export interface WorkerConnection {
  connectionId: string;
  closed: Promise<void>;
  close: () => Promise<void>;
  state: ConnectionState;
}

export enum ConnectionState {
  CONNECTING = "CONNECTING",
  ACTIVE = "ACTIVE",
  PAUSED = "PAUSED",
  RECONNECTING = "RECONNECTING",
  CLOSED = "CLOSED",
}
