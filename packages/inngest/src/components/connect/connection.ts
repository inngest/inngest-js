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
import { parseConnectMessage } from "./messages.ts";
import { getHostname, onShutdown, retrieveSystemAttributes } from "./os.ts";
import { getPromiseHandle, ReconnectError } from "./util.ts";
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

export class ConnectionManager extends Base {
  protected connections: Connection[] = [];
  protected activeConnection: Connection | undefined;
  protected drainingConnection: Connection | undefined;

  /**
   * A set of gateways to exclude from the connection.
   */
  private excludeGateways: Set<string> = new Set();

  /**
   * Function to remove the shutdown signal handler.
   */
  protected cleanupShutdownSignal: (() => void) | undefined;

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
  protected async connect() {
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

  public async close(): Promise<void> {
    // This should be implemented in superclass
    throw new Error("Not implemented");
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
