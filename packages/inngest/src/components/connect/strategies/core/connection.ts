/**
 * Shared connection core logic used by both SameThreadStrategy and
 * WorkerThreadStrategy.
 *
 * This module uses a **reconcile loop** that continuously ensures a live
 * WebSocket connection is open. Reconnection, drain, and shutdown are
 * expressed as state changes that wake the loop rather than recursive
 * calls or callback-driven control flow.
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
  pendingHeartbeats: number;
  /** When true the connection is considered unusable and the reconcile loop
   *  will establish a replacement. */
  dead: boolean;
  heartbeatIntervalMs: number;
  extendLeaseIntervalMs: number;
  /** Disable all handlers and close the underlying WebSocket. */
  close(): void;
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
 *
 * Uses a reconcile loop that:
 * - Ensures a WebSocket connection is always open
 * - Manages a single heartbeat interval targeting the active connection
 * - Handles reconnection, drain, and shutdown as state changes
 */
export class ConnectionCore {
  private config: ConnectionCoreConfig;
  private callbacks: ConnectionCoreCallbacks;

  private activeConnection: Connection | undefined;
  private drainingConnection: Connection | undefined;
  private excludeGateways: Set<string> = new Set();

  private inProgressRequests: {
    wg: WaitGroup;
    requestLeases: Record<string, string>;
  } = {
    wg: new WaitGroup(),
    requestLeases: {},
  };

  // Wake signal for the reconcile loop
  private wakeSignal: { promise: Promise<void>; resolve: () => void };

  // Shutdown state
  private shutdownRequested = false;

  // Whether we've ever successfully connected (used to distinguish
  // CONNECTING from RECONNECTING state transitions).
  private hasConnectedBefore = false;

  // Heartbeat state (single interval for the active connection)
  private heartbeatInterval: ReturnType<typeof setInterval> | undefined;
  private heartbeatIntervalMs = 10_000;

  // Loop promise — resolved when the reconcile loop exits
  private loopPromise: Promise<void> | undefined;

  // First-ready resolution — resolves start() when first connection is ready
  private resolveFirstReady: (() => void) | undefined;
  private rejectFirstReady: ((err: unknown) => void) | undefined;

  // Signing key management
  private useSigningKey: string | undefined;

  constructor(
    config: ConnectionCoreConfig,
    callbacks: ConnectionCoreCallbacks,
  ) {
    this.config = config;
    this.callbacks = callbacks;
    this.useSigningKey = config.hashedSigningKey;

    // Initialize the wake signal
    let resolve: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this.wakeSignal = { promise, resolve: resolve! };
  }

  get connectionId(): string | undefined {
    return this.activeConnection?.id;
  }

  /**
   * Wait for all in-progress requests to complete.
   */
  async waitForInProgress(): Promise<void> {
    await this.inProgressRequests.wg.wait();
  }

  /**
   * Start the reconcile loop. Resolves when the first connection is active.
   * The loop continues running in the background.
   */
  async start(attempt = 0): Promise<void> {
    if (typeof WebSocket === "undefined") {
      throw new Error("WebSockets not supported in current environment");
    }

    const state = this.callbacks.getState();
    if (state === ConnectionState.CLOSED) {
      throw new Error("Connection already closed");
    }

    this.callbacks.logger.info("Establishing connection");

    const firstReadyPromise = new Promise<void>((resolve, reject) => {
      this.resolveFirstReady = resolve;
      this.rejectFirstReady = reject;
    });

    this.loopPromise = this.reconcileLoop(attempt);

    // If the loop ends before firstReady resolves, propagate any error
    this.loopPromise.catch((err) => {
      this.rejectFirstReady?.(err);
    });

    await firstReadyPromise;
  }

  /**
   * Request graceful shutdown. Resolves when fully closed (in-flight done,
   * connection closed).
   */
  async close(): Promise<void> {
    this.callbacks.logger.info("Shutting down, waiting for in-flight requests");
    this.shutdownRequested = true;

    if (this.activeConnection?.ws.readyState === WebSocket.OPEN) {
      this.activeConnection.ws.send(
        ensureUnsharedArrayBuffer(
          ConnectMessage.encode(
            ConnectMessage.create({
              kind: GatewayMessageType.WORKER_PAUSE,
            }),
          ).finish(),
        ),
      );
    }

    this.wake();

    if (this.loopPromise) {
      await this.loopPromise;
    }

    this.callbacks.logger.info("Connection closed");
  }

  async getApiBaseUrl(): Promise<string> {
    return resolveApiBaseUrl({
      apiBaseUrl: this.config.apiBaseUrl,
      mode: this.config.mode,
    });
  }

  // ---------------------------------------------------------------------------
  // Wake signal
  // ---------------------------------------------------------------------------

  private resetWakeSignal(): void {
    let resolve: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this.wakeSignal = { promise, resolve: resolve! };
  }

