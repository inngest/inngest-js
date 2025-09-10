import { type RegisterOptions } from "../../types.js";
import { type Inngest } from "../Inngest.js";
import { type InngestFunction } from "../InngestFunction.js";

export const DEFAULT_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"];

export interface ConnectApp {
  client: Inngest.Like;
  functions?: Array<InngestFunction.Like>;
}

export interface ConnectHandlerOptions extends RegisterOptions {
  apps: ConnectApp[];

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
  /**
   * Initial state when establishing connection to Inngest gateway.
   * WebSocket may be connecting, authenticating, or waiting for gateway ready signal.
   */
  CONNECTING = "CONNECTING",
  
  /**
   * Connection is established and ready to receive and execute function requests.
   * This is the normal operational state.
   */
  ACTIVE = "ACTIVE",
  
  /**
   * Connection is temporarily paused (not currently used in connect implementation).
   * Reserved for future use.
   */
  PAUSED = "PAUSED",
  
  /**
   * Connection was lost or failed - attempting to reconnect with exponential backoff.
   * No function requests will be processed until connection is restored.
   */
  RECONNECTING = "RECONNECTING",
  
  /**
   * Internal state during gateway-initiated draining process.
   * Externally reports as ACTIVE to maintain seamless operation while establishing new connection.
   * Gateway requested connection drain - establishing new connection while keeping current one active.
   */
  DRAINING_RECONNECTING = "DRAINING_RECONNECTING",
  
  /**
   * User requested graceful shutdown - cleaning up resources and closing connection.
   * No reconnection attempts will be made.
   */
  CLOSING = "CLOSING",
  
  /**
   * Connection fully closed and all resources cleaned up.
   * Terminal state - connection object should be discarded.
   */
  CLOSED = "CLOSED",
}
