import { type RegisterOptions } from "../../types.js";
import { type InngestFunction } from "../InngestFunction.js";

export interface ConnectHandlerOptions extends RegisterOptions {
  /**
   * An array of the functions to serve and register with Inngest.
   */
  functions: readonly InngestFunction.Any[];

  instanceId: string;
  maxConcurrency?: number;

  /**
   * By default, connections will be gracefully shut down when the current
   * process is terminated. Set this to true to disable this behavior.
   */
  disableShutdownSignalHandling?: boolean;
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
