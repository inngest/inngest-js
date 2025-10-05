import { WaitGroup } from "@jpwilliams/waitgroup";
import ms from "ms";
import { allProcessEnv, getPlatformName } from "../../helpers/env.ts";
import {
  ConnectMessage,
  GatewayConnectionReadyData,
  GatewayMessageType,
  gatewayMessageTypeToJSON,
  WorkerConnectRequestData,
  WorkerDisconnectReason,
  workerDisconnectReasonToJSON,
  StartResponse,
} from "../../proto/src/components/connect/protobuf/connect.ts";
import { version } from "../../version.ts";
import { MessageBuffer } from "./buffer.ts";
import { parseConnectMessage } from "./messages.ts";
import { getHostname, onShutdown, retrieveSystemAttributes } from "./os.ts";
import { type ConnectHandlerOptions, ConnectionState } from "./types.ts";
import {
  AuthError,
  ConnectionLimitError,
  expBackoff,
  getPromiseHandle,
  ReconnectError,
  waitWithCancel,
} from "./util.ts";
import { sendStartRequest } from "./api.ts";
import { Base } from "./base.ts";

const ConnectWebSocketProtocol = "v0.connect.inngest.com";

export interface Connection {
  id: string;
  gwGroup: string;
  ws: WebSocket;

  extendLeaseIntervalMs: number;
  heartbeatIntervalMs: number;
  cleanup: () => void | Promise<void>;
  pendingHeartbeats: number;
}

interface ReconcileResult {
  deduped?: boolean;
  done?: boolean;
  waitFor?: number;
}

export class ConnectionManager extends Base {
  private reconcileTick = 250; // attempt to reconcile every 250ms
  private reconciling = false;
  private closeRequested = false;

  private connections: Connection[] = [];
  protected activeConnection: Connection | undefined;
  protected drainingConnection: Connection | undefined;

  protected inProgressRequests: {
    /**
     * A wait group to track in-flight requests.
     */
    wg: WaitGroup;

    requestLeases: Record<string, string>;
  } = {
    wg: new WaitGroup(),
    requestLeases: {},
  };

  /**
   * The buffer of messages to be sent to the gateway.
   */
  protected messageBuffer: MessageBuffer;

  /**
   * A set of gateways to exclude from the connection.
   */
  private excludeGateways: Set<string> = new Set();

  /**
   * Function to remove the shutdown signal handler.
   */
  private cleanupShutdownSignal: (() => void) | undefined;

  /**
   * A promise that resolves when the connection is closed on behalf of the
   * user by calling `close()` or when a shutdown signal is received.
   */
  private closingPromise: Promise<void> | undefined;
  private resolveClosingPromise:
    | ((value: void | PromiseLike<void>) => void)
    | undefined;

  constructor(options: ConnectHandlerOptions) {
    super(options);

    this.messageBuffer = new MessageBuffer(this.inngest);

    this.closingPromise = new Promise((resolve) => {
      this.resolveClosingPromise = resolve;
    });
  }

  async close(): Promise<void> {
    this.closeRequested = true;

    return this.closed;
  }

  /**
   * A promise that resolves when the connection is closed on behalf of the
   * user by calling `close()` or when a shutdown signal is received.
   */
  get closed(): Promise<void> {
    if (!this.closingPromise) {
      throw new Error("No connection established");
    }
    return this.closingPromise;
  }

  /**
   * The current connection ID of the worker.
   */
  get connectionId(): string {
    if (!this.activeConnection) {
      throw new Error("Connection not prepared");
    }
    return this.activeConnection.id;
  }

  public override async init() {
    await super.init();

    if (
      this.options.handleShutdownSignals &&
      this.options.handleShutdownSignals.length > 0
    ) {
      this.setupShutdownSignal(this.options.handleShutdownSignals);
    }
  }

