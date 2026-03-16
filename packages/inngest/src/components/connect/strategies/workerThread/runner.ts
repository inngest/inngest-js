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
import type { Logger } from "../../../../middleware/logger.ts";
import { GatewayExecutorRequestData } from "../../../../proto/src/components/connect/protobuf/connect.ts";
import { MessageBuffer } from "../../buffer.ts";
import { ConnectionState } from "../../types.ts";
import { ConnectionCore } from "../core/connection.ts";
import type {
  MainToWorkerMessage,
  SerializableConfig,
  WorkerToMainMessage,
} from "./protocol.ts";

/**
 * Time in milliseconds to wait for gateway acknowledgment of a response.
 * If no ACK is received within this deadline, the response is moved to the
 * buffer for later flush via HTTP.
 */
const responseAcknowledgeDeadline = 5_000;

if (isMainThread) {
  throw new Error("This file should only be run in a worker thread");
}

if (!parentPort) {
  throw new Error("No parent port available");
}

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(String(value));
}

/**
 * Parse pino-style (object, string) or plain (string) log args into a
 * structured { message, data } pair for sending over postMessage.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function parsePinoArgs(args: unknown[]): {
  message: string;
  data?: Record<string, unknown>;
} {
  // Pino-style: (object, string)
  if (args.length >= 2 && isRecord(args[0]) && typeof args[1] === "string") {
    return { data: args[0], message: args[1] };
  }

  return { message: String(args[0]) };
}

/**
 * Worker thread runner state.
 */
class WorkerRunner {
  private config: SerializableConfig | undefined;
  private state: ConnectionState = ConnectionState.CONNECTING;
  private core: ConnectionCore | undefined;
  private messageBuffer: MessageBuffer | undefined;
  private readonly logger: Logger;

  constructor() {
    this.logger = this.createMessageLogger();
  }

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

  private createMessageLogger(): Logger {
    const sendLog = (
      level: "debug" | "info" | "warn" | "error",
      ...args: unknown[]
    ) => {
      const { message, data } = parsePinoArgs(args);
      this.sendMessage({ type: "LOG", level, message, data });
    };

    return {
      debug: (...args) => sendLog("debug", ...args),
      info: (...args) => sendLog("info", ...args),
      warn: (...args) => sendLog("warn", ...args),
      error: (...args) => sendLog("error", ...args),
    };
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
        this.logger.debug("Worker initialized with config");
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
          this.logger.error({ err: toError(err) }, "Error during close");
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
        ...this.config,
        gatewayUrl: this.config.gatewayUrl,
      },
      {
        logger: this.logger,
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
          this.sendMessage({
            type: "EXECUTION_REQUEST",
            requestId: request.requestId,
            request: GatewayExecutorRequestData.encode(request).finish(),
          });

          // Wait for main thread to complete execution
          const responseBytes = await requestPromise;

          // Add to pending with deadline for acknowledgment tracking
          this.messageBuffer?.addPending(
            request.requestId,
            responseBytes,
            responseAcknowledgeDeadline,
          );

          return responseBytes;
        },
        onReplyAck: (requestId) => {
          this.messageBuffer?.acknowledgePending(requestId);
        },
        onBufferResponse: (requestId, responseBytes) => {
          this.messageBuffer?.append(requestId, responseBytes);
        },
        beforeConnect: async (signingKey) => {
          await this.messageBuffer?.flush(signingKey);
        },
      },
    );

    // Create message buffer for buffering responses when connection is lost
    this.messageBuffer = new MessageBuffer({
      envName: this.config.envName,
      getApiBaseUrl: () => this.core!.getApiBaseUrl(),
      logger: this.logger,
    });
  }

  async close(): Promise<void> {
    this.setState(ConnectionState.CLOSING);
    this.logger.debug("Cleaning up connection resources");

    if (this.core) {
      await this.core.cleanup();
    }

    this.logger.debug("Connection closed");
    this.logger.debug("Waiting for in-flight requests to complete");

    if (this.core) {
      await this.core.waitForInProgress();
    }

    this.logger.debug("Flushing messages before closing");

    if (this.messageBuffer) {
      try {
        await this.messageBuffer.flush(this.config?.hashedSigningKey);
      } catch (err) {
        this.logger.debug(
          { err: toError(err) },
          "Failed to flush messages, using fallback key",
        );
        await this.messageBuffer.flush(this.config?.hashedFallbackKey);
      }
    }

    this.setState(ConnectionState.CLOSED);

    this.sendMessage({ type: "CLOSED" });
    this.logger.debug("Fully closed");

    // Exit the worker thread. Without this, the parentPort message listener
    // keeps the event loop alive and the worker never exits.
    process.exit(0);
  }
}

// Initialize the worker runner
const runner = new WorkerRunner();

// Listen for messages from the main thread
parentPort.on("message", (msg: MainToWorkerMessage) => {
  runner.handleMessage(msg);
});
