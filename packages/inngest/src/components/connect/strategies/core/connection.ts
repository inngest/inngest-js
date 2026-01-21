/**
 * Shared connection core logic used by both SameThreadStrategy and WorkerThreadStrategy.
 *
 * This module extracts the common WebSocket connection management, handshake,
 * heartbeat, lease extension, and reconnection logic.
 */

import { WaitGroup } from "@jpwilliams/waitgroup";
import ms from "ms";
import { headerKeys } from "../../../../helpers/consts.ts";
import { allProcessEnv, getPlatformName } from "../../../../helpers/env.ts";
import {
  ConnectMessage,
  GatewayConnectionReadyData,
  type GatewayExecutorRequestData,
  GatewayMessageType,
  gatewayMessageTypeToJSON,
  SDKResponse,
  WorkerConnectRequestData,
  WorkerDisconnectReason,
  WorkerRequestAckData,
  WorkerRequestExtendLeaseAckData,
  WorkerRequestExtendLeaseData,
  workerDisconnectReasonToJSON,
} from "../../../../proto/src/components/connect/protobuf/connect.ts";
import { version } from "../../../../version.ts";
import {
  createStartRequest,
  parseConnectMessage,
  parseGatewayExecutorRequest,
  parseStartResponse,
  parseWorkerReplyAck,
} from "../../messages.ts";
import { getHostname, retrieveSystemAttributes } from "../../os.ts";
import { ConnectionState } from "../../types.ts";
import {
  AuthError,
  ConnectionLimitError,
  expBackoff,
  ReconnectError,
  waitWithCancel,
} from "../../util.ts";
import type { ConnectionEstablishData } from "./types.ts";

const ConnectWebSocketProtocol = "v0.connect.inngest.com";

/**
 * Connection object representing an active WebSocket connection.
 */
export interface Connection {
  id: string;
  ws: WebSocket;
  cleanup: () => void | Promise<void>;
  pendingHeartbeats: number;
}

/**
 * Configuration for the connection core.
 */
export interface ConnectionCoreConfig {
  /**
   * The hashed signing key for authentication.
   */
  hashedSigningKey: string | undefined;

  /**
   * The hashed fallback signing key for authentication.
   */
  hashedFallbackKey: string | undefined;

  /**
   * The Inngest environment name.
   */
  inngestEnv: string | undefined;

  /**
   * Data for establishing the connection.
   */
  connectionData: ConnectionEstablishData;

  /**
   * Instance ID for the worker.
   */
  instanceId?: string;

  /**
   * Max worker concurrency.
   */
  maxWorkerConcurrency?: number;

  /**
   * Function to rewrite the gateway endpoint (optional).
   */
  rewriteGatewayEndpoint?: (endpoint: string) => string;

  /**
   * Get the target URL for API requests.
   */
  getTargetUrl: (path: string) => Promise<URL>;

  /**
   * App IDs that this connection supports.
   */
  appIds: string[];
}

/**
 * Callbacks for connection core events.
 */
export interface ConnectionCoreCallbacks {
  /**
   * Log a debug message.
   */
  log: (message: string, data?: unknown) => void;

  /**
   * Called when connection state changes.
   */
  onStateChange: (state: ConnectionState) => void;

  /**
   * Get the current connection state.
   */
  getState: () => ConnectionState;

  /**
   * Handle an execution request.
   * Returns the encoded SDKResponse bytes.
   */
  handleExecutionRequest: (
    request: GatewayExecutorRequestData,
  ) => Promise<Uint8Array>;

  /**
   * Called when a reply is acknowledged.
   */
  onReplyAck?: (requestId: string) => void;

  /**
   * Called when a response needs to be buffered (no active connection).
   */
  onBufferResponse?: (requestId: string, responseBytes: Uint8Array) => void;

  /**
   * Called before each connection attempt to allow flushing buffered messages.
   * @param signingKey The current signing key being used for this attempt
   */
  beforeConnect?: (signingKey: string | undefined) => Promise<void>;
}

/**
 * Core connection manager that handles WebSocket connection lifecycle,
 * handshake, heartbeat, lease extension, and reconnection.
 */
export class ConnectionCore {
  private config: ConnectionCoreConfig;
  private callbacks: ConnectionCoreCallbacks;

  private currentConnection: Connection | undefined;
  private excludeGateways: Set<string> = new Set();

  private inProgressRequests: {
    wg: WaitGroup;
    requestLeases: Record<string, string>;
  } = {
    wg: new WaitGroup(),
    requestLeases: {},
  };

