/**
 * Shared connection core logic used by both SameThreadStrategy and
 * WorkerThreadStrategy.
 *
 * This module extracts the common WebSocket connection management, handshake,
 * heartbeat, lease extension, and reconnection logic.
 */

import { WaitGroup } from "@jpwilliams/waitgroup";
import ms from "ms";
import { headerKeys } from "../../../../helpers/consts.ts";
import { allProcessEnv, getPlatformName } from "../../../../helpers/env.ts";
import { resolveApiBaseUrl } from "../../../../helpers/url.ts";
import type { Logger } from "../../../../middleware/logger.ts";
import {
  ConnectMessage,
  GatewayConnectionReadyData,
  type GatewayExecutorRequestData,
  GatewayMessageType,
  gatewayMessageTypeToJSON,
  WorkerConnectRequestData,
  WorkerDisconnectReason,
  WorkerRequestAckData,
  WorkerRequestExtendLeaseAckData,
  WorkerRequestExtendLeaseData,
  workerDisconnectReasonToJSON,
} from "../../../../proto/src/components/connect/protobuf/connect.ts";
import { version } from "../../../../version.ts";
import { ensureUnsharedArrayBuffer } from "../../buffer.ts";
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
import type { BaseConnectionConfig } from "./types.ts";

const ConnectWebSocketProtocol = "v0.connect.inngest.com";

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(String(value));
}

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
 * Extends BaseConnectionConfig with connection-specific options.
 */
export interface ConnectionCoreConfig extends BaseConnectionConfig {
  instanceId?: string;
  maxWorkerConcurrency?: number;
  gatewayUrl?: string;
  appIds: string[];
}

/**
 * Callbacks for connection core events.
 */
export interface ConnectionCoreCallbacks {
  logger: Logger;
  onStateChange: (state: ConnectionState) => void;
  getState: () => ConnectionState;
  handleExecutionRequest: (
    request: GatewayExecutorRequestData,
  ) => Promise<Uint8Array>;
  onReplyAck?: (requestId: string) => void;
  onBufferResponse?: (requestId: string, responseBytes: Uint8Array) => void;
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
    if (state === ConnectionState.CLOSED) {
      throw new Error("Connection already closed");
    }

    this.callbacks.logger.debug({ attempt }, "Establishing connection");

    let useSigningKey = this.config.hashedSigningKey;

    while (true) {
      const currentState = this.callbacks.getState();
      if (currentState === ConnectionState.CLOSED) {
        break;
      }

      // NOTE: We can get here when the state is CLOSING, therefore it's
      // possible to reconnect while the CLOSING. This is intentional so that
      // the worker can reconnect while waiting for pending requests during a
      // graceful shutdown. If we didn't allow reconnect in that case,
      // heartbeats and lease extensions would stop and the Inngest Server would
      // think the worker died.
      //
      // However, the state can be CLOSING during a shutdown without pending
      // requests. The window of that happening is very small, but it's
      // technically possible that we could mistakenly reconnect during a
      // shutdown if the Inngest Server send a drain message.

      // Flush any pending messages before attempting connection
      if (this.callbacks.beforeConnect) {
        await this.callbacks.beforeConnect(useSigningKey);
      }

      try {
        await this.prepareConnection(useSigningKey, attempt, [...path]);
        return;
      } catch (err) {
        this.callbacks.logger.warn({ err: toError(err) }, "Failed to connect");

        if (!(err instanceof ReconnectError)) {
          throw err;
        }

        attempt = err.attempt;

        if (err instanceof AuthError) {
          const switchToFallback =
            useSigningKey === this.config.hashedSigningKey;
          if (switchToFallback) {
            this.callbacks.logger.debug("Switching to fallback signing key");
          }
          useSigningKey = switchToFallback
            ? this.config.hashedFallbackKey
            : this.config.hashedSigningKey;
        }

        if (err instanceof ConnectionLimitError) {
          this.callbacks.logger.error(
            "You have reached the maximum number of concurrent connections. Please disconnect other active workers to continue.",
          );
        }

        const delay = expBackoff(attempt);
        this.callbacks.logger.debug({ delay }, "Reconnecting");

        const cancelled = await waitWithCancel(delay, () => {
          return this.callbacks.getState() === ConnectionState.CLOSED;
        });
        if (cancelled) {
          this.callbacks.logger.debug("Reconnect backoff cancelled");
          break;
        }

        attempt++;
      }
    }

