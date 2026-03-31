import type { WaitGroup } from "@jpwilliams/waitgroup";
import type { Mode } from "../../../../helpers/env.ts";
import type { Logger } from "../../../../middleware/logger.ts";
import type {
  GatewayExecutorRequestData,
  SDKResponse,
} from "../../../../proto/src/components/connect/protobuf/connect.ts";
import type { Inngest } from "../../../Inngest.ts";
import type {
  ConnectDebugState,
  ConnectHandlerOptions,
  ConnectionState,
  InFlightRequest,
} from "../../types.ts";
import type { Connection } from "./connection.ts";

/**
 * A request handler that processes executor requests and returns SDK responses.
 */
export type RequestHandler = (
  msg: GatewayExecutorRequestData,
) => Promise<SDKResponse>;

/**
 * Data needed to establish a connection with the gateway.
 */
export interface ConnectionEstablishData {
  marshaledCapabilities: string;
  manualReadinessAck: boolean;
  apps: {
    appName: string;
    appVersion?: string;
    functions: Uint8Array;
  }[];
}

/**
 * Base configuration shared across all connection config types.
 * Contains the core fields needed for authentication and connection establishment.
 */
export interface BaseConnectionConfig {
  /**
   * The hashed signing key for authentication.
   */
  hashedSigningKey: string | undefined;

  /**
   * The hashed fallback signing key for authentication.
   */
  hashedFallbackKey: string | undefined;

  /**
   * The Inngest environment name.
   */
  envName: string | undefined;

  /**
   * Data for establishing the connection.
   */
  connectionData: ConnectionEstablishData;

  /**
   * The base URL for the Inngest API, as defined when constructing the Inngest
   * client (field or env var).
   */
  apiBaseUrl: string | undefined;

  /**
   * The mode of the Inngest client.
   */
  mode: Mode;
}

/**
 * Configuration required by connection strategies.
 * Extends BaseConnectionConfig with strategy-specific fields.
 */
export interface StrategyConfig extends BaseConnectionConfig {
  /**
   * The logger to use for internal logging.
   */
  internalLogger: Logger;

  /**
   * Request handlers mapped by app ID.
   */
  requestHandlers: Record<string, RequestHandler>;

  /**
   * Connection options from the user.
   */
  options: ConnectHandlerOptions;
}

/**
 * Events emitted by connection strategies.
 */
export interface StrategyEvents {
  /**
   * Called when the connection state changes.
   */
  onStateChange: (state: ConnectionState) => void;

  /**
   * Called when a connection error occurs.
   */
  onError: (error: Error) => void;
}

/**
 * Interface for connection strategies.
 *
 * A connection strategy manages the WebSocket connection to the Inngest gateway,
 * including heartbeats, lease extension, and request/response handling.
 */
export interface ConnectionStrategy {
  /**
   * The current state of the connection.
   */
  readonly state: ConnectionState;

  /**
   * The current connection ID, if connected.
   */
  readonly connectionId: string | undefined;

  /**
   * Establish a connection to the gateway.
   *
   * @param attempt - The current connection attempt number for exponential backoff.
   */
  connect(attempt?: number): Promise<void>;

  /**
   * Close the connection gracefully.
   */
  close(): Promise<void>;

  /**
   * A promise that resolves when the connection is fully closed.
   */
  readonly closed: Promise<void>;

  /**
   * Return a snapshot of debug/health information for this connection.
   */
  getDebugState(): ConnectDebugState;
}

/**
 * Narrow view of ConnectionCore state, passed to sub-modules so they can
 * read (but not mutate) the connection state they need.
 */
export interface ConnectionAccessor {
  readonly activeConnection: Connection | undefined;
  readonly drainingConnection: Connection | undefined;
  readonly shutdownRequested: boolean;
  readonly inProgressRequests: {
    wg: WaitGroup;
    requestLeases: Record<string, string>;
    requestMeta: Record<string, InFlightRequest>;
  };
  readonly appIds: string[];
}

/**
 * Wake signal interface for sub-modules to wake the reconcile loop.
 */
export interface WakeSignal {
  wake(): void;
}
