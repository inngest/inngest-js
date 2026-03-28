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
import type { Logger } from "../../../../middleware/logger.ts";
import {
  GatewayExecutorRequestData,
  SDKResponse,
} from "../../../../proto/src/components/connect/protobuf/connect.ts";
import { internalLoggerSymbol } from "../../../Inngest.ts";
import { type ConnectDebugState, ConnectionState } from "../../types.ts";
import { BaseStrategy } from "../core/BaseStrategy.ts";
import type { StrategyConfig } from "../core/types.ts";
import type {
  MainToWorkerMessage,
  SerializableConfig,
  WorkerToMainMessage,
} from "./protocol.ts";

const maxConsecutiveCrashes = 10;
const baseBackoffMs = 500;
const maxBackoffMs = 30_000;

/**
 * Worker thread connection strategy.
 *
 * This strategy runs the WebSocket connection, heartbeater, and lease extender
 * in a separate Node.js worker thread. This prevents blocked user code from
 * interfering with connection health.
 */
export class WorkerThreadStrategy extends BaseStrategy {
  private readonly config: StrategyConfig;
  private worker: Worker | undefined;
  private consecutiveCrashes = 0;
  private _connectionId: string | undefined;
  private _cachedDebugState: ConnectDebugState | undefined;

  constructor(config: StrategyConfig) {
    const primaryApp = config.options.apps[0];
    if (!primaryApp) {
      // Unreachable
      throw new Error("No apps");
    }

    super({ logger: primaryApp.client[internalLoggerSymbol] });
    this.config = config;
  }

  get connectionId(): string | undefined {
    return this._connectionId;
  }

  getDebugState(): ConnectDebugState {
    if (this._cachedDebugState) {
      return this._cachedDebugState;
    }

    return {
      state: this._state,
      activeConnectionId: this._connectionId,
      drainingConnectionId: undefined,
      lastHeartbeatSentAt: undefined,
      lastHeartbeatReceivedAt: undefined,
      lastMessageReceivedAt: undefined,
      shutdownRequested:
        this._state === ConnectionState.CLOSING ||
        this._state === ConnectionState.CLOSED,
      inFlightRequestCount: 0,
      inFlightRequests: [],
    };
  }

  async close(): Promise<void> {
    this.cleanupShutdown();
    this.setClosing();
    this.internalLogger.debug("Closing worker thread connection");

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
          this.internalLogger.debug("Worker close timeout, terminating");

          // Force terminate the worker to avoid hanging. Ideally this should
          // never happen, since the worker thread should've exited
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
    this.internalLogger.debug("Worker thread connection closed");
  }

  async connect(attempt = 0): Promise<void> {
    this.throwIfClosingOrClosed();
    this.internalLogger.debug({ attempt }, "Starting worker thread connection");

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

      const cleanup = () => {
        this.worker?.off("message", handleMessage);
        this.worker?.off("exit", handleExit);
      };

      const handleMessage = (msg: WorkerToMainMessage) => {
        if (msg.type === "CONNECTION_READY") {
          this._connectionId = msg.connectionId;
          cleanup();
          resolve();
        } else if (msg.type === "ERROR" && msg.fatal) {
          cleanup();
          reject(new Error(msg.error));
        }
      };

      const handleExit = (code: number) => {
        cleanup();
        reject(
          new Error(`Worker thread exited with code ${code} during connect`),
        );
      };

      this.worker.on("message", handleMessage);
      this.worker.on("exit", handleExit);

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

    this.internalLogger.debug({ runnerPath }, "Creating worker thread");

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
      this.internalLogger.debug({ err }, "Worker error");
      this._state = ConnectionState.RECONNECTING;
    });

    this.worker.on("exit", (code) => {
      this.internalLogger.debug({ code }, "Worker exited");
      if (
        this._state === ConnectionState.CLOSING ||
        this._state === ConnectionState.CLOSED
      ) {
        return;
      }

      // Assume the worker crashed due to an unhandled exception, because the
      // connection state isn't CLOSING or CLOSED. We'll try to respawn the
      // worker after a backoff.

      this.consecutiveCrashes++;
      this._state = ConnectionState.RECONNECTING;

      if (this.consecutiveCrashes > maxConsecutiveCrashes) {
        this.internalLogger.error(
          {
            consecutiveCrashes: this.consecutiveCrashes,
          },
          "Worker thread crashed consecutively, giving up",
        );
        return;
      }

      const backoff = Math.min(
        baseBackoffMs * 2 ** (this.consecutiveCrashes - 1),
        maxBackoffMs,
      );

      this.internalLogger.warn(
        {
          consecutiveCrashes: this.consecutiveCrashes,
          backoffMs: backoff,
        },
        "Respawning worker after backoff",
      );

      setTimeout(() => {
        if (
          this._state === ConnectionState.CLOSING ||
          this._state === ConnectionState.CLOSED
        ) {
          return;
        }

        this.createWorker()
          .then(async () => {
            const config = await this.buildSerializableConfig();
            this.sendToWorker({ type: "INIT", config });
            this.sendToWorker({ type: "CONNECT", attempt: 0 });
          })
          .catch((err) => {
            this.internalLogger.debug({ err }, "Failed to recreate worker");
          });
      }, backoff);
    });
  }

  private handleWorkerMessage(msg: WorkerToMainMessage): void {
    switch (msg.type) {
      case "STATE_CHANGE":
        this._state = msg.state;
        this.internalLogger.debug({ state: msg.state }, "State changed");
        break;

      case "CONNECTION_READY":
        this._connectionId = msg.connectionId;
        this.consecutiveCrashes = 0;
        this.internalLogger.debug(
          { connectionId: msg.connectionId },
          "Connection ready",
        );
        break;

      case "ERROR":
        if (msg.fatal) {
          this.internalLogger.error(
            { errorMessage: msg.error },
            "Fatal error from worker",
          );
        } else {
          this.internalLogger.error(
            { errorMessage: msg.error },
            "Worker error",
          );
        }
        break;

      case "EXECUTION_REQUEST":
        this.handleExecutionRequest(msg.requestId, msg.request);
        break;

      case "DEBUG_STATE":
        this._cachedDebugState = msg.state;
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
    data?: Record<string, unknown>,
  ): void {
    if (data) {
      this.internalLogger[level](data, message);
    } else {
      this.internalLogger[level](message);
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
        this.internalLogger.debug(
          { appName: gatewayExecutorRequest.appName },
          "No handler for app",
        );
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
      let error: Error | undefined;
      if (err instanceof Error) {
        error = err;
      } else {
        error = new Error(String(err));
      }
      this.internalLogger.debug({ err: error, requestId }, "Execution error");
      this.sendToWorker({
        type: "EXECUTION_ERROR",
        requestId,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  private sendToWorker(msg: MainToWorkerMessage): void {
    if (!this.worker) {
      this.internalLogger.error("Cannot send message, no worker");
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
      gatewayUrl: this.config.options.gatewayUrl,
      handleShutdownSignals: this.config.options.handleShutdownSignals,
      hashedFallbackKey: this.config.hashedFallbackKey,
      hashedSigningKey: this.config.hashedSigningKey,
      instanceId: this.config.options.instanceId,
      maxWorkerConcurrency: this.config.options.maxWorkerConcurrency,
      mode: this.config.mode,
    };
  }
}
