/**
 * Processes incoming executor requests, manages lease extensions, and handles
 * reply acknowledgements.
 *
 * Extracted from ConnectionCore so the reconcile loop orchestrator only
 * dispatches messages to this module rather than containing the full
 * execution flow inline.
 */

import type { Logger } from "../../../../middleware/logger.ts";
import {
  ConnectMessage,
  type ConnectMessage as ConnectMessageType,
  GatewayMessageType,
  WorkerRequestAckData,
  WorkerRequestExtendLeaseAckData,
  WorkerRequestExtendLeaseData,
} from "../../../../proto/src/components/connect/protobuf/connect.ts";
import { ensureUnsharedArrayBuffer } from "../../buffer.ts";
import {
  parseGatewayExecutorRequest,
  parseWorkerReplyAck,
} from "../../messages.ts";
import { ConnectionState } from "../../types.ts";
import type { Connection, ConnectionCoreCallbacks } from "./connection.ts";
import type { ConnectionAccessor, WakeSignal } from "./types.ts";

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(String(value));
}

export class RequestProcessor {
  constructor(
    private readonly accessor: ConnectionAccessor,
    private readonly wakeSignal: WakeSignal,
    private readonly callbacks: ConnectionCoreCallbacks,
    private readonly logger: Logger,
  ) {}

