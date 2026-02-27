import type { RegisterOptions } from "../../types.ts";
import type { Inngest } from "../Inngest.ts";
import type { InngestFunction } from "../InngestFunction.ts";

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

  /**
   * MaxWorkerConcurrency represents the maximum number of worker concurrency to use.
   *
   * If left undefined, there will be no limit on the number of concurrent requests on the worker.
   */
  maxWorkerConcurrency?: number;

  /**
   * By default, connections will be gracefully shut down when the current
   * process receives a SIGINT or SIGTERM signal. Set this to an empty array to disable this behavior.
   */
  handleShutdownSignals?: string[];

  rewriteGatewayEndpoint?: (endpoint: string) => string;

  /**
   * Enable running the WebSocket connection, heartbeater, and lease extender
   * in a separate worker thread. This prevents thread-blocking user code from
   * interfering with connection health.
   *
   * Only works in Node.js environments that support worker_threads.
   *
   * Can also be enabled via the INNGEST_CONNECT_ISOLATE_EXECUTION environment variable.
   *
   * @default false
   */
  isolateExecution?: boolean;
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
