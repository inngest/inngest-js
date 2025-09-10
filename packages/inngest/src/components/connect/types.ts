import { type RegisterOptions } from "../../types.js";
import { type Inngest } from "../Inngest.js";
import { type InngestFunction } from "../InngestFunction.js";
import { type Logger } from "../../middleware/logger.js";
import { type ConnectionEvent } from "./state-machine.js";

export const DEFAULT_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"];

/**
 * Connection events that can be observed by users
 */
export interface ConnectionEvents {
  /**
   * State transition event
   */
  stateChange: {
    from: ConnectionState;
    to: ConnectionState;
    event: ConnectionEvent;
    timestamp: number;
    connectionId: string;
  };

  /**
   * Connection established successfully
   */
  connected: {
    connectionId: string;
    timestamp: number;
  };

  /**
   * Connection lost or failed
   */
  disconnected: {
    connectionId: string;
    reason: string;
    timestamp: number;
  };

  /**
   * Gateway requested connection draining
   */
  draining: {
    connectionId: string;
    timestamp: number;
  };

  /**
   * Reconnection attempt started
   */
  reconnecting: {
    connectionId: string;
    attempt: number;
    nextRetryMs: number;
    timestamp: number;
  };

  /**
   * Function request received from gateway
   */
  requestReceived: {
    connectionId: string;
    requestId: string;
    appName: string;
    functionSlug: string;
    timestamp: number;
  };

  /**
   * Function request completed
   */
  requestCompleted: {
    connectionId: string;
    requestId: string;
    status: number;
    durationMs: number;
    timestamp: number;
  };

  /**
   * WebSocket-level events
   */
  websocketOpen: {
    connectionId: string;
    timestamp: number;
  };

  websocketClose: {
    connectionId: string;
    code: number;
    reason: string;
    timestamp: number;
  };

  websocketError: {
    connectionId: string;
    error: unknown;
    timestamp: number;
  };
}

/**
 * Event listener function type
 */
export type ConnectEventListener<T extends keyof ConnectionEvents> = (
  event: ConnectionEvents[T]
) => void;

/**
 * Event hooks configuration
 */
export interface ConnectEventHooks {
  stateChange?: ConnectEventListener<"stateChange">;
  connected?: ConnectEventListener<"connected">;
  disconnected?: ConnectEventListener<"disconnected">;
  draining?: ConnectEventListener<"draining">;
  reconnecting?: ConnectEventListener<"reconnecting">;
  requestReceived?: ConnectEventListener<"requestReceived">;
  requestCompleted?: ConnectEventListener<"requestCompleted">;
  websocketOpen?: ConnectEventListener<"websocketOpen">;
  websocketClose?: ConnectEventListener<"websocketClose">;
  websocketError?: ConnectEventListener<"websocketError">;
}

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

  /**
   * Custom logger to use for connect-related logging.
   * If not provided, uses debug package for internal logging.
   */
  logger?: Logger;

  /**
   * Event hooks to listen for connection state changes and events.
   * These provide observability into the connection lifecycle.
   */
  eventHooks?: ConnectEventHooks;

  /**
   * Enable detailed debug logging (uses debug package).
   * Defaults to false.
   */
  debug?: boolean;
}

export interface WorkerConnection {
  connectionId: string;
  closed: Promise<void>;
  close: () => Promise<void>;
  state: ConnectionState;

  /**
   * Add an event listener for connection events.
   * Returns a function to remove the listener.
   */
  addEventListener<T extends keyof ConnectionEvents>(
    event: T,
    listener: ConnectEventListener<T>
  ): () => void;

  /**
   * Remove an event listener for connection events.
   */
  removeEventListener<T extends keyof ConnectionEvents>(
    event: T,
    listener: ConnectEventListener<T>
  ): void;

  /**
   * Get the current state history for debugging purposes.
   */
  getStateHistory(): ReadonlyArray<{
    state: ConnectionState;
    event: ConnectionEvent;
    timestamp: number;
  }>;
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