  /** Handle an incoming executor request. */
  async handleExecutorRequest(
    connectMessage: ConnectMessageType,
    conn: Connection,
  ): Promise<void> {
    const currentState = this.callbacks.getState();
    if (currentState !== ConnectionState.ACTIVE) {
      this.logger.warn(
        { connectionId: conn.id },
        "Received request while not active, skipping",
      );
      return;
    }

    const gatewayExecutorRequest = parseGatewayExecutorRequest(
      connectMessage.payload,
    );

    this.logger.debug(
      {
        requestId: gatewayExecutorRequest.requestId,
        appId: gatewayExecutorRequest.appId,
        appName: gatewayExecutorRequest.appName,
        functionSlug: gatewayExecutorRequest.functionSlug,
        stepId: gatewayExecutorRequest.stepId,
        connectionId: conn.id,
      },
      "Received gateway executor request",
    );

    if (
      typeof gatewayExecutorRequest.appName !== "string" ||
      gatewayExecutorRequest.appName.length === 0
    ) {
      this.logger.warn(
        {
          requestId: gatewayExecutorRequest.requestId,
          appId: gatewayExecutorRequest.appId,
          functionSlug: gatewayExecutorRequest.functionSlug,
          stepId: gatewayExecutorRequest.stepId,
          connectionId: conn.id,
        },
        "No app name in request, skipping",
      );
      return;
    }

    if (!this.accessor.appIds.includes(gatewayExecutorRequest.appName)) {
      this.logger.warn(
        {
          requestId: gatewayExecutorRequest.requestId,
          appId: gatewayExecutorRequest.appId,
          appName: gatewayExecutorRequest.appName,
          functionSlug: gatewayExecutorRequest.functionSlug,
          stepId: gatewayExecutorRequest.stepId,
          connectionId: conn.id,
        },
        "No request handler found for app, skipping",
      );
      return;
    }

    // Send ACK
    conn.ws.send(
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

    this.accessor.inProgressRequests.wg.add(1);
    this.accessor.inProgressRequests.requestLeases[
      gatewayExecutorRequest.requestId
    ] = gatewayExecutorRequest.leaseId;
    const leaseAcquiredAt = Date.now();
    this.accessor.inProgressRequests.requestMeta[
      gatewayExecutorRequest.requestId
    ] = {
      requestId: gatewayExecutorRequest.requestId,
      runId: gatewayExecutorRequest.runId,
      stepId: gatewayExecutorRequest.stepId,
      appId: gatewayExecutorRequest.appId,
      envId: gatewayExecutorRequest.envId,
      functionSlug: gatewayExecutorRequest.functionSlug,
      accountId: gatewayExecutorRequest.accountId,
      leaseAcquiredAt,
      leaseLastExtendedAt: leaseAcquiredAt,
    };

    const inFlightCount = Object.keys(
      this.accessor.inProgressRequests.requestLeases,
    ).length;
    this.logger.debug(
      {
        requestId: gatewayExecutorRequest.requestId,
        functionSlug: gatewayExecutorRequest.functionSlug,
        inFlightCount,
      },
      "Request acknowledged",
    );

    const startedAt = Date.now();

    // Start lease extension interval
    const originalWs = conn.ws;
    const originalConnectionId = conn.id;
    let extendLeaseInterval: ReturnType<typeof setInterval> | undefined;
    extendLeaseInterval = setInterval(() => {
      const currentLeaseId =
        this.accessor.inProgressRequests.requestLeases[
          gatewayExecutorRequest.requestId
        ];
      if (!currentLeaseId) {
        clearInterval(extendLeaseInterval);
        return;
      }

      // Use the current live connection's WebSocket for lease extensions.
      // During a drain, the original WebSocket may be closed by the gateway
      // while the request is still in flight.
      const latestConn = {
        ws: this.accessor.activeConnection?.ws ?? originalWs,
        id: this.accessor.activeConnection?.id ?? originalConnectionId,
      };

      this.logger.debug(
        {
          connectionId: latestConn.id,
          leaseId: currentLeaseId,
          requestId: gatewayExecutorRequest.requestId,
          functionSlug: gatewayExecutorRequest.functionSlug,
          runId: gatewayExecutorRequest.runId,
          stepId: gatewayExecutorRequest.stepId,
        },
        "Extending lease",
      );

      if (latestConn.ws.readyState !== WebSocket.OPEN) {
        this.logger.warn(
          {
            connectionId: latestConn.id,
            requestId: gatewayExecutorRequest.requestId,
          },
          "Cannot extend lease, no open WebSocket available",
        );
        return;
      }

      try {
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
        const meta =
          this.accessor.inProgressRequests.requestMeta[
            gatewayExecutorRequest.requestId
          ];
        if (meta) meta.leaseLastExtendedAt = Date.now();
      } catch (err) {
        this.logger.warn(
          {
            connectionId: latestConn.id,
            requestId: gatewayExecutorRequest.requestId,
            err: toError(err),
          },
          "Failed to send lease extension",
        );
      }
    }, conn.extendLeaseIntervalMs);

    try {
      const responseBytes = await this.callbacks.handleExecutionRequest(
        gatewayExecutorRequest,
      );

      const durationMs = Date.now() - startedAt;
      this.logger.debug(
        {
          requestId: gatewayExecutorRequest.requestId,
          functionSlug: gatewayExecutorRequest.functionSlug,
          durationMs,
        },
        "Request execution completed",
      );

      if (!this.accessor.activeConnection) {
        this.logger.warn(
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

      this.logger.debug(
        {
          connectionId: this.accessor.activeConnection.id,
          requestId: gatewayExecutorRequest.requestId,
        },
        "Sending worker reply",
      );

      this.accessor.activeConnection.ws.send(
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
      const durationMs = Date.now() - startedAt;
      this.logger.warn(
        {
          requestId: gatewayExecutorRequest.requestId,
          durationMs,
          err: toError(err),
        },
        "Execution error",
      );
    } finally {
      this.accessor.inProgressRequests.wg.done();
      delete this.accessor.inProgressRequests.requestLeases[
        gatewayExecutorRequest.requestId
      ];
      delete this.accessor.inProgressRequests.requestMeta[
        gatewayExecutorRequest.requestId
      ];
      clearInterval(extendLeaseInterval);

      const remainingInFlight = Object.keys(
        this.accessor.inProgressRequests.requestLeases,
      ).length;
      this.logger.debug(
        {
          requestId: gatewayExecutorRequest.requestId,
          remainingInFlight,
        },
        "Request finished",
      );

      // Wake the loop if shutdown is pending and this was the last request
      if (this.accessor.shutdownRequested && !this.hasInFlightRequests()) {
        this.wakeSignal.wake();
      }
    }
  }

  /** Handle a reply ACK from the gateway. */
  handleReplyAck(
    connectMessage: ConnectMessageType,
    connectionId: string,
  ): void {
    const replyAck = parseWorkerReplyAck(connectMessage.payload);

    this.logger.debug(
      { connectionId, requestId: replyAck.requestId },
      "Acknowledging reply ack",
    );

    this.callbacks.onReplyAck?.(replyAck.requestId);
  }

  /** Handle a lease extension ACK from the gateway. */
  handleExtendLeaseAck(
    connectMessage: ConnectMessageType,
    connectionId: string,
  ): void {
    const extendLeaseAck = WorkerRequestExtendLeaseAckData.decode(
      connectMessage.payload,
    );

    this.logger.debug(
      { connectionId, newLeaseId: extendLeaseAck.newLeaseId },
      "Received extend lease ack",
    );

    if (extendLeaseAck.newLeaseId) {
      this.accessor.inProgressRequests.requestLeases[extendLeaseAck.requestId] =
        extendLeaseAck.newLeaseId;
    } else {
      const meta =
        this.accessor.inProgressRequests.requestMeta[extendLeaseAck.requestId];

      this.logger.error(
        {
          connectionId,
          requestId: extendLeaseAck.requestId,
          functionSlug: meta?.functionSlug,
          runId: meta?.runId,
          stepId: meta?.stepId,
        },
        "Lease lost: the server did not renew the lease for this request. " +
          "Another worker may have claimed it. The in-progress execution " +
          "will continue but its result may be discarded.",
      );
      delete this.accessor.inProgressRequests.requestLeases[
        extendLeaseAck.requestId
      ];
      // Also drop meta so the shutdown dump helper and debug-state snapshot
      // don't report a request we've explicitly released the lease for.
      delete this.accessor.inProgressRequests.requestMeta[
        extendLeaseAck.requestId
      ];

      // If this was the last in-flight request and a shutdown has been
      // requested, wake the reconcile loop so close() can observe the
      // empty lease map and exit. Without this, the loop stays parked on
      // wakeSignal.promise because the finally-block decrement in
      // handleExecutorRequest never runs (user code is still hanging).
      if (this.accessor.shutdownRequested && !this.hasInFlightRequests()) {
        this.wakeSignal.wake();
      }
    }
  }

  private hasInFlightRequests(): boolean {
    return (
      Object.keys(this.accessor.inProgressRequests.requestLeases).length > 0
    );
  }
}