  private wake(): void {
    this.wakeSignal.resolve();
    this.resetWakeSignal();
  }

  // ---------------------------------------------------------------------------
  // Heartbeat management (single interval)
  // ---------------------------------------------------------------------------

  private startHeartbeat(): void {
    if (this.heartbeatInterval) return;
    this.heartbeatInterval = setInterval(
      () => this.tick(),
      this.heartbeatIntervalMs,
    );
  }

  private stopHeartbeat(): void {
    clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = undefined;
  }

  private updateHeartbeatInterval(intervalMs: number): void {
    if (intervalMs === this.heartbeatIntervalMs && this.heartbeatInterval)
      return;
    this.heartbeatIntervalMs = intervalMs;
    this.stopHeartbeat();
    this.startHeartbeat();
  }

  private tick(): void {
    const conn = this.activeConnection;
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return;

    if (conn.pendingHeartbeats >= 2) {
      this.callbacks.logger.warn(
        { connectionId: conn.id },
        "Consecutive heartbeats missed, reconnecting",
      );
      conn.dead = true;
      this.wake();
      return;
    }

    conn.pendingHeartbeats++;
    conn.ws.send(
      ensureUnsharedArrayBuffer(
        ConnectMessage.encode(
          ConnectMessage.create({
            kind: GatewayMessageType.WORKER_HEARTBEAT,
          }),
        ).finish(),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Signing key management
  // ---------------------------------------------------------------------------

  private switchAuthKey(): void {
    const switchToFallback =
      this.useSigningKey === this.config.hashedSigningKey;
    if (switchToFallback) {
      this.callbacks.logger.debug("Switching to fallback signing key");
    }
    this.useSigningKey = switchToFallback
      ? this.config.hashedFallbackKey
      : this.config.hashedSigningKey;
  }

  // ---------------------------------------------------------------------------
  // In-flight helpers
  // ---------------------------------------------------------------------------

  private hasInFlightRequests(): boolean {
    return Object.keys(this.inProgressRequests.requestLeases).length > 0;
  }

  // ---------------------------------------------------------------------------
  // Reconcile loop
  // ---------------------------------------------------------------------------

  private async reconcileLoop(initialAttempt: number): Promise<void> {
    let attempt = initialAttempt;

    while (true) {
      // Exit condition: shutdown requested + no in-flight requests
      if (this.shutdownRequested && !this.hasInFlightRequests()) {
        break;
      }

      // Ensure we have a live connection
      if (!this.activeConnection || this.activeConnection.dead) {
        this.callbacks.onStateChange(
          this.hasConnectedBefore
            ? ConnectionState.RECONNECTING
            : ConnectionState.CONNECTING,
        );

        try {
          // Flush any pending messages before attempting connection
          if (this.callbacks.beforeConnect) {
            await this.callbacks.beforeConnect(this.useSigningKey);
          }

          const conn = await this.establishConnection(
            this.useSigningKey,
            attempt,
          );

          // Clean up draining connection after new one is ready
          if (this.drainingConnection) {
            this.callbacks.logger.info(
              {
                oldConnectionId: this.drainingConnection.id,
                newConnectionId: conn.id,
              },
              "Replaced draining connection",
            );
            this.drainingConnection.close();
            this.drainingConnection = undefined;
          }

          this.activeConnection = conn;
          this.updateHeartbeatInterval(conn.heartbeatIntervalMs);
          attempt = 0;
          this.hasConnectedBefore = true;
          this.callbacks.onStateChange(ConnectionState.ACTIVE);
          this.resolveFirstReady?.();
          this.resolveFirstReady = undefined;
          this.rejectFirstReady = undefined;
        } catch (err) {
          if (!(err instanceof ReconnectError)) throw err;

          attempt = err.attempt + 1;
          if (err instanceof AuthError) this.switchAuthKey();
          if (err instanceof ConnectionLimitError) {
            this.callbacks.logger.error("Max concurrent connections reached");
          }

          const delay = expBackoff(attempt);
          this.callbacks.logger.info(
            { attempt, delay },
            "Reconnecting after failure",
          );

          const cancelled = await waitWithCancel(delay, () => {
            return this.shutdownRequested && !this.hasInFlightRequests();
          });
          if (cancelled) break;
          continue;
        }
      }

      // Wait for something to change
      await this.wakeSignal.promise;
    }

    // Teardown
    this.stopHeartbeat();
    this.activeConnection?.close();
    this.activeConnection = undefined;
    this.drainingConnection?.close();
    this.drainingConnection = undefined;
  }

  // ---------------------------------------------------------------------------
  // Connection establishment
  // ---------------------------------------------------------------------------

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

  private async establishConnection(
    hashedSigningKey: string | undefined,
    attempt: number,
  ): Promise<Connection> {
    this.callbacks.logger.debug({ attempt }, "Preparing connection");

    const startedAt = new Date();
    const startResp = await this.sendStartRequest(hashedSigningKey, attempt);

    const connectionId = startResp.connectionId;

    let resolveWsConnected: (() => void) | undefined;
    let rejectWsConnected: ((reason?: unknown) => void) | undefined;
    const wsConnectedPromise = new Promise<void>((resolve, reject) => {
      resolveWsConnected = resolve;
      rejectWsConnected = reject;
    });

    const connectTimeout = setTimeout(() => {
      this.excludeGateways.add(startResp.gatewayGroup);
      rejectWsConnected?.(
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

    // Track whether we've rejected/resolved the handshake promise so we
    // don't double-settle from concurrent error/close events.
    let settled = false;

    const rejectHandshake = (error: unknown) => {
      if (settled) return;
      settled = true;

      this.excludeGateways.add(startResp.gatewayGroup);
      clearTimeout(connectTimeout);

      ws.onerror = () => {};
      ws.onclose = () => {};
      ws.close(
        4001,
        workerDisconnectReasonToJSON(WorkerDisconnectReason.UNEXPECTED),
      );

      rejectWsConnected?.(
        new ReconnectError(
          `Error while connecting (${connectionId}): ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
          attempt,
        ),
      );
    };

    ws.onerror = (err) => rejectHandshake(err);
    ws.onclose = (ev) => {
      rejectHandshake(
        new ReconnectError(
          `Connection ${connectionId} closed: ${ev.reason}`,
          attempt,
        ),
      );
    };

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
          rejectHandshake(
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
          rejectHandshake(
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

        resolveWsConnected?.();
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

    await wsConnectedPromise;

    clearTimeout(connectTimeout);
    this.excludeGateways.delete(startResp.gatewayGroup);

    // Build the Connection object
    const conn: Connection = {
      id: connectionId,
      ws,
      pendingHeartbeats: 0,
      dead: false,
      heartbeatIntervalMs: heartbeatIntervalMs ?? 10_000,
      extendLeaseIntervalMs: extendLeaseIntervalMs ?? 5_000,
      close: () => {
        if (conn.dead) return;
        conn.dead = true;
        ws.onerror = () => {};
        ws.onclose = () => {};
        ws.close();
      },
    };

    this.callbacks.logger.info(
      { connectionId, gatewayGroup: startResp.gatewayGroup },
      "Connection established",
    );

    // ----- Post-handshake handlers -----

    // Error/close handlers: mark connection as dead and wake the loop
    ws.onerror = () => {
      if (conn.dead) return;
      this.callbacks.logger.warn({ connectionId }, "Connection lost");
      conn.dead = true;
      this.excludeGateways.add(startResp.gatewayGroup);
      if (this.activeConnection?.id === connectionId) {
        this.activeConnection = undefined;
      }
      this.wake();
    };
    ws.onclose = (ev) => {
      if (conn.dead) return;
      this.callbacks.logger.warn(
        { connectionId, reason: ev.reason },
        "Connection lost",
      );
      conn.dead = true;
      this.excludeGateways.add(startResp.gatewayGroup);
      if (this.activeConnection?.id === connectionId) {
        this.activeConnection = undefined;
      }
      this.wake();
    };

    // Message handler for post-handshake messages
    ws.onmessage = async (event) => {
      const messageBytes = new Uint8Array(event.data as ArrayBuffer);
      const connectMessage = parseConnectMessage(messageBytes);

      if (connectMessage.kind === GatewayMessageType.GATEWAY_CLOSING) {
        this.callbacks.logger.info(
          { connectionId: conn.id },
          "Gateway draining, opening new connection",
        );
        // Move current connection to draining, clear active so the loop
        // establishes a replacement.
        this.drainingConnection = this.activeConnection;
        this.activeConnection = undefined;
        this.wake();
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
        let extendLeaseInterval: ReturnType<typeof setInterval> | undefined;
        extendLeaseInterval = setInterval(() => {
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
          // closed by the gateway while the request is still in flight.
          const latestConn = {
            ws: this.activeConnection?.ws ?? ws,
            id: this.activeConnection?.id ?? connectionId,
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
        }, conn.extendLeaseIntervalMs);

        try {
          const responseBytes = await this.callbacks.handleExecutionRequest(
            gatewayExecutorRequest,
          );

          if (!this.activeConnection) {
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
              connectionId: this.activeConnection.id,
              requestId: gatewayExecutorRequest.requestId,
            },
            "Sending worker reply",
          );

          this.activeConnection.ws.send(
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

          // Wake the loop if shutdown is pending and this was the last request
          if (this.shutdownRequested && !this.hasInFlightRequests()) {
            this.wake();
          }
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
          state: this.callbacks.getState(),
          connectionId,
        },
        "Unexpected message type",
      );
    };

    return conn;
  }
}
