/**
 * Shared connection core logic used by both SameThreadStrategy and
 * WorkerThreadStrategy.
 *
 * This module uses a **reconcile loop** that continuously ensures a live
 * WebSocket connection is open. Reconnection, drain, and shutdown are
 * expressed as state changes that wake the loop rather than recursive
 * calls or callback-driven control flow.
 *
 * Domain-specific logic is delegated to focused sub-modules:
 * - {@link HeartbeatManager} — periodic heartbeat pings
 * - {@link RequestProcessor} — executor requests, lease extensions, reply ACKs
 * - {@link establishConnection} — HTTP start + WebSocket handshake
 */

import { WaitGroup } from "@jpwilliams/waitgroup";
import { resolveApiBaseUrl } from "../../../../helpers/url.ts";
import type { Logger } from "../../../../middleware/logger.ts";
import type { GatewayExecutorRequestData } from "../../../../proto/src/components/connect/protobuf/connect.ts";
import {
  ConnectMessage,
  GatewayMessageType,
  gatewayMessageTypeToJSON,
} from "../../../../proto/src/components/connect/protobuf/connect.ts";
import { ensureUnsharedArrayBuffer } from "../../buffer.ts";
import { parseConnectMessage } from "../../messages.ts";
import {
  type ConnectDebugState,
  ConnectionState,
  type InFlightRequest,
} from "../../types.ts";
import {
  AuthError,
  ConnectionLimitError,
  expBackoff,
  ReconnectError,
  waitWithCancel,
} from "../../util.ts";
import { establishConnection } from "./handshake.ts";
import { HeartbeatManager } from "./heartbeat.ts";
import { RequestProcessor } from "./requestProcessor.ts";
import { StatusReporter } from "./statusReporter.ts";
import type { BaseConnectionConfig } from "./types.ts";

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
  statusIntervalMs: number;
  /** Timestamp (ms) when the connection was established. */
  connectedAt: number;
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
  onConnectionActive?: (signingKey: string | undefined) => void;
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

  // Exposed via ConnectionAccessor for sub-modules
  private _activeConnection: Connection | undefined;
  private _drainingConnection: Connection | undefined;
  private _shutdownRequested = false;
  private _inProgressRequests: {
    wg: WaitGroup;
    requestLeases: Record<string, string>;
    requestMeta: Record<string, InFlightRequest>;
  } = {
      wg: new WaitGroup(),
      requestLeases: {},
      requestMeta: {},
    };

  private _lastHeartbeatSentAt: number | undefined;
  private _lastHeartbeatReceivedAt: number | undefined;
  private _lastMessageReceivedAt: number | undefined;

  private excludeGateways: Set<string> = new Set();

  // Wake signal for the reconcile loop
  private wakeSignal: { promise: Promise<void>; resolve: () => void };

  // Whether we've ever successfully connected (used to distinguish
  // CONNECTING from RECONNECTING state transitions).
  private hasConnectedBefore = false;

  // Loop promise — resolved when the reconcile loop exits
  private loopPromise: Promise<void> | undefined;

  // First-ready resolution — resolves start() when first connection is ready
  private resolveFirstReady: (() => void) | undefined;
  private rejectFirstReady: ((err: unknown) => void) | undefined;

  // Signing key management
  private useSigningKey: string | undefined;

  // Sub-modules
  private readonly heartbeatManager: HeartbeatManager;
  private readonly statusReporter: StatusReporter;
  private readonly requestProcessor: RequestProcessor;

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

    // Build a ConnectionAccessor view for sub-modules
    const accessor = {
      get activeConnection() {
        return self._activeConnection;
      },
      get drainingConnection() {
        return self._drainingConnection;
      },
      get shutdownRequested() {
        return self._shutdownRequested;
      },
      get inProgressRequests() {
        return self._inProgressRequests;
      },
      get appIds() {
        return self.config.appIds;
      },
    };

    const wakeSignalRef = { wake: () => this.wake() };

    const self = this;

    this.heartbeatManager = new HeartbeatManager(
      accessor,
      wakeSignalRef,
      callbacks.logger,
    );
    this.heartbeatManager.onHeartbeatSent = () => {
      this._lastHeartbeatSentAt = Date.now();
    };

    this.statusReporter = new StatusReporter(accessor, callbacks.logger);

    this.requestProcessor = new RequestProcessor(
      accessor,
      wakeSignalRef,
      callbacks,
      callbacks.logger,
    );
  }

  get connectionId(): string | undefined {
    return this._activeConnection?.id;
  }

  /**
   * Wait for all in-progress requests to complete.
   */
  async waitForInProgress(): Promise<void> {
    await this._inProgressRequests.wg.wait();
  }

  /**
   * Return a snapshot of debug/health information for this connection.
   */
  getDebugState(): ConnectDebugState {
    return {
      state: this.callbacks.getState(),
      activeConnectionId: this._activeConnection?.id,
      drainingConnectionId: this._drainingConnection?.id,
      lastHeartbeatSentAt: this._lastHeartbeatSentAt,
      lastHeartbeatReceivedAt: this._lastHeartbeatReceivedAt,
      lastMessageReceivedAt: this._lastMessageReceivedAt,
      shutdownRequested: this._shutdownRequested,
      inFlightRequestCount: Object.keys(this._inProgressRequests.requestLeases)
        .length,
      inFlightRequests: Object.values(this._inProgressRequests.requestMeta),
    };
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
    const inFlightCount = Object.keys(
      this._inProgressRequests.requestLeases,
    ).length;
    this.callbacks.logger.info(
      { inFlightCount },
      "Shutting down, waiting for in-flight requests",
    );
    this._shutdownRequested = true;

    if (this._activeConnection?.ws.readyState === WebSocket.OPEN) {
      this._activeConnection.ws.send(
        ensureUnsharedArrayBuffer(
          ConnectMessage.encode(
            ConnectMessage.create({
              kind: GatewayMessageType.WORKER_PAUSE,
            }),
          ).finish(),
        ),
      );
      this.callbacks.logger.info(
        { connectionId: this._activeConnection.id },
        "Sent WORKER_PAUSE, draining",
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
    return Object.keys(this._inProgressRequests.requestLeases).length > 0;
  }

  // ---------------------------------------------------------------------------
  // Reconcile loop
  // ---------------------------------------------------------------------------

  private async reconcileLoop(initialAttempt: number): Promise<void> {
    let attempt = initialAttempt;

    while (true) {
      // Exit condition: shutdown requested + no in-flight requests
      if (this._shutdownRequested && !this.hasInFlightRequests()) {
        break;
      }

      // Ensure we have a live connection
      if (!this._activeConnection || this._activeConnection.dead) {
        this.callbacks.logger.debug(
          {
            hasActiveConnection: !!this._activeConnection,
            activeConnectionDead: this._activeConnection?.dead,
            hasDrainingConnection: !!this._drainingConnection,
            drainingConnectionId: this._drainingConnection?.id,
          },
          "No active connection",
        );

        if (this.hasConnectedBefore) {
          this.callbacks.logger.info({ attempt }, "Reconnecting");
        } else {
          this.callbacks.logger.info("Connecting");
        }

        this.callbacks.onStateChange(
          this.hasConnectedBefore
            ? ConnectionState.RECONNECTING
            : ConnectionState.CONNECTING,
        );

        try {
          const { conn, gatewayGroup } = await establishConnection(
            this.config,
            this.useSigningKey,
            attempt,
            this.excludeGateways,
            this.callbacks.logger,
          );

          // Attach post-handshake handlers
          this.attachHandlers(conn, gatewayGroup);

          // Clean up draining connection after new one is ready
          if (this._drainingConnection) {
            this.callbacks.logger.info(
              {
                oldConnectionId: this._drainingConnection.id,
                newConnectionId: conn.id,
              },
              "Replaced draining connection",
            );
            this._drainingConnection.close();
            this._drainingConnection = undefined;
          }

          this._activeConnection = conn;
          this.heartbeatManager.updateInterval(conn.heartbeatIntervalMs);
          this.statusReporter.updateInterval(conn.statusIntervalMs);
          attempt = 0;
          this.hasConnectedBefore = true;
          this.callbacks.logger.info(
            { connectionId: conn.id, gatewayGroup },
            "Connection active",
          );
          this.callbacks.onStateChange(ConnectionState.ACTIVE);

          if (this._shutdownRequested) {
            // Reconnected during shutdown to keep in-flight requests alive.
            // Send WORKER_PAUSE instead of WORKER_READY so no new work is routed.
            conn.ws.send(
              ensureUnsharedArrayBuffer(
                ConnectMessage.encode(
                  ConnectMessage.create({
                    kind: GatewayMessageType.WORKER_PAUSE,
                  }),
                ).finish(),
              ),
            );
            this.callbacks.logger.info(
              { connectionId: conn.id },
              "Sent WORKER_PAUSE on reconnect during shutdown",
            );
          } else {
            // Signal the gateway that we're ready to receive requests.
            // This must happen after ACTIVE so the gateway doesn't route
            // requests before handlers are fully attached.
            conn.ws.send(
              ensureUnsharedArrayBuffer(
                ConnectMessage.encode(
                  ConnectMessage.create({
                    kind: GatewayMessageType.WORKER_READY,
                  }),
                ).finish(),
              ),
            );
          }

          // Flush any buffered responses via HTTP now that we're active.
          this.callbacks.onConnectionActive?.(this.useSigningKey);

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

          // Gateway is draining, we should retry much faster
          if (err.message?.includes("connect_gateway_closing")) {
            const jitter = 500 + Math.random() * 1000;
            this.callbacks.logger.info(
              { attempt, delay: Math.round(jitter), error: err.message },
              "Gateway draining, retrying",
            );
            const cancelled = await waitWithCancel(jitter, () => {
              return this._shutdownRequested && !this.hasInFlightRequests();
            });
            if (cancelled) break;
            continue;
          }

          const delay = expBackoff(attempt);
          this.callbacks.logger.info(
            { attempt, delay },
            "Reconnecting after failure",
          );

          const cancelled = await waitWithCancel(delay, () => {
            return this._shutdownRequested && !this.hasInFlightRequests();
          });
          if (cancelled) break;
          continue;
        }
      }

      // Wait for something to change
      await this.wakeSignal.promise;
      this.callbacks.logger.debug(
        {
          shutdownRequested: this._shutdownRequested,
          hasActiveConnection: !!this._activeConnection,
          activeConnectionDead: this._activeConnection?.dead,
        },
        "Reconcile loop woken",
      );
    }

    // Teardown
    this.heartbeatManager.stop();
    this.statusReporter.stop();
    this._activeConnection?.close();
    this._activeConnection = undefined;
    this._drainingConnection?.close();
    this._drainingConnection = undefined;
  }

  // ---------------------------------------------------------------------------
  // Post-handshake handler attachment
  // ---------------------------------------------------------------------------

  /**
   * Wire up error, close, and message handlers on a newly-handshaked connection.
   */
  private attachHandlers(conn: Connection, gatewayGroup: string): void {
    const { ws } = conn;
    const connectionId = conn.id;

    // Error/close handlers: mark connection as dead and wake the loop
    ws.onerror = (ev) => {
      if (conn.dead) return;
      const uptimeMs = Date.now() - conn.connectedAt;
      this.callbacks.logger.warn(
        { connectionId, gatewayGroup, uptimeMs, error: (ev as ErrorEvent)?.message },
        "Connection lost (error)",
      );
      conn.dead = true;
      this.excludeGateways.add(gatewayGroup);
      if (this._activeConnection?.id === connectionId) {
        this._activeConnection = undefined;
      }
      this.wake();
    };

    ws.onclose = (ev) => {
      if (conn.dead) return;
      const uptimeMs = Date.now() - conn.connectedAt;
      this.callbacks.logger.warn(
        { connectionId, gatewayGroup, uptimeMs, code: ev.code, reason: ev.reason },
        "Connection lost (close)",
      );
      conn.dead = true;
      this.excludeGateways.add(gatewayGroup);
      if (this._activeConnection?.id === connectionId) {
        this._activeConnection = undefined;
      }
      this.wake();
    };

    // Message handler for post-handshake messages
    ws.onmessage = async (event) => {
      this._lastMessageReceivedAt = Date.now();

      const messageBytes = new Uint8Array(event.data as ArrayBuffer);
      const connectMessage = parseConnectMessage(messageBytes);

      if (connectMessage.kind === GatewayMessageType.GATEWAY_CLOSING) {
        const uptimeMs = Date.now() - conn.connectedAt;
        this.callbacks.logger.info(
          { connectionId: conn.id, gatewayGroup, uptimeMs },
          "Gateway draining, opening new connection",
        );
        // Move current connection to draining, clear active so the loop
        // establishes a replacement.
        this._drainingConnection = this._activeConnection;
        this._activeConnection = undefined;
        this.wake();
        return;
      }

      if (connectMessage.kind === GatewayMessageType.GATEWAY_HEARTBEAT) {
        this._lastHeartbeatReceivedAt = Date.now();
        conn.pendingHeartbeats = 0;
        this.callbacks.logger.debug(
          { connectionId },
          "Handled gateway heartbeat",
        );
        return;
      }

      if (connectMessage.kind === GatewayMessageType.GATEWAY_EXECUTOR_REQUEST) {
        await this.requestProcessor.handleExecutorRequest(connectMessage, conn);
        return;
      }

      if (connectMessage.kind === GatewayMessageType.WORKER_REPLY_ACK) {
        this.requestProcessor.handleReplyAck(connectMessage, connectionId);
        return;
      }

      if (
        connectMessage.kind ===
        GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE_ACK
      ) {
        this.requestProcessor.handleExtendLeaseAck(
          connectMessage,
          connectionId,
        );
        return;
      }

      this.callbacks.logger.warn(
        {
          kind: gatewayMessageTypeToJSON(connectMessage.kind),
          rawKind: connectMessage.kind,
          state: this.callbacks.getState(),
          connectionId,
        },
        "Unexpected message type",
      );
    };
  }
}