  constructor(
    config: ConnectionCoreConfig,
    callbacks: ConnectionCoreCallbacks,
  ) {
    this.config = config;
    this.callbacks = callbacks;
  }

  get connection(): Connection | undefined {
    return this.currentConnection;
  }

  get connectionId(): string | undefined {
    return this.currentConnection?.id;
  }

  /**
   * Wait for all in-progress requests to complete.
   */
  async waitForInProgress(): Promise<void> {
    await this.inProgressRequests.wg.wait();
  }

  /**
   * Main connection loop with reconnection logic.
   */
  async connect(attempt = 0, path: string[] = []): Promise<void> {
    if (typeof WebSocket === "undefined") {
      throw new Error("WebSockets not supported in current environment");
    }

    const state = this.callbacks.getState();
    if (state === ConnectionState.CLOSING || state === ConnectionState.CLOSED) {
      throw new Error("Connection already closed");
    }

    this.callbacks.log("Establishing connection", { attempt });

    let useSigningKey = this.config.hashedSigningKey;

    while (true) {
      const currentState = this.callbacks.getState();
      if (
        currentState === ConnectionState.CLOSING ||
        currentState === ConnectionState.CLOSED
      ) {
        break;
      }

      // Flush any pending messages before attempting connection
      if (this.callbacks.beforeConnect) {
        await this.callbacks.beforeConnect(useSigningKey);
      }

      try {
        await this.prepareConnection(useSigningKey, attempt, [...path]);
        return;
      } catch (err) {
        this.callbacks.log(
          "Failed to connect",
          err instanceof Error ? err.message : err,
        );

        if (!(err instanceof ReconnectError)) {
          throw err;
        }

        attempt = err.attempt;

        if (err instanceof AuthError) {
          const switchToFallback =
            useSigningKey === this.config.hashedSigningKey;
          if (switchToFallback) {
            this.callbacks.log("Switching to fallback signing key");
          }
          useSigningKey = switchToFallback
            ? this.config.hashedFallbackKey
            : this.config.hashedSigningKey;
        }

        if (err instanceof ConnectionLimitError) {
          console.error(
            "You have reached the maximum number of concurrent connections. Please disconnect other active workers to continue.",
          );
        }

        const delay = expBackoff(attempt);
        this.callbacks.log(`Reconnecting in ${delay}ms`);

        const cancelled = await waitWithCancel(delay, () => {
          const s = this.callbacks.getState();
          return s === ConnectionState.CLOSING || s === ConnectionState.CLOSED;
        });
        if (cancelled) {
          this.callbacks.log("Reconnect backoff cancelled");
          break;
        }

        attempt++;
      }
    }

    this.callbacks.log("Exiting connect loop");
  }

  /**
   * Clean up the current connection.
   */
  async cleanup(): Promise<void> {
    if (this.currentConnection) {
      await this.currentConnection.cleanup();
      this.currentConnection = undefined;
    }
  }

