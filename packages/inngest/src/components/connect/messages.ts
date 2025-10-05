import {
  ConnectMessage,
  GatewayExecutorRequestData,
  GatewayMessageType,
  gatewayMessageTypeToJSON,
  SDKResponse,
  StartRequest,
  StartResponse,
  WorkerReplyAckData,
  WorkerRequestAckData,
  WorkerRequestExtendLeaseAckData,
  WorkerRequestExtendLeaseData,
} from "../../proto/src/components/connect/protobuf/connect.ts";
import { type Connection } from "./connection.ts";
import { Reconciler } from "./reconcile.ts";

export const ResponseAcknowlegeDeadline = 5_000;

export class MessageHandler extends Reconciler {
  override async handleMessage(conn: Connection, message: ConnectMessage) {
    switch (message.kind) {
      case GatewayMessageType.GATEWAY_CLOSING:
        // If this is the active connection, ensure we transition to draining
        if (this.activeConnection?.id === conn.id) {
          this.activeConnection = undefined;
          this.drainingConnection = conn;
        }

        return;
      case GatewayMessageType.GATEWAY_HEARTBEAT:
        conn.pendingHeartbeats = 0;
        this.debug("Handled gateway heartbeat", {
          connectionId: conn.id,
        });
        return;
      case GatewayMessageType.GATEWAY_EXECUTOR_REQUEST:
        if (this.activeConnection?.id !== conn.id) {
          this.debug("Received request while not active, skipping", {
            connectionId: conn.id,
          });
          return;
        }

        const gatewayExecutorRequest = parseGatewayExecutorRequest(
          message.payload
        );

        this.debug("Received gateway executor request", {
          requestId: gatewayExecutorRequest.requestId,
          appId: gatewayExecutorRequest.appId,
          appName: gatewayExecutorRequest.appName,
          functionSlug: gatewayExecutorRequest.functionSlug,
          stepId: gatewayExecutorRequest.stepId,
          connectionId: conn.id,
        });

        if (
          typeof gatewayExecutorRequest.appName !== "string" ||
          gatewayExecutorRequest.appName.length === 0
        ) {
          this.debug("No app name in request, skipping", {
            requestId: gatewayExecutorRequest.requestId,
            appId: gatewayExecutorRequest.appId,
            functionSlug: gatewayExecutorRequest.functionSlug,
            stepId: gatewayExecutorRequest.stepId,
            connectionId: conn.id,
          });
          return;
        }
        const requestHandler =
          this._requestHandlers?.[gatewayExecutorRequest.appName];

        if (!requestHandler) {
          this.debug("No request handler found for app, skipping", {
            requestId: gatewayExecutorRequest.requestId,
            appId: gatewayExecutorRequest.appId,
            appName: gatewayExecutorRequest.appName,
            functionSlug: gatewayExecutorRequest.functionSlug,
            stepId: gatewayExecutorRequest.stepId,
            connectionId: conn.id,
          });
          return;
        }

        // Ack received request
        conn.ws.send(
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
                })
              ).finish(),
            })
          ).finish()
        );

        this.inProgressRequests.wg.add(1);
        this.inProgressRequests.requestLeases[
          gatewayExecutorRequest.requestId
        ] = gatewayExecutorRequest.leaseId;

        let extendLeaseInterval: NodeJS.Timeout | undefined;
        try {
          extendLeaseInterval = setInterval(() => {
            if (conn.extendLeaseIntervalMs === undefined) {
              return;
            }

            // Only extend lease if it's still set on the request
            const currentLeaseId =
              this.inProgressRequests.requestLeases[
                gatewayExecutorRequest.requestId
              ];
            if (!currentLeaseId) {
              clearInterval(extendLeaseInterval);
              return;
            }

            this.debug("extending lease", {
              connectionId: conn.id,
              leaseId: currentLeaseId,
            });

            // Send extend lease request
            conn.ws.send(
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
                    })
                  ).finish(),
                })
              ).finish()
            );
          }, conn.extendLeaseIntervalMs);

          const res = await requestHandler(gatewayExecutorRequest);

          this.debug("Sending worker reply", {
            connectionId: conn.id,
            requestId: gatewayExecutorRequest.requestId,
          });

          this.messageBuffer.addPending(res, ResponseAcknowlegeDeadline);

          if (!this.activeConnection) {
            this.debug("No current WebSocket, buffering response", {
              connectionId: conn.id,
              requestId: gatewayExecutorRequest.requestId,
            });
            this.messageBuffer.append(res);
            return;
          }

          // Send reply back to gateway
          this.activeConnection.ws.send(
            ConnectMessage.encode(
              ConnectMessage.create({
                kind: GatewayMessageType.WORKER_REPLY,
                payload: SDKResponse.encode(res).finish(),
              })
            ).finish()
          );
        } finally {
          this.inProgressRequests.wg.done();
          delete this.inProgressRequests.requestLeases[
            gatewayExecutorRequest.requestId
          ];
          clearInterval(extendLeaseInterval);
        }

        return;
      case GatewayMessageType.WORKER_REPLY_ACK:
        const replyAck = parseWorkerReplyAck(message.payload);

        this.debug("Acknowledging reply ack", {
          connectionId: conn.id,
          requestId: replyAck.requestId,
        });

        this.messageBuffer.acknowledgePending(replyAck.requestId);

        return;
      case GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE_ACK:
        const extendLeaseAck = WorkerRequestExtendLeaseAckData.decode(
          message.payload
        );

        this.debug("received extend lease ack", {
          connectionId: conn.id,
          newLeaseId: extendLeaseAck.newLeaseId,
        });

        if (extendLeaseAck.newLeaseId) {
          this.inProgressRequests.requestLeases[extendLeaseAck.requestId] =
            extendLeaseAck.newLeaseId;
        } else {
          this.debug("unable to extend lease", {
            connectionId: conn.id,
            requestId: extendLeaseAck.requestId,
          });
          delete this.inProgressRequests.requestLeases[
            extendLeaseAck.requestId
          ];
        }

        return;
      default:
        this.debug("Unexpected message type", {
          kind: gatewayMessageTypeToJSON(message.kind),
          rawKind: message.kind,
          connectionId: conn.id,
        });
    }
  }
}

export function createStartRequest(excludeGateways: string[]) {
  return StartRequest.encode(
    StartRequest.create({
      excludeGateways,
    })
  ).finish();
}

export async function parseStartResponse(r: Response) {
  const startResp = StartResponse.decode(new Uint8Array(await r.arrayBuffer()));
  return startResp;
}

export function parseConnectMessage(r: Uint8Array) {
  const connectMessage = ConnectMessage.decode(r);
  return connectMessage;
}

export function parseGatewayExecutorRequest(r: Uint8Array) {
  const gatewayExecutorRequest = GatewayExecutorRequestData.decode(r);
  return gatewayExecutorRequest;
}

export function parseWorkerReplyAck(r: Uint8Array) {
  const workerReplyAck = WorkerReplyAckData.decode(r);
  return workerReplyAck;
}
