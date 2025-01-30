import { type RegisterOptions } from "../../types.js";
import { type InngestFunction } from "../InngestFunction.js";

export const DEFAULT_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"];

export interface ConnectHandlerOptions extends RegisterOptions {
  /**
   * An array of the functions to serve and register with Inngest.
   */
  functions: readonly InngestFunction.Any[];

  /**
   * InstanceId represents a stable identifier to be used for identifying connected SDKs.
   * This can be a hostname or other identifier that remains stable across restarts.
   *
   * If nil, this defaults to the current machine's hostname.
   */
  instanceId?: string;

  maxConcurrency?: number;

  /**
   * By default, connections will be gracefully shut down when the current
   * process receives a SIGINT or SIGTERM signal. Set this to an empty array to disable this behavior.
   */
  handleShutdownSignals?: string[];

  rewriteGatewayEndpoint?: (endpoint: string) => string;
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
  CLOSING = "CLOSING",
  CLOSED = "CLOSED",
}