  public async start() {
    // Set up function configs, etc.
    await this.init();

    // Create reconcile loop
    const scheduleReconcile = (waitFor: number) => {
      const reconcileTimeout = setTimeout(async () => {
        try {
          const res = await this.reconcile();
          if (res.waitFor) {
            scheduleReconcile(res.waitFor);
            return;
          }

          scheduleReconcile(this.reconcileTick);
        } catch (err) {
          // TODO: Ensure this is properly surfaced
          clearTimeout(reconcileTimeout);
          throw err;
        }
      }, waitFor);
    };

    scheduleReconcile(this.reconcileTick);

    // Wait for connection to be established
    for (let attempt = 0; attempt < 10; attempt++) {
      const delay = expBackoff(attempt);
      const cancelled = await waitWithCancel(
        delay,
        () => this.activeConnection !== undefined
      );

      if (cancelled) {
        throw new Error("Connection canceled while establishing");
      }

      if (this.activeConnection) {
        break;
      }
    }
  }

  public get state(): ConnectionState {
    if (this.closeRequested) {
      if (this.connections.length === 0) {
        return ConnectionState.CLOSED;
      }

      return ConnectionState.CLOSING;
    }

    if (this.activeConnection) {
      return ConnectionState.ACTIVE;
    }

    if (this.connections.length > 0) {
      return ConnectionState.RECONNECTING;
    }

    return ConnectionState.CONNECTING;
  }

  private _reconcileAttempt = 0;

  public async reconcile(): Promise<ReconcileResult> {
    try {
      if (this.reconciling) {
        return { deduped: true };
      }
      this.reconciling = true;

      if (this.closeRequested) {
        // Remove the shutdown signal handler
        if (this.cleanupShutdownSignal) {
          this.cleanupShutdownSignal();
          this.cleanupShutdownSignal = undefined;
        }

        // Close and clean up remaining connections
        for (const conn of this.connections) {
          await conn.cleanup();
        }

        // Wait for remaining requests to finish
        this.debug("Waiting for in-flight requests to complete");
        await this.inProgressRequests.wg.wait();

        // Flush messages and retry until buffer is empty
        this.debug("Flushing messages before closing");
        await this.messageBuffer.flush(this.hashedSigningKey);

        // Resolve closing promise
        this.resolveClosingPromise?.();

        return { done: true };
      }

      // Clean up any previous connection state
      // Note: Never reset the message buffer, as there may be pending/unsent messages
      // Flush any pending messages
      await this.messageBuffer.flush(this.hashedSigningKey);

      if (!this.activeConnection) {
        try {
          const conn = await this.connect();
          this.activeConnection = conn;
        } catch (err) {
          this.debug("Failed to connect", err);

          if (!(err instanceof ReconnectError)) {
            throw err;
          }

          if (err instanceof AuthError) {
            const switchToFallback = !this.useFallbackKey;
            if (switchToFallback) {
              this.debug("Switching to fallback signing key");
              this.useFallbackKey = true;
            }
          }

          if (err instanceof ConnectionLimitError) {
            console.error(
              "You have reached the maximum number of concurrent connections. Please disconnect other active workers to continue."
            );
            // Continue reconnecting, do not throw.
          }

          const delay = expBackoff(this._reconcileAttempt);
          this.debug("Reconnecting in", delay, "ms");

          this._reconcileAttempt++;
          return { waitFor: delay };
        }
      }

      const drainingConnection = this.drainingConnection;
      if (drainingConnection) {
        await drainingConnection.cleanup();
        this.drainingConnection = undefined;
      }

      // In case there's only an active connection, close all leftover connections

      for (const conn of this.connections) {
        // Discard non-active connections
        if (this.activeConnection.id === conn.id) {
          continue;
        }
        await conn.cleanup();
      }

      return {};
    } catch (err) {
      this.debug("Reconcile error", err);
      return { waitFor: this.reconcileTick };
    } finally {
      this.reconciling = false;
    }
  }

