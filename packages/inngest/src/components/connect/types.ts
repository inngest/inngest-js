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

  /**
   * Override the gateway WebSocket endpoint. When set, this URL is used
   * instead of the endpoint returned by the Inngest API.
   *
   * Useful when there is a proxy between the worker and the gateway
   * that requires a different hostname (e.g. `ws://localhost:8100`).
   *
   * Can also be set via the `INNGEST_CONNECT_GATEWAY_URL` environment variable.
   * This option takes precedence over the env var.
   */
  gatewayUrl?: string;

  /**
   * Enable running the WebSocket connection, heartbeater, and lease extender
   * in a separate worker thread. This prevents thread-blocking user code from
   * interfering with connection health.
   *
   * Only works in environments that support worker_threads.
   *
   * Can also be disabled via the INNGEST_CONNECT_ISOLATE_EXECUTION=false environment variable.
   *
   * @default true
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
