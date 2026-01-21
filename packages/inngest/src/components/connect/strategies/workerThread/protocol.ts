import type { ConnectionState } from "../../types.ts";

/**
 * Serializable configuration for the worker thread.  This contains all the data
 * needed to establish and maintain a connection.
 */
export interface SerializableConfig {
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
  connectionData: {
    marshaledCapabilities: string;
    manualReadinessAck: boolean;
    apps: {
      appName: string;
      appVersion?: string;
      functions: Uint8Array;
    }[];
  };

  /**
   * Connection options.
   */
  options: {
    instanceId?: string;
    maxWorkerConcurrency?: number;
    handleShutdownSignals?: string[];
    rewriteGatewayEndpoint?: string; // Serialized as string, not function
  };

  /**
   * The base URL for the Inngest API.
   */
  inngestApiBaseUrl: string;

  /**
   * The app IDs that this worker supports.
   */
  appIds: string[];
}

/**
 * Messages sent from the main thread to the worker thread.
 */
export type MainToWorkerMessage =
  | { type: "INIT"; config: SerializableConfig }
  | { type: "CONNECT"; attempt: number }
  | { type: "CLOSE" }
  | { type: "EXECUTION_RESPONSE"; requestId: string; response: Uint8Array }
  | { type: "EXECUTION_ERROR"; requestId: string; error: string };

/**
 * Messages sent from the worker thread to the main thread.
 */
export type WorkerToMainMessage =
  | { type: "STATE_CHANGE"; state: ConnectionState }
  | { type: "CONNECTION_READY"; connectionId: string }
  | { type: "ERROR"; error: string; fatal: boolean }
  | { type: "EXECUTION_REQUEST"; requestId: string; request: Uint8Array }
  | { type: "CLOSED" }
  | {
      type: "LOG";
      level: "debug" | "info" | "warn" | "error";
      message: string;
      data?: unknown;
    };
