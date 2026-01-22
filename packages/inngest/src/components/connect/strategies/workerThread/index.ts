/**
 * Worker thread connection strategy.
 *
 * This strategy runs the WebSocket connection, heartbeater, and lease extender
 * in a separate worker thread. Userland code execution still happens in the
 * main thread.
 */

import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import debug, { type Debugger } from "debug";
import {
  GatewayExecutorRequestData,
  SDKResponse,
} from "../../../../proto/src/components/connect/protobuf/connect.ts";
import type { Inngest } from "../../../Inngest.ts";
import { ConnectionState } from "../../types.ts";
import { BaseStrategy } from "../core/BaseStrategy.ts";
import type { StrategyConfig } from "../core/types.ts";
import type {
  MainToWorkerMessage,
  SerializableConfig,
  WorkerToMainMessage,
} from "./protocol.ts";

/**
 * Worker thread connection strategy.
 *
 * This strategy runs the WebSocket connection, heartbeater, and lease extender
 * in a separate Node.js worker thread. This prevents blocked user code from
 * interfering with connection health.
 */
export class WorkerThreadStrategy extends BaseStrategy {
  private readonly config: StrategyConfig;
  protected readonly debugLog: Debugger;
  private worker: Worker | undefined;

  private _connectionId: string | undefined;

  constructor(config: StrategyConfig) {
    super();
    this.config = config;
    this.debugLog = debug("inngest:connect:worker-thread");
  }

  get connectionId(): string | undefined {
    return this._connectionId;
  }

