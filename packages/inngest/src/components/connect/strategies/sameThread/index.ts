import { SDKResponse } from "../../../../proto/src/components/connect/protobuf/connect.ts";
import { MessageBuffer } from "../../buffer.ts";
import { BaseStrategy } from "../core/BaseStrategy.ts";
import { ConnectionCore } from "../core/connection.ts";
import type { StrategyConfig } from "../core/types.ts";

const ResponseAcknowledgeDeadline = 5_000;

/**
 * Same-thread connection strategy.
 *
 * This strategy runs the WebSocket connection, heartbeater, and lease extender
 * in the same thread as user code execution. This is the default strategy.
 */
export class SameThreadStrategy extends BaseStrategy {
  private readonly config: StrategyConfig;
  private readonly messageBuffer: MessageBuffer;
  private readonly core: ConnectionCore;

  constructor(config: StrategyConfig) {
    super();
    this.config = config;

    // Create the connection core with callbacks
    this.core = new ConnectionCore(
      {
        apiBaseUrl: config.apiBaseUrl,
        appIds: Object.keys(config.requestHandlers),
        connectionData: config.connectionData,
        envName: config.envName,
        hashedFallbackKey: config.hashedFallbackKey,
        hashedSigningKey: config.hashedSigningKey,
        instanceId: config.options.instanceId,
        maxWorkerConcurrency: config.options.maxWorkerConcurrency,
        mode: config.mode,
        rewriteGatewayEndpoint: config.options.rewriteGatewayEndpoint,
      },
      {
        log: (message, data) => this.debugLog(message, data),
        onStateChange: (state) => {
          this._state = state;
        },
        getState: () => this._state,
        handleExecutionRequest: async (request) => {
          const handler = this.config.requestHandlers[request.appName];
          if (!handler) {
            throw new Error(`No handler for app: ${request.appName}`);
          }
          const response = await handler(request);
          const responseBytes = SDKResponse.encode(response).finish();

          // Add to pending with deadline
          this.messageBuffer.addPending(
            request.requestId,
            responseBytes,
            ResponseAcknowledgeDeadline,
          );

          return responseBytes;
        },
        onReplyAck: (requestId) => {
          this.messageBuffer.acknowledgePending(requestId);
        },
        onBufferResponse: (requestId, responseBytes) => {
          this.messageBuffer.append(requestId, responseBytes);
        },
        beforeConnect: async (signingKey) => {
          await this.messageBuffer.flush(signingKey);
        },
      },
    );

    this.messageBuffer = new MessageBuffer({
      envName: config.envName,
      getApiBaseUrl: () => this.core.getApiBaseUrl(),
    });
  }

  get connectionId(): string | undefined {
    return this.core.connectionId;
  }

  async close(): Promise<void> {
    this.cleanupShutdown();
    this.setClosing();
    this.debugLog("Cleaning up connection resources");

    await this.core.cleanup();

    this.debugLog("Connection closed");
    this.debugLog("Waiting for in-flight requests to complete");

    await this.core.waitForInProgress();

    this.debugLog("Flushing messages before closing");

    try {
      await this.messageBuffer.flush(this.config.hashedSigningKey);
    } catch (err) {
      this.debugLog("Failed to flush messages, using fallback key", err);
      await this.messageBuffer.flush(this.config.hashedFallbackKey);
    }

    this.setClosed();
    this.debugLog("Fully closed");
  }

  async connect(attempt = 0): Promise<void> {
    this.throwIfClosingOrClosed();
    this.setupShutdownSignalIfConfigured(
      this.config.options.handleShutdownSignals,
    );

    // Flush any pending messages before connecting
    try {
      await this.messageBuffer.flush(this.config.hashedSigningKey);
    } catch (err) {
      this.debugLog("Failed to flush messages, using fallback key", err);
      await this.messageBuffer.flush(this.config.hashedFallbackKey);
    }

    await this.core.connect(attempt);
  }
}
