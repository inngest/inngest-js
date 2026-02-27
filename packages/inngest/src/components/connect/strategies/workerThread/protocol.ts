import type { ConnectionState } from "../../types.ts";
import type { BaseConnectionConfig } from "../core/types.ts";

/**
 * Serializable configuration for the worker thread. This contains all the data
 * needed to establish and maintain a connection.
 */
export interface SerializableConfig extends BaseConnectionConfig {
  /**
   * Instance ID for the worker.
   */
  instanceId?: string;

  /**
   * Max worker concurrency.
   */
  maxWorkerConcurrency?: number;

  /**
   * Override the gateway WebSocket endpoint.
   */
  gatewayUrl?: string;

  /**
   * Signals to handle for graceful shutdown.
   */
  handleShutdownSignals?: string[];

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
