/**
 * Worker thread runner for Inngest Connect.
 *
 * This file runs in a separate worker thread and manages:
 * - WebSocket connection to the Inngest gateway
 * - Heartbeater
 * - Lease extender
 *
 * Userland code execution still happens in the main thread.
 */

import { isMainThread, parentPort } from "node:worker_threads";
import { ConnectionState } from "../../types.ts";
import { ConnectionCore } from "../core/connection.ts";
import type {
  MainToWorkerMessage,
  SerializableConfig,
  WorkerToMainMessage,
} from "./protocol.ts";

if (isMainThread) {
  throw new Error("This file should only be run in a worker thread");
}

if (!parentPort) {
  throw new Error("No parent port available");
}

/**
 * Worker thread runner state.
 */
class WorkerRunner {
  private config: SerializableConfig | undefined;
  private state: ConnectionState = ConnectionState.CONNECTING;
  private core: ConnectionCore | undefined;

  /**
   * Pending execution responses waiting for user code to complete.
   */
  private pendingExecutions: Map<
    string,
    {
      resolve: (response: Uint8Array) => void;
      reject: (error: Error) => void;
    }
  > = new Map();

  private sendMessage(msg: WorkerToMainMessage) {
    parentPort?.postMessage(msg);
  }

  private log(message: string, data?: unknown) {
    this.sendMessage({ type: "LOG", level: "debug", message, data });
  }

  private setState(state: ConnectionState) {
    this.state = state;
    this.sendMessage({ type: "STATE_CHANGE", state });
  }

  handleMessage(msg: MainToWorkerMessage) {
    switch (msg.type) {
      case "INIT":
        this.config = msg.config;
        this.initializeCore();
        this.log("Worker initialized with config");
        break;

      case "CONNECT":
        if (!this.core) {
          this.sendMessage({
            type: "ERROR",
            error: "Worker not initialized",
            fatal: true,
          });
          return;
        }
        this.core.connect(msg.attempt).catch((err) => {
          this.sendMessage({
            type: "ERROR",
            error: err instanceof Error ? err.message : "Unknown error",
            fatal: true,
          });
        });
        break;

      case "CLOSE":
        this.close().catch((err) => {
          this.log(
            "Error during close",
            err instanceof Error ? err.message : err,
          );
        });
        break;

      case "EXECUTION_RESPONSE": {
        const pending = this.pendingExecutions.get(msg.requestId);
        if (pending) {
          pending.resolve(msg.response);
          this.pendingExecutions.delete(msg.requestId);
        }
        break;
      }

      case "EXECUTION_ERROR": {
        const pending = this.pendingExecutions.get(msg.requestId);
        if (pending) {
          pending.reject(new Error(msg.error));
          this.pendingExecutions.delete(msg.requestId);
        }
        break;
      }
    }
  }

  private initializeCore() {
    if (!this.config) {
      throw new Error("Config not set");
    }

    this.core = new ConnectionCore(
      {
        hashedSigningKey: this.config.hashedSigningKey,
        hashedFallbackKey: this.config.hashedFallbackKey,
        envName: this.config.envName,
        connectionData: this.config.connectionData,
        instanceId: this.config.options.instanceId,
        maxWorkerConcurrency: this.config.options.maxWorkerConcurrency,
        // rewriteGatewayEndpoint is not supported in worker thread (can't serialize functions)
        rewriteGatewayEndpoint: undefined,
        // getTargetUrl: async (path) =>
        //   new URL(path, this.config!.inngestApiBaseUrl),
        apiBaseUrl: this.config.apiBaseUrl,
        appIds: this.config.appIds,
        mode: {
          isDev: this.config.mode.isDev,
          isInferred: this.config.mode.isInferred,
        },
      },
      {
        log: (message, data) => this.log(message, data),
        onStateChange: (state) => {
          this.setState(state);
          if (state === ConnectionState.ACTIVE && this.core?.connectionId) {
            this.sendMessage({
              type: "CONNECTION_READY",
              connectionId: this.core.connectionId,
            });
          }
        },
        getState: () => this.state,
        handleExecutionRequest: async (request) => {
          // Send execution request to main thread and wait for response
          const requestPromise = new Promise<Uint8Array>((resolve, reject) => {
            this.pendingExecutions.set(request.requestId, { resolve, reject });
          });

          // Send the request to main thread (as serialized bytes)
          const { GatewayExecutorRequestData } = await import(
            "../../../../proto/src/components/connect/protobuf/connect.ts"
          );
          this.sendMessage({
            type: "EXECUTION_REQUEST",
            requestId: request.requestId,
            request: GatewayExecutorRequestData.encode(request).finish(),
          });

          // Wait for main thread to complete execution
          return requestPromise;
        },
        // No reply ack handling needed in worker - main thread handles buffering
        onReplyAck: undefined,
        // No buffering in worker thread
        onBufferResponse: undefined,
      },
    );
  }

  async close(): Promise<void> {
    this.setState(ConnectionState.CLOSING);
    this.log("Cleaning up connection resources");

    if (this.core) {
      await this.core.cleanup();
    }

    this.log("Connection closed");
    this.log("Waiting for in-flight requests to complete");

    if (this.core) {
      await this.core.waitForInProgress();
    }

    this.setState(ConnectionState.CLOSED);

    this.sendMessage({ type: "CLOSED" });
    this.log("Fully closed");
  }
}

// Initialize the worker runner
const runner = new WorkerRunner();

// Listen for messages from the main thread
parentPort.on("message", (msg: MainToWorkerMessage) => {
  runner.handleMessage(msg);
});
