import { envKeys } from "../../helpers/consts.ts";
import { allProcessEnv } from "../../helpers/env.ts";
import { type Inngest, internalLoggerSymbol } from "../Inngest.ts";
import { prepareConnectionConfig } from "./config.ts";
import { type ConnectionStrategy, createStrategy } from "./strategies/index.ts";
import {
  type ConnectApp,
  type ConnectDebugState,
  type ConnectHandlerOptions,
  ConnectionState,
  DEFAULT_SHUTDOWN_SIGNALS,
  type InFlightRequest,
  type WorkerConnection,
} from "./types.ts";

/**
 * WebSocket worker connection that implements the WorkerConnection interface.
 *
 * This class acts as a facade that delegates to a connection strategy.
 * The strategy determines how the WebSocket connection, heartbeater, and
 * lease extender are managed (same thread vs worker thread).
 */
class WebSocketWorkerConnection implements WorkerConnection {
  private inngest: Inngest.Any;
  private options: ConnectHandlerOptions;
  private strategy: ConnectionStrategy | undefined;

  constructor(options: ConnectHandlerOptions) {
    if (
      !Array.isArray(options.apps) ||
      options.apps.length === 0 ||
      !options.apps[0]
    ) {
      throw new Error("No apps provided");
    }

    this.inngest = options.apps[0].client as Inngest.Any;
    for (const app of options.apps) {
      const client = app.client as Inngest.Any;

      if (client.env !== this.inngest.env) {
        throw new Error(
          `All apps must be configured to the same environment. ${client.id} is configured to ${client.env} but ${this.inngest.id} is configured to ${this.inngest.env}`,
        );
      }
    }

    this.options = this.applyDefaults(options);
  }

  private applyDefaults(opts: ConnectHandlerOptions): ConnectHandlerOptions {
    const options = { ...opts };
    if (!Array.isArray(options.handleShutdownSignals)) {
      options.handleShutdownSignals = DEFAULT_SHUTDOWN_SIGNALS;
    }

    const env = allProcessEnv();

    if (options.maxWorkerConcurrency === undefined) {
      const envValue = env[envKeys.InngestConnectMaxWorkerConcurrency];
      if (envValue) {
        const parsed = Number.parseInt(envValue, 10);
        if (!Number.isNaN(parsed) && parsed > 0) {
          options.maxWorkerConcurrency = parsed;
        }
      }
    }

    // Check for worker thread env var (opt-out: false/0 disables isolation)
    if (options.isolateExecution === undefined) {
      const envValue = env[envKeys.InngestConnectIsolateExecution];
      if (envValue === "0" || envValue === "false") {
        options.isolateExecution = false;
      }
    }

    if (options.gatewayUrl === undefined) {
      const envValue = env[envKeys.InngestConnectGatewayUrl];
      if (envValue) {
        options.gatewayUrl = envValue;
      }
    }

    return options;
  }

  get state(): ConnectionState {
    return this.strategy?.state ?? ConnectionState.CONNECTING;
  }

  get connectionId(): string {
    if (!this.strategy?.connectionId) {
      throw new Error("Connection not prepared");
    }
    return this.strategy.connectionId;
  }

  get closed(): Promise<void> {
    if (!this.strategy) {
      throw new Error("No connection established");
    }
    return this.strategy.closed;
  }

  getDebugState(): ConnectDebugState {
    if (!this.strategy) {
      return {
        state: ConnectionState.CONNECTING,
        activeConnectionId: undefined,
        drainingConnectionId: undefined,
        lastHeartbeatSentAt: undefined,
        lastHeartbeatReceivedAt: undefined,
        lastMessageReceivedAt: undefined,
        shutdownRequested: false,
        inFlightRequestCount: 0,
        inFlightRequests: [],
      };
    }
    return this.strategy.getDebugState();
  }

  async close(): Promise<void> {
    if (!this.strategy) {
      return;
    }
    return this.strategy.close();
  }

  /**
   * Establish a persistent connection to the gateway.
   */
  async connect(attempt = 0): Promise<void> {
    this.inngest[internalLoggerSymbol].debug(
      { attempt },
      "Establishing connection",
    );

    const {
      hashedSigningKey,
      hashedFallbackKey,
      envName,
      connectionData,
      requestHandlers,
    } = prepareConnectionConfig(this.options.apps, this.inngest);

    // Create and initialize the strategy
    this.strategy = await createStrategy(
      {
        hashedSigningKey,
        hashedFallbackKey,
        internalLogger: this.inngest[internalLoggerSymbol],
        envName,
        connectionData,
        requestHandlers,
        options: this.options,
        apiBaseUrl: this.inngest.apiBaseUrl,
        mode: this.inngest["mode"],
      },
      this.options,
    );

    // Delegate to the strategy
    await this.strategy.connect(attempt);
  }
}

// Export types for convenience
export {
  DEFAULT_SHUTDOWN_SIGNALS,
  type ConnectApp,
  type ConnectDebugState,
  type ConnectHandlerOptions,
  ConnectionState,
  type InFlightRequest,
  type WorkerConnection,
};

export const connect = async (
  options: ConnectHandlerOptions,
): Promise<WorkerConnection> => {
  if (options.apps.length === 0) {
    throw new Error("No apps provided");
  }

  const conn = new WebSocketWorkerConnection(options);

  await conn.connect();

  return conn;
};