  private async sendStartRequest(
    hashedSigningKey: string | undefined,
    attempt: number,
  ) {
    const msg = createStartRequest(Array.from(this.excludeGateways));

    const headers: Record<string, string> = {
      "Content-Type": "application/protobuf",
      ...(hashedSigningKey
        ? { Authorization: `Bearer ${hashedSigningKey}` }
        : {}),
    };

    if (this.config.inngestEnv) {
      headers[headerKeys.Environment] = this.config.inngestEnv;
    }

    const targetUrl = await this.config.getTargetUrl("/v0/connect/start");

    let resp;
    try {
      resp = await fetch(targetUrl, {
        method: "POST",
        body: new Uint8Array(msg),
        headers: headers,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      throw new ReconnectError(
        `Failed initial API handshake request to ${targetUrl.toString()}, ${errMsg}`,
        attempt,
      );
    }

    if (!resp.ok) {
      if (resp.status === 401) {
        throw new AuthError(
          `Failed initial API handshake request to ${targetUrl.toString()}${
            this.config.inngestEnv ? ` (env: ${this.config.inngestEnv})` : ""
          }, ${await resp.text()}`,
          attempt,
        );
      }

      if (resp.status === 429) {
        throw new ConnectionLimitError(attempt);
      }

      throw new ReconnectError(
        `Failed initial API handshake request to ${targetUrl.toString()}, ${await resp.text()}`,
        attempt,
      );
    }

    const startResp = await parseStartResponse(resp);
    return startResp;
  }

  private async prepareConnection(
    hashedSigningKey: string | undefined,
    attempt: number,
    path: string[] = [],
  ): Promise<Connection> {
    let closed = false;

    this.callbacks.log("Preparing connection", { attempt, path });

    const startedAt = new Date();
    const startResp = await this.sendStartRequest(hashedSigningKey, attempt);

    const connectionId = startResp.connectionId;
    path.push(connectionId);

    let resolveWebsocketConnected:
      | ((value: void | PromiseLike<void>) => void)
      | undefined;
    let rejectWebsocketConnected: ((reason?: unknown) => void) | undefined;
    const websocketConnectedPromise = new Promise<void>((resolve, reject) => {
      resolveWebsocketConnected = resolve;
      rejectWebsocketConnected = reject;
    });

    const connectTimeout = setTimeout(() => {
      this.excludeGateways.add(startResp.gatewayGroup);
      rejectWebsocketConnected?.(
        new ReconnectError(`Connection ${connectionId} timed out`, attempt),
      );
    }, 10_000);

    let finalEndpoint = startResp.gatewayEndpoint;
    if (this.config.rewriteGatewayEndpoint) {
      const rewritten = this.config.rewriteGatewayEndpoint(
        startResp.gatewayEndpoint,
      );
      this.callbacks.log("Rewriting gateway endpoint", {
        original: startResp.gatewayEndpoint,
        rewritten,
      });
      finalEndpoint = rewritten;
    }

    this.callbacks.log("Connecting to gateway", {
      endpoint: finalEndpoint,
      gatewayGroup: startResp.gatewayGroup,
      connectionId,
    });

    const ws = new WebSocket(finalEndpoint, [ConnectWebSocketProtocol]);
    ws.binaryType = "arraybuffer";

    let onConnectionError: (error: unknown) => void | Promise<void>;
    {
      onConnectionError = (error: unknown) => {
        if (closed) {
          this.callbacks.log(
            "Connection error while initializing but already in closed state, skipping",
            { connectionId },
          );
          return;
        }
        closed = true;

        this.callbacks.log(
          "Connection error in connecting state, rejecting promise",
          { connectionId },
        );

        this.excludeGateways.add(startResp.gatewayGroup);
        clearTimeout(connectTimeout);

        ws.onerror = () => {};
        ws.onclose = () => {};
        ws.close(
          4001,
          workerDisconnectReasonToJSON(WorkerDisconnectReason.UNEXPECTED),
        );

        rejectWebsocketConnected?.(
          new ReconnectError(
            `Error while connecting (${connectionId}): ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
            attempt,
          ),
        );
      };

      ws.onerror = (err) => onConnectionError(err);
      ws.onclose = (ev) => {
        void onConnectionError(
          new ReconnectError(
            `Connection ${connectionId} closed: ${ev.reason}`,
            attempt,
          ),
        );
      };
    }

    const setupState = {
      receivedGatewayHello: false,
      sentWorkerConnect: false,
      receivedConnectionReady: false,
    };

    let heartbeatIntervalMs: number | undefined;
    let extendLeaseIntervalMs: number | undefined;

    ws.onmessage = async (event) => {
      const messageBytes = new Uint8Array(event.data as ArrayBuffer);
      const connectMessage = parseConnectMessage(messageBytes);

      this.callbacks.log(
        `Received message: ${gatewayMessageTypeToJSON(connectMessage.kind)}`,
        { connectionId },
      );

      if (!setupState.receivedGatewayHello) {
        if (connectMessage.kind !== GatewayMessageType.GATEWAY_HELLO) {
          void onConnectionError(
            new ReconnectError(
              `Expected hello message, got ${gatewayMessageTypeToJSON(
                connectMessage.kind,
              )}`,
              attempt,
            ),
          );
          return;
        }
        setupState.receivedGatewayHello = true;
      }

      if (!setupState.sentWorkerConnect) {
        const workerConnectRequestMsg = WorkerConnectRequestData.create({
          connectionId: startResp.connectionId,
          environment: this.config.inngestEnv,
          platform: getPlatformName({ ...allProcessEnv() }),
          sdkVersion: `v${version}`,
          sdkLanguage: "typescript",
          framework: "connect",
          workerManualReadinessAck:
            this.config.connectionData.manualReadinessAck,
          systemAttributes: await retrieveSystemAttributes(),
          authData: {
            sessionToken: startResp.sessionToken,
            syncToken: startResp.syncToken,
          },
          apps: this.config.connectionData.apps,
          capabilities: new TextEncoder().encode(
            this.config.connectionData.marshaledCapabilities,
          ),
          startedAt: startedAt,
          instanceId: this.config.instanceId || (await getHostname()),
          maxWorkerConcurrency: this.config.maxWorkerConcurrency,
        });

        const workerConnectRequestMsgBytes = WorkerConnectRequestData.encode(
          workerConnectRequestMsg,
        ).finish();

        ws.send(
          ConnectMessage.encode(
            ConnectMessage.create({
              kind: GatewayMessageType.WORKER_CONNECT,
              payload: workerConnectRequestMsgBytes,
            }),
          ).finish(),
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
                connectMessage.kind,
              )}`,
              attempt,
            ),
          );
          return;
        }

        const readyPayload = GatewayConnectionReadyData.decode(
          connectMessage.payload,
        );

        setupState.receivedConnectionReady = true;

        heartbeatIntervalMs =
          readyPayload.heartbeatInterval.length > 0
            ? ms(readyPayload.heartbeatInterval as ms.StringValue)
            : 10_000;
        extendLeaseIntervalMs =
          readyPayload.extendLeaseInterval.length > 0
            ? ms(readyPayload.extendLeaseInterval as ms.StringValue)
            : 5_000;

        resolveWebsocketConnected?.();
        return;
      }

      this.callbacks.log("Unexpected message type during setup", {
        kind: gatewayMessageTypeToJSON(connectMessage.kind),
        rawKind: connectMessage.kind,
        attempt,
        setupState,
        state: this.callbacks.getState(),
        connectionId,
      });
    };

    await websocketConnectedPromise;

    clearTimeout(connectTimeout);

    this.callbacks.onStateChange(ConnectionState.ACTIVE);
    this.excludeGateways.delete(startResp.gatewayGroup);

    attempt = 0;

    const conn: Connection = {
      id: connectionId,
      ws,
      cleanup: () => {
        if (closed) {
          return;
        }
        closed = true;
        ws.onerror = () => {};
        ws.onclose = () => {};
        ws.close();
      },
      pendingHeartbeats: 0,
    };
    this.currentConnection = conn;

    this.callbacks.log(`Connection ready (${connectionId})`);

    let isDraining = false;
    {
      onConnectionError = async (error: unknown) => {
        if (closed) {
          this.callbacks.log(
            "Connection error but already in closed state, skipping",
            { connectionId },
          );
          return;
        }
        closed = true;

        await conn.cleanup();

        const currentState = this.callbacks.getState();
        if (
          currentState === ConnectionState.CLOSING ||
          currentState === ConnectionState.CLOSED
        ) {
          this.callbacks.log(
            `Connection error (${connectionId}) but already closing or closed, skipping`,
          );
          return;
        }

        this.callbacks.onStateChange(ConnectionState.RECONNECTING);
        this.excludeGateways.add(startResp.gatewayGroup);

        if (isDraining) {
          this.callbacks.log(
            `Connection error (${connectionId}) but already draining, skipping`,
          );
          return;
        }

        this.callbacks.log(
          `Connection error (${connectionId})`,
          error instanceof Error ? error.message : error,
        );
        this.connect(attempt + 1, [...path, "onConnectionError"]);
      };

      ws.onerror = (err) => onConnectionError(err);
      ws.onclose = (ev) => {
        void onConnectionError(
          new ReconnectError(`Connection closed: ${ev.reason}`, attempt),
        );
      };
    }

    ws.onmessage = async (event) => {
      const messageBytes = new Uint8Array(event.data as ArrayBuffer);
      const connectMessage = parseConnectMessage(messageBytes);

      if (connectMessage.kind === GatewayMessageType.GATEWAY_CLOSING) {
        isDraining = true;
        this.callbacks.log("Received draining message", { connectionId });
        try {
          this.callbacks.log(
            "Setting up new connection while keeping previous connection open",
            { connectionId },
          );

          await this.connect(0, [...path]);
          await conn.cleanup();
        } catch (err) {
          this.callbacks.log(
            "Failed to reconnect after receiving draining message",
            {
              connectionId,
              err: err instanceof Error ? err.message : err,
            },
          );

          await conn.cleanup();

          void onConnectionError(
            new ReconnectError(
              `Failed to reconnect after receiving draining message (${connectionId})`,
              attempt,
            ),
          );
        }
        return;
      }

      if (connectMessage.kind === GatewayMessageType.GATEWAY_HEARTBEAT) {
        conn.pendingHeartbeats = 0;
        this.callbacks.log("Handled gateway heartbeat", { connectionId });
        return;
      }

      if (connectMessage.kind === GatewayMessageType.GATEWAY_EXECUTOR_REQUEST) {
        const currentState = this.callbacks.getState();
        if (currentState !== ConnectionState.ACTIVE) {
          this.callbacks.log("Received request while not active, skipping", {
            connectionId,
          });
          return;
        }

        const gatewayExecutorRequest = parseGatewayExecutorRequest(
          connectMessage.payload,
        );

        this.callbacks.log("Received gateway executor request", {
          requestId: gatewayExecutorRequest.requestId,
          appId: gatewayExecutorRequest.appId,
          appName: gatewayExecutorRequest.appName,
          functionSlug: gatewayExecutorRequest.functionSlug,
          stepId: gatewayExecutorRequest.stepId,
          connectionId,
        });

        if (
          typeof gatewayExecutorRequest.appName !== "string" ||
          gatewayExecutorRequest.appName.length === 0
        ) {
          this.callbacks.log("No app name in request, skipping", {
            requestId: gatewayExecutorRequest.requestId,
            appId: gatewayExecutorRequest.appId,
            functionSlug: gatewayExecutorRequest.functionSlug,
            stepId: gatewayExecutorRequest.stepId,
            connectionId,
          });
          return;
        }

        if (!this.config.appIds.includes(gatewayExecutorRequest.appName)) {
          this.callbacks.log("No request handler found for app, skipping", {
            requestId: gatewayExecutorRequest.requestId,
            appId: gatewayExecutorRequest.appId,
            appName: gatewayExecutorRequest.appName,
            functionSlug: gatewayExecutorRequest.functionSlug,
            stepId: gatewayExecutorRequest.stepId,
            connectionId,
          });
          return;
        }

        // Send ACK
        ws.send(
          ConnectMessage.encode(
            ConnectMessage.create({
              kind: GatewayMessageType.WORKER_REQUEST_ACK,
              payload: WorkerRequestAckData.encode(
                WorkerRequestAckData.create({
                  accountId: gatewayExecutorRequest.accountId,
                  envId: gatewayExecutorRequest.envId,
                  appId: gatewayExecutorRequest.appId,
                  functionSlug: gatewayExecutorRequest.functionSlug,
                  requestId: gatewayExecutorRequest.requestId,
                  stepId: gatewayExecutorRequest.stepId,
                  userTraceCtx: gatewayExecutorRequest.userTraceCtx,
                  systemTraceCtx: gatewayExecutorRequest.systemTraceCtx,
                  runId: gatewayExecutorRequest.runId,
                }),
              ).finish(),
            }),
          ).finish(),
        );

        this.inProgressRequests.wg.add(1);
        this.inProgressRequests.requestLeases[
          gatewayExecutorRequest.requestId
        ] = gatewayExecutorRequest.leaseId;

        // Start lease extension interval
        let extendLeaseInterval: NodeJS.Timeout | undefined;
        extendLeaseInterval = setInterval(() => {
          if (extendLeaseIntervalMs === undefined) {
            return;
          }

          const currentLeaseId =
            this.inProgressRequests.requestLeases[
              gatewayExecutorRequest.requestId
            ];
          if (!currentLeaseId) {
            clearInterval(extendLeaseInterval);
            return;
          }

          this.callbacks.log("Extending lease", {
            connectionId,
            leaseId: currentLeaseId,
          });

          ws.send(
            ConnectMessage.encode(
              ConnectMessage.create({
                kind: GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE,
                payload: WorkerRequestExtendLeaseData.encode(
                  WorkerRequestExtendLeaseData.create({
                    accountId: gatewayExecutorRequest.accountId,
                    envId: gatewayExecutorRequest.envId,
                    appId: gatewayExecutorRequest.appId,
                    functionSlug: gatewayExecutorRequest.functionSlug,
                    requestId: gatewayExecutorRequest.requestId,
                    stepId: gatewayExecutorRequest.stepId,
                    runId: gatewayExecutorRequest.runId,
                    userTraceCtx: gatewayExecutorRequest.userTraceCtx,
                    systemTraceCtx: gatewayExecutorRequest.systemTraceCtx,
                    leaseId: currentLeaseId,
                  }),
                ).finish(),
              }),
            ).finish(),
          );
        }, extendLeaseIntervalMs);

        try {
          // Handle execution via callback
          const responseBytes = await this.callbacks.handleExecutionRequest(
            gatewayExecutorRequest,
          );

          this.callbacks.log("Sending worker reply", {
            connectionId,
            requestId: gatewayExecutorRequest.requestId,
          });

          if (!this.currentConnection) {
            this.callbacks.log("No current WebSocket, buffering response", {
              connectionId,
              requestId: gatewayExecutorRequest.requestId,
            });
            if (this.callbacks.onBufferResponse) {
              this.callbacks.onBufferResponse(
                gatewayExecutorRequest.requestId,
                responseBytes,
              );
            }
            return;
          }

          this.currentConnection.ws.send(
            ConnectMessage.encode(
              ConnectMessage.create({
                kind: GatewayMessageType.WORKER_REPLY,
                payload: responseBytes,
              }),
            ).finish(),
          );
        } catch (err) {
          this.callbacks.log(
            `Execution error for request ${gatewayExecutorRequest.requestId}`,
            err instanceof Error ? err.message : err,
          );
        } finally {
          this.inProgressRequests.wg.done();
          delete this.inProgressRequests.requestLeases[
            gatewayExecutorRequest.requestId
          ];
          clearInterval(extendLeaseInterval);
        }

        return;
      }

      if (connectMessage.kind === GatewayMessageType.WORKER_REPLY_ACK) {
        const replyAck = parseWorkerReplyAck(connectMessage.payload);

        this.callbacks.log("Acknowledging reply ack", {
          connectionId,
          requestId: replyAck.requestId,
        });

        this.callbacks.onReplyAck?.(replyAck.requestId);
        return;
      }

      if (
        connectMessage.kind ===
        GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE_ACK
      ) {
        const extendLeaseAck = WorkerRequestExtendLeaseAckData.decode(
          connectMessage.payload,
        );

        this.callbacks.log("Received extend lease ack", {
          connectionId,
          newLeaseId: extendLeaseAck.newLeaseId,
        });

        if (extendLeaseAck.newLeaseId) {
          this.inProgressRequests.requestLeases[extendLeaseAck.requestId] =
            extendLeaseAck.newLeaseId;
        } else {
          this.callbacks.log("Unable to extend lease", {
            connectionId,
            requestId: extendLeaseAck.requestId,
          });
          delete this.inProgressRequests.requestLeases[
            extendLeaseAck.requestId
          ];
        }

        return;
      }

      this.callbacks.log("Unexpected message type", {
        kind: gatewayMessageTypeToJSON(connectMessage.kind),
        rawKind: connectMessage.kind,
        attempt,
        setupState,
        state: this.callbacks.getState(),
        connectionId,
      });
    };

    // Heartbeat interval
    let heartbeatInterval: NodeJS.Timeout | undefined;
    if (heartbeatIntervalMs !== undefined) {
      heartbeatInterval = setInterval(() => {
        if (heartbeatIntervalMs === undefined) {
          return;
        }

        if (conn.pendingHeartbeats >= 2) {
          this.callbacks.log("Gateway heartbeat missed");
          void onConnectionError(
            new ReconnectError(
              `Consecutive gateway heartbeats missed (${connectionId})`,
              attempt,
            ),
          );
          return;
        }

        this.callbacks.log("Sending worker heartbeat", { connectionId });

        conn.pendingHeartbeats++;
        ws.send(
          ConnectMessage.encode(
            ConnectMessage.create({
              kind: GatewayMessageType.WORKER_HEARTBEAT,
            }),
          ).finish(),
        );
      }, heartbeatIntervalMs);
    }

    conn.cleanup = async () => {
      if (closed) {
        return;
      }
      closed = true;

      this.callbacks.log("Cleaning up connection", { connectionId });
      if (ws.readyState === WebSocket.OPEN) {
        this.callbacks.log("Sending pause message", { connectionId });
        ws.send(
          ConnectMessage.encode(
            ConnectMessage.create({
              kind: GatewayMessageType.WORKER_PAUSE,
            }),
          ).finish(),
        );
      }

      this.callbacks.log("Closing connection", { connectionId });
      ws.onerror = () => {};
      ws.onclose = () => {};

      await this.inProgressRequests.wg.wait();

      ws.close(
        1000,
        workerDisconnectReasonToJSON(WorkerDisconnectReason.WORKER_SHUTDOWN),
      );

      if (this.currentConnection?.id === connectionId) {
        this.currentConnection = undefined;
      }

      this.callbacks.log("Cleaning up worker heartbeat", { connectionId });
      clearInterval(heartbeatInterval);
    };

    return conn;
  }
}
