import type {
  GatewayExecutorRequestData,
  SDKResponse,
} from "../../../../proto/src/components/connect/protobuf/connect.ts";
import type { Inngest } from "../../../Inngest.ts";
import type { ConnectHandlerOptions, ConnectionState } from "../../types.ts";

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
 * Configuration required by connection strategies.
 */
export interface StrategyConfig {
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
  inngestEnv: string | undefined;

  /**
   * Data for establishing the connection.
   */
  connectionData: ConnectionEstablishData;

  /**
   * Request handlers mapped by app ID.
   */
  requestHandlers: Record<string, RequestHandler>;

  /**
   * Connection options from the user.
   */
  options: ConnectHandlerOptions;

  /**
   * The Inngest client instance.
   */
  inngest: Inngest.Any;

  /**
   * The base URL for the Inngest API, as defined when constructing the Inngest
   * client (field or env var).
   */
  apiBaseUrl: string | undefined;

  mode: { isDev: boolean; isInferred: boolean };
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
}