  // openWebSocket establishes a WebSocket connection and performs the WebSocket handshake
  private async openWebSocket(
    connectionId: string,
    startResp: StartResponse,
    endpoint: string,
    startedAt: Date
  ): Promise<{
    ws: WebSocket;
    heartbeatIntervalMs: number;
    extendLeaseIntervalMs: number;
  }> {
    const data = this._initData;
    if (!data) {
      throw new Error("Missing init data");
    }

    /**
     * The current setup state of the connection.
     */
    const setupState = {
      receivedGatewayHello: false,
      sentWorkerConnect: false,
      receivedConnectionReady: false,
    };

    let heartbeatIntervalMs: number | undefined;
    let extendLeaseIntervalMs: number | undefined;

    const {
      promise: websocketConnectedPromise,
      resolve: resolveWebsocketConnected,
      reject: rejectWebsocketConnected,
    } = getPromiseHandle<void>();

    const connectTimeout = setTimeout(() => {
      this.excludeGateways.add(startResp.gatewayGroup);
      rejectWebsocketConnected?.(
        new ReconnectError(`Connection ${connectionId} timed out`)
      );
    }, 10_000);

    const ws = new WebSocket(endpoint, [ConnectWebSocketProtocol]);
    ws.binaryType = "arraybuffer";

    let closed = false;
    const onConnectionError = (error: unknown) => {
      // Only process the first error per connection
      if (closed) {
        this.debug(
          `Connection error while initializing but already in closed state, skipping`,
          {
            connectionId,
          }
        );
        return;
      }
      closed = true;

      this.debug(`Connection error in connecting state, rejecting promise`, {
        connectionId,
      });

      this.excludeGateways.add(startResp.gatewayGroup);

      clearTimeout(connectTimeout);

      // Make sure to close the WebSocket if it's still open
      ws.onerror = () => {};
      ws.onclose = () => {};
      ws.close(
        4001, // incomplete setup
        workerDisconnectReasonToJSON(WorkerDisconnectReason.UNEXPECTED)
      );

      rejectWebsocketConnected?.(
        new ReconnectError(
          `Error while connecting (${connectionId}): ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        )
      );
    };

    ws.onerror = (err) => onConnectionError(err);
    ws.onclose = (ev) => {
      void onConnectionError(
        new ReconnectError(`Connection ${connectionId} closed: ${ev.reason}`)
      );
    };
    ws.onmessage = async (event) => {
      const messageBytes = new Uint8Array(event.data as ArrayBuffer);

      const connectMessage = parseConnectMessage(messageBytes);

      this.debug(
        `Received message: ${gatewayMessageTypeToJSON(connectMessage.kind)}`,
        {
          connectionId,
        }
      );

      if (!setupState.receivedGatewayHello) {
        if (connectMessage.kind !== GatewayMessageType.GATEWAY_HELLO) {
          void onConnectionError(
            new ReconnectError(
              `Expected hello message, got ${gatewayMessageTypeToJSON(
                connectMessage.kind
              )}`
            )
          );
          return;
        }
        setupState.receivedGatewayHello = true;
      }

      if (!setupState.sentWorkerConnect) {
        const workerConnectRequestMsg = WorkerConnectRequestData.create({
          connectionId: startResp.connectionId,
          environment: this._inngestEnv,
          platform: getPlatformName({
            ...allProcessEnv(),
          }),
          sdkVersion: `v${version}`,
          sdkLanguage: "typescript",
          framework: "connect",
          workerManualReadinessAck: data.manualReadinessAck,
          systemAttributes: await retrieveSystemAttributes(),
          authData: {
            sessionToken: startResp.sessionToken,
            syncToken: startResp.syncToken,
          },
          apps: data.apps,
          capabilities: new TextEncoder().encode(data.marshaledCapabilities),
          startedAt: startedAt,
          instanceId: this.options.instanceId || (await getHostname()),
        });

        const workerConnectRequestMsgBytes = WorkerConnectRequestData.encode(
          workerConnectRequestMsg
        ).finish();

        ws.send(
          ConnectMessage.encode(
            ConnectMessage.create({
              kind: GatewayMessageType.WORKER_CONNECT,
              payload: workerConnectRequestMsgBytes,
            })
          ).finish()
        );

        setupState.sentWorkerConnect = true;
        return;
      }

      if (!setupState.receivedConnectionReady) {
        if (
          connectMessage.kind !== GatewayMessageType.GATEWAY_CONNECTION_READY
        ) {
          void onConnectionError(
            new ReconnectError(
              `Expected ready message, got ${gatewayMessageTypeToJSON(
                connectMessage.kind
              )}`
            )
          );
          return;
        }

        const readyPayload = GatewayConnectionReadyData.decode(
          connectMessage.payload
        );

        setupState.receivedConnectionReady = true;

        // The intervals should be supplied by the gateway, but we should fall back just in case
        heartbeatIntervalMs =
          readyPayload.heartbeatInterval.length > 0
            ? ms(readyPayload.heartbeatInterval as ms.StringValue) // TODO Grim cast
            : 10_000;
        extendLeaseIntervalMs =
          readyPayload.extendLeaseInterval.length > 0
            ? ms(readyPayload.extendLeaseInterval as ms.StringValue) // TODO Grim cast
            : 5_000;

        resolveWebsocketConnected?.();
        return;
      }

      this.debug("Unexpected message type during setup", {
        kind: gatewayMessageTypeToJSON(connectMessage.kind),
        rawKind: connectMessage.kind,
        setupState: setupState,
        connectionId,
      });
    };

    await websocketConnectedPromise;

    clearTimeout(connectTimeout);

    return {
      ws: ws,
      heartbeatIntervalMs: heartbeatIntervalMs || 10_000,
      extendLeaseIntervalMs: extendLeaseIntervalMs || 5_000,
    };
  }

  // establishConnection will create a WebSocket connection and complete the handshake.
  // The Promise returned by this method will resolve once the connection was successfully set up
  // and will be rejected if the setup process fails.
  private async connect() {
    const data = this._initData;
    if (!data) {
      throw new Error("Missing init data");
    }

    const signingKey = this.hashedSigningKey;
    if (!signingKey) {
      throw new Error("Missing signing key");
    }

    this.debug("Preparing connection");

    const startedAt = new Date();

    const startResp = await sendStartRequest({
      inngest: this.inngest,
      excludeGateways: Array.from(this.excludeGateways),
      env: this._inngestEnv,
      signingKey: signingKey,
    });

    const connectionId = startResp.connectionId;

    let finalEndpoint = startResp.gatewayEndpoint;
    if (this.options.rewriteGatewayEndpoint) {
      const rewritten = this.options.rewriteGatewayEndpoint(
        startResp.gatewayEndpoint
      );
      this.debug("Rewriting gateway endpoint", {
        original: startResp.gatewayEndpoint,
        rewritten,
      });
      finalEndpoint = rewritten;
    }

    this.debug(`Connecting to gateway`, {
      endpoint: finalEndpoint,
      gatewayGroup: startResp.gatewayGroup,
      connectionId,
    });

    // Open WebSocket and perform handshake
    const { ws, extendLeaseIntervalMs, heartbeatIntervalMs } =
      await this.openWebSocket(
        connectionId,
        startResp,
        finalEndpoint,
        startedAt
      );

    this.excludeGateways.delete(startResp.gatewayGroup);

    const conn: Connection = {
      id: connectionId,
      gwGroup: startResp.gatewayGroup,
      ws,
      extendLeaseIntervalMs,
      heartbeatIntervalMs,
      cleanup: () => {
        // Deregister handlers and close WebSocket
        ws.onerror = () => {};
        ws.onclose = () => {};
        ws.onmessage = () => {};

        try {
          ws.close();
        } catch (err) {
          this.debug("Closing WebSocket failed", { err });
        }

        // Remove from list of connections
        this.connections = this.connections.filter(
          (c) => c.id !== connectionId
        );
      },
      pendingHeartbeats: 0,
    };
    this.connections.push(conn);

    this.handleWebSocketSteadyState(conn, ws);

    this.debug(`Connection ready (${connectionId})`);

    return conn;
  }

  protected async handleMessage(_: Connection, __: ConnectMessage) {
    throw new Error("This is expected to be implemented in a superclass");
  }

  private handleWebSocketSteadyState(conn: Connection, ws: WebSocket) {
    // Flag to prevent connecting twice in draining scenario:
    // 1. We're already draining and repeatedly trying to connect while keeping the old connection open
    // 2. The gateway closes the old connection after a timeout, causing a connection error (which would also trigger a new connection)

    let closed = false;
    const onConnectionError = async (error: unknown) => {
      // Only process the first error per connection
      if (closed) {
        this.debug(`Connection error but already in closed state, skipping`, {
          connectionId: conn.id,
        });
        return;
      }
      closed = true;

      // Trigger reconnect
      if (this.activeConnection?.id === conn.id) {
        this.activeConnection = undefined;
      }

      this.debug(`Connection error (${conn.id})`, error);
    };

    ws.onerror = (err) => onConnectionError(err);
    ws.onclose = (ev) => {
      void onConnectionError(
        new ReconnectError(`Connection closed: ${ev.reason}`)
      );
    };

    ws.onmessage = async (event) => {
      const messageBytes = new Uint8Array(event.data as ArrayBuffer);

      const connectMessage = parseConnectMessage(messageBytes);

      await this.handleMessage(conn, connectMessage);

      return;
    };

    let heartbeatInterval = undefined;
    if (conn.heartbeatIntervalMs !== undefined) {
      heartbeatInterval = setInterval(() => {
        if (conn.heartbeatIntervalMs === undefined) {
          return;
        }

        // Check if we've missed 2 consecutive heartbeats
        if (conn.pendingHeartbeats >= 2) {
          this.debug("Gateway heartbeat missed");
          void onConnectionError(
            new ReconnectError(
              `Consecutive gateway heartbeats missed (${conn.id})`
            )
          );
          return;
        }

        this.debug("Sending worker heartbeat", {
          connectionId: conn.id,
        });

        // Send worker heartbeat
        conn.pendingHeartbeats++;
        ws.send(
          ConnectMessage.encode(
            ConnectMessage.create({
              kind: GatewayMessageType.WORKER_HEARTBEAT,
            })
          ).finish()
        );
      }, conn.heartbeatIntervalMs);
    }

    conn.cleanup = () => {
      this.debug("Cleaning up worker heartbeat", {
        connectionId: conn.id,
      });

      clearInterval(heartbeatInterval);

      if (closed) {
        return;
      }
      closed = true;

      this.debug("Cleaning up connection", { connectionId: conn.id });
      if (ws.readyState === WebSocket.OPEN) {
        this.debug("Sending pause message", { connectionId: conn.id });
        ws.send(
          ConnectMessage.encode(
            ConnectMessage.create({
              kind: GatewayMessageType.WORKER_PAUSE,
            })
          ).finish()
        );
      }

      this.debug("Closing connection", { connectionId: conn.id });
      ws.onerror = () => {};
      ws.onclose = () => {};
      ws.close(
        1000,
        workerDisconnectReasonToJSON(WorkerDisconnectReason.WORKER_SHUTDOWN)
      );

      if (this.activeConnection?.id === conn.id) {
        this.activeConnection = undefined;
      }
    };
  }

  private setupShutdownSignal(signals: string[]) {
    if (this.cleanupShutdownSignal) {
      return;
    }

    this.debug(`Setting up shutdown signal handler for ${signals.join(", ")}`);

    const cleanupShutdownHandlers = onShutdown(signals, () => {
      this.debug("Received shutdown signal, closing connection");
      void this.close();
    });

    this.cleanupShutdownSignal = () => {
      this.debug("Cleaning up shutdown signal handler");
      cleanupShutdownHandlers();
    };
  }
}