    this.callbacks.logger.debug("Exiting connect loop");
  }

  /**
   * Clean up the current connection.
   */
  async cleanup(): Promise<void> {
    const conn = this.currentConnection;
    if (conn) {
      await conn.cleanup();
      // Only clear if the connection hasn't been replaced during cleanup
      // (e.g. by a drain reconnect while waiting for in-flight requests).
      if (this.currentConnection === conn) {
        this.currentConnection = undefined;
      }
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

    if (this.config.envName) {
      headers[headerKeys.Environment] = this.config.envName;
    }

    const targetUrl = new URL("/v0/connect/start", await this.getApiBaseUrl());

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
            this.config.envName ? ` (env: ${this.config.envName})` : ""
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

    this.callbacks.logger.debug({ attempt, path }, "Preparing connection");

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

    const finalEndpoint = this.config.gatewayUrl || startResp.gatewayEndpoint;
    if (finalEndpoint !== startResp.gatewayEndpoint) {
      this.callbacks.logger.debug(
        { original: startResp.gatewayEndpoint, override: finalEndpoint },
        "Overriding gateway endpoint",
      );
    }

    this.callbacks.logger.debug(
      {
        endpoint: finalEndpoint,
        gatewayGroup: startResp.gatewayGroup,
        connectionId,
      },
      "Connecting to gateway",
    );

    const ws = new WebSocket(finalEndpoint, [ConnectWebSocketProtocol]);
    ws.binaryType = "arraybuffer";

    let onConnectionError: (error: unknown) => void | Promise<void>;
    {
      onConnectionError = (error: unknown) => {
        if (closed) {
          this.callbacks.logger.debug(
            { connectionId },
            "Connection error while initializing but already in closed state, skipping",
          );
          return;
        }
        closed = true;

        this.callbacks.logger.debug(
          { connectionId },
          "Connection error in connecting state, rejecting promise",
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

      this.callbacks.logger.debug(
        { kind: gatewayMessageTypeToJSON(connectMessage.kind), connectionId },
        "Received message",
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
          environment: this.config.envName,
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
          ensureUnsharedArrayBuffer(
            ConnectMessage.encode(
              ConnectMessage.create({
                kind: GatewayMessageType.WORKER_CONNECT,
                payload: workerConnectRequestMsgBytes,
              }),
            ).finish(),
          ),
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

      this.callbacks.logger.warn(
        {
          kind: gatewayMessageTypeToJSON(connectMessage.kind),
          rawKind: connectMessage.kind,
          attempt,
          setupState,
          state: this.callbacks.getState(),
          connectionId,
        },
        "Unexpected message type during setup",
      );
    };

    await websocketConnectedPromise;

    clearTimeout(connectTimeout);

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

    // Set state to ACTIVE after currentConnection is set, so that
    // connectionId is available in the onStateChange callback.
    this.callbacks.onStateChange(ConnectionState.ACTIVE);

    let isDraining = false;
    {
      onConnectionError = async (error: unknown) => {
        if (closed) {
          this.callbacks.logger.debug(
            { connectionId },
            "Connection error but already in closed state, skipping",
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
          this.callbacks.logger.debug(
            { connectionId },
            "Connection error but already closing or closed, skipping",
          );
          return;
        }

        this.callbacks.onStateChange(ConnectionState.RECONNECTING);
        this.excludeGateways.add(startResp.gatewayGroup);

        if (isDraining) {
          this.callbacks.logger.debug(
            { connectionId },
            "Connection error but already draining, skipping",
          );
          return;
        }

        this.callbacks.logger.warn(
          {
            connectionId,
            err: toError(error),
          },
          "Connection error",
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
        this.callbacks.logger.info(
          { connectionId },
          "Received draining message",
        );
        try {
          this.callbacks.logger.debug(
            { connectionId },
            "Setting up new connection while keeping previous connection open",
          );

          await this.connect(0, [...path]);
          await conn.cleanup();
        } catch (err) {
          this.callbacks.logger.warn(
            {
              connectionId,
              err: toError(err),
            },
            "Failed to reconnect after receiving draining message",
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
        this.callbacks.logger.debug(
          { connectionId },
          "Handled gateway heartbeat",
        );
        return;
      }

      if (connectMessage.kind === GatewayMessageType.GATEWAY_EXECUTOR_REQUEST) {
        const currentState = this.callbacks.getState();
        if (currentState !== ConnectionState.ACTIVE) {
          this.callbacks.logger.warn(
            { connectionId },
            "Received request while not active, skipping",
          );
          return;
        }

        const gatewayExecutorRequest = parseGatewayExecutorRequest(
          connectMessage.payload,
        );

        this.callbacks.logger.debug(
          {
            requestId: gatewayExecutorRequest.requestId,
            appId: gatewayExecutorRequest.appId,
            appName: gatewayExecutorRequest.appName,
            functionSlug: gatewayExecutorRequest.functionSlug,
            stepId: gatewayExecutorRequest.stepId,
            connectionId,
          },
          "Received gateway executor request",
        );

        if (
          typeof gatewayExecutorRequest.appName !== "string" ||
          gatewayExecutorRequest.appName.length === 0
        ) {
          this.callbacks.logger.warn(
            {
              requestId: gatewayExecutorRequest.requestId,
              appId: gatewayExecutorRequest.appId,
              functionSlug: gatewayExecutorRequest.functionSlug,
              stepId: gatewayExecutorRequest.stepId,
              connectionId,
            },
            "No app name in request, skipping",
          );
          return;
        }

        if (!this.config.appIds.includes(gatewayExecutorRequest.appName)) {
          this.callbacks.logger.warn(
            {
              requestId: gatewayExecutorRequest.requestId,
              appId: gatewayExecutorRequest.appId,
              appName: gatewayExecutorRequest.appName,
              functionSlug: gatewayExecutorRequest.functionSlug,
              stepId: gatewayExecutorRequest.stepId,
              connectionId,
            },
            "No request handler found for app, skipping",
          );
          return;
        }

        // Send ACK
        ws.send(
          ensureUnsharedArrayBuffer(
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
          ),
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

          // Use the current live connection's WebSocket for lease
          // extensions. During a drain, the original WebSocket may be
          // closed by the gateway while the request is still in flight,
          // causing lease extension messages to silently fail and the
          // gateway to time out the request.
          const latestConn = {
            ws: this.currentConnection?.ws ?? ws,
            id: this.currentConnection?.id ?? connectionId,
          };

          this.callbacks.logger.debug(
            { connectionId: latestConn.id, leaseId: currentLeaseId },
            "Extending lease",
          );

          if (latestConn.ws.readyState !== WebSocket.OPEN) {
            this.callbacks.logger.warn(
              {
                connectionId: latestConn.id,
                requestId: gatewayExecutorRequest.requestId,
              },
              "Cannot extend lease, no open WebSocket available",
            );
            return;
          }

          latestConn.ws.send(
            ensureUnsharedArrayBuffer(
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
            ),
          );
        }, extendLeaseIntervalMs);

        try {
          // Handle execution via callback
          const responseBytes = await this.callbacks.handleExecutionRequest(
            gatewayExecutorRequest,
          );

          if (!this.currentConnection) {
            this.callbacks.logger.warn(
              { requestId: gatewayExecutorRequest.requestId },
              "No current WebSocket, buffering response",
            );
            if (this.callbacks.onBufferResponse) {
              this.callbacks.onBufferResponse(
                gatewayExecutorRequest.requestId,
                responseBytes,
              );
            }
            return;
          }

          this.callbacks.logger.debug(
            {
              connectionId: this.currentConnection.id,
              requestId: gatewayExecutorRequest.requestId,
            },
            "Sending worker reply",
          );

          this.currentConnection.ws.send(
            ensureUnsharedArrayBuffer(
              ConnectMessage.encode(
                ConnectMessage.create({
                  kind: GatewayMessageType.WORKER_REPLY,
                  payload: responseBytes,
                }),
              ).finish(),
            ),
          );
        } catch (err) {
          this.callbacks.logger.debug(
            {
              requestId: gatewayExecutorRequest.requestId,
              err: toError(err),
            },
            "Execution error",
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

        this.callbacks.logger.debug(
          { connectionId, requestId: replyAck.requestId },
          "Acknowledging reply ack",
        );

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

        this.callbacks.logger.debug(
          { connectionId, newLeaseId: extendLeaseAck.newLeaseId },
          "Received extend lease ack",
        );

        if (extendLeaseAck.newLeaseId) {
          this.inProgressRequests.requestLeases[extendLeaseAck.requestId] =
            extendLeaseAck.newLeaseId;
        } else {
          this.callbacks.logger.warn(
            { connectionId, requestId: extendLeaseAck.requestId },
            "Unable to extend lease",
          );
          delete this.inProgressRequests.requestLeases[
            extendLeaseAck.requestId
          ];
        }

        return;
      }

      this.callbacks.logger.warn(
        {
          kind: gatewayMessageTypeToJSON(connectMessage.kind),
          rawKind: connectMessage.kind,
          attempt,
          setupState,
          state: this.callbacks.getState(),
          connectionId,
        },
        "Unexpected message type",
      );
    };

    // Heartbeat interval
    let heartbeatInterval: NodeJS.Timeout | undefined;
    if (heartbeatIntervalMs !== undefined) {
      heartbeatInterval = setInterval(() => {
        if (heartbeatIntervalMs === undefined) {
          return;
        }

        // Skip heartbeat ticks when the WebSocket is no longer open. During
        // drain the Gateway may close the old WS while in-flight requests are
        // still running. Sending on a closed socket is a no-op and we must not
        // treat the missing response as a failure.
        //
        // This is safe because each connection gets its own heartbeat
        // interval. Once we reconnect, we can safely skip the old WS
        // heartbeats because the new WS is heartbeating.
        //
        // TODO: We need a better way to handle this. This isn't a horrible
        // hack, but it isn't ideal. Over the life of a worker, it'll have N-1
        // noop heartbeat intervals, where N is the number of times it
        // reconnected.
        if (ws.readyState !== WebSocket.OPEN) {
          return;
        }

        if (conn.pendingHeartbeats >= 2) {
          this.callbacks.logger.warn(
            { connectionId },
            "Gateway heartbeat missed",
          );
          void onConnectionError(
            new ReconnectError(
              `Consecutive gateway heartbeats missed (${connectionId})`,
              attempt,
            ),
          );
          return;
        }

        this.callbacks.logger.debug(
          { connectionId },
          "Sending worker heartbeat",
        );

        conn.pendingHeartbeats++;
        ws.send(
          ensureUnsharedArrayBuffer(
            ConnectMessage.encode(
              ConnectMessage.create({
                kind: GatewayMessageType.WORKER_HEARTBEAT,
              }),
            ).finish(),
          ),
        );
      }, heartbeatIntervalMs);
    }

    conn.cleanup = async () => {
      if (closed) {
        return;
      }
      closed = true;

      this.callbacks.logger.debug({ connectionId }, "Cleaning up connection");
      if (ws.readyState === WebSocket.OPEN) {
        this.callbacks.logger.debug({ connectionId }, "Sending pause message");
        ws.send(
          ensureUnsharedArrayBuffer(
            ConnectMessage.encode(
              ConnectMessage.create({
                kind: GatewayMessageType.WORKER_PAUSE,
              }),
            ).finish(),
          ),
        );
      }

      this.callbacks.logger.debug({ connectionId }, "Closing connection");
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

      this.callbacks.logger.debug(
        { connectionId },
        "Cleaning up worker heartbeat",
      );
      clearInterval(heartbeatInterval);
    };

    return conn;
  }

  async getApiBaseUrl(): Promise<string> {
    return resolveApiBaseUrl({
      apiBaseUrl: this.config.apiBaseUrl,
      mode: this.config.mode,
    });
  }
}