  async close(): Promise<void> {
    this.cleanupShutdown();
    this.setClosing();
    this.debugLog("Closing worker thread connection");

    if (this.worker) {
      // Send close message to worker
      this.sendToWorker({ type: "CLOSE" });

      // Wait for worker to finish
      await new Promise<void>((resolve) => {
        if (!this.worker) {
          resolve();
          return;
        }

        const timeout = setTimeout(() => {
          this.debugLog("Worker close timeout, terminating");
          this.worker?.terminate();
          resolve();
        }, 30_000);

        this.worker.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      this.worker = undefined;
    }

    this.setClosed();
    this.debugLog("Worker thread connection closed");
  }

  async connect(attempt = 0): Promise<void> {
    this.throwIfClosingOrClosed();
    this.debugLog("Starting worker thread connection", { attempt });

    this.setupShutdownSignalIfConfigured(
      this.config.options.handleShutdownSignals,
    );

    // Create the worker thread
    await this.createWorker();

    // Initialize the worker with config
    const serializableConfig = await this.buildSerializableConfig();
    this.sendToWorker({ type: "INIT", config: serializableConfig });

    // Wait for connection to be ready
    await new Promise<void>((resolve, reject) => {
      if (!this.worker) {
        reject(new Error("Worker not created"));
        return;
      }

      const handleMessage = (msg: WorkerToMainMessage) => {
        if (msg.type === "CONNECTION_READY") {
          this._connectionId = msg.connectionId;
          resolve();
        } else if (msg.type === "ERROR" && msg.fatal) {
          reject(new Error(msg.error));
        }
      };

      this.worker.on("message", handleMessage);

      // Send connect command
      this.sendToWorker({ type: "CONNECT", attempt });
    });
  }

  private async createWorker(): Promise<void> {
    // Get the path to the runner file
    // Use the same extension as the current file (.ts in dev, .js in prod)
    const currentFilePath = fileURLToPath(import.meta.url);
    const ext = extname(currentFilePath);
    const runnerPath = join(dirname(currentFilePath), `runner${ext}`);

    this.debugLog("Creating worker thread", { runnerPath });

    // Create the worker with TypeScript support via tsx or ts-node
    // In production builds, this will be JavaScript
    this.worker = new Worker(runnerPath, {
      // Inherit environment variables
      env: process.env as NodeJS.ProcessEnv,
    });

    // Set up worker event handlers
    this.worker.on("message", (msg: WorkerToMainMessage) => {
      this.handleWorkerMessage(msg);
    });

    this.worker.on("error", (err) => {
      this.debugLog("Worker error", err.message);
      this._state = ConnectionState.RECONNECTING;
    });

    this.worker.on("exit", (code) => {
      this.debugLog("Worker exited", { code });
      if (
        this._state !== ConnectionState.CLOSING &&
        this._state !== ConnectionState.CLOSED
      ) {
        this._state = ConnectionState.RECONNECTING;
        // Attempt to recreate and reconnect
        this.createWorker()
          .then(async () => {
            const config = await this.buildSerializableConfig();
            this.sendToWorker({ type: "INIT", config });
            this.sendToWorker({ type: "CONNECT", attempt: 0 });
          })
          .catch((err) => {
            this.debugLog("Failed to recreate worker", err);
          });
      }
    });
  }

  private handleWorkerMessage(msg: WorkerToMainMessage): void {
    switch (msg.type) {
      case "STATE_CHANGE":
        this._state = msg.state;
        this.debugLog("State changed", { state: msg.state });
        break;

      case "CONNECTION_READY":
        this._connectionId = msg.connectionId;
        this.debugLog("Connection ready", { connectionId: msg.connectionId });
        break;

      case "ERROR":
        if (msg.fatal) {
          this.debugLog("Fatal error from worker", { error: msg.error });
        } else {
          console.error(`[inngest] ${msg.error}`);
        }
        break;

      case "EXECUTION_REQUEST":
        this.handleExecutionRequest(msg.requestId, msg.request);
        break;

      case "CLOSED":
        this._state = ConnectionState.CLOSED;
        this.resolveClosingPromise?.();
        break;

      case "LOG":
        this.handleWorkerLog(msg.level, msg.message, msg.data);
        break;
    }
  }

  private handleWorkerLog(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    data?: unknown,
  ): void {
    switch (level) {
      case "debug":
        this.debugLog(message, data);
        break;
      case "info":
        console.log(`[inngest] ${message}`, data ?? "");
        break;
      case "warn":
        console.warn(`[inngest] ${message}`, data ?? "");
        break;
      case "error":
        console.error(`[inngest] ${message}`, data ?? "");
        break;
    }
  }

  private async handleExecutionRequest(
    requestId: string,
    requestBytes: Uint8Array,
  ): Promise<void> {
    try {
      // Decode the request
      const gatewayExecutorRequest =
        GatewayExecutorRequestData.decode(requestBytes);

      // Find the request handler
      const requestHandler =
        this.config.requestHandlers[gatewayExecutorRequest.appName];

      if (!requestHandler) {
        this.debugLog("No handler for app", {
          appName: gatewayExecutorRequest.appName,
        });
        this.sendToWorker({
          type: "EXECUTION_ERROR",
          requestId,
          error: `No handler for app: ${gatewayExecutorRequest.appName}`,
        });
        return;
      }

      // Execute the handler in the main thread
      const response = await requestHandler(gatewayExecutorRequest);

      // Encode and send response back to worker
      const responseBytes = SDKResponse.encode(response).finish();
      this.sendToWorker({
        type: "EXECUTION_RESPONSE",
        requestId,
        response: responseBytes,
      });
    } catch (err) {
      this.debugLog("Execution error", {
        requestId,
        error: err instanceof Error ? err.message : err,
      });
      this.sendToWorker({
        type: "EXECUTION_ERROR",
        requestId,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  private sendToWorker(msg: MainToWorkerMessage): void {
    if (!this.worker) {
      this.debugLog("Cannot send message, no worker");
      return;
    }
    this.worker.postMessage(msg);
  }

  private async buildSerializableConfig(): Promise<SerializableConfig> {
    return {
      apiBaseUrl: this.config.apiBaseUrl,
      appIds: Object.keys(this.config.requestHandlers),
      connectionData: this.config.connectionData,
      envName: this.config.envName,
      handleShutdownSignals: this.config.options.handleShutdownSignals,
      hashedFallbackKey: this.config.hashedFallbackKey,
      hashedSigningKey: this.config.hashedSigningKey,
      instanceId: this.config.options.instanceId,
      maxWorkerConcurrency: this.config.options.maxWorkerConcurrency,
      mode: this.config.mode,
    };
  }
}
