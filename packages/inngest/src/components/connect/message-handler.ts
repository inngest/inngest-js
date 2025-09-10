import debug, { type Debugger } from "debug";
import ms from "ms";
import {
  ConnectMessage,
  GatewayConnectionReadyData,
  GatewayMessageType,
  gatewayMessageTypeToJSON,
  WorkerConnectRequestData,
  WorkerRequestAckData,
  WorkerRequestExtendLeaseData,
  WorkerRequestExtendLeaseAckData,
  SDKResponse,
  type GatewayExecutorRequestData,
} from "../../proto/src/components/connect/protobuf/connect.js";
import { version } from "../../version.js";
import { getPlatformName, allProcessEnv } from "../../helpers/env.js";
import { retrieveSystemAttributes, getHostname } from "./os.js";
import {
  parseConnectMessage,
  parseGatewayExecutorRequest,
  parseWorkerReplyAck,
} from "./messages.js";
import { ReconnectError } from "./util.js";
import { type ConnectHandlerOptions } from "./types.js";
import { type MessageBuffer } from "./buffer.js";

/**
 * Setup state tracking for the connection establishment phase
 */
interface SetupState {
  receivedGatewayHello: boolean;
  sentWorkerConnect: boolean;  
  receivedConnectionReady: boolean;
}

/**
 * Data needed to establish connection
 */
interface ConnectionEstablishData {
  marshaledCapabilities: string;
  manualReadinessAck: boolean;
  apps: {
    appName: string;
    appVersion?: string;
    functions: Uint8Array;
  }[];
}

/**
 * Start response from HTTP call
 */
interface StartResponse {
  connectionId: string;
  sessionToken: string;
  syncToken: string;
  gatewayGroup: string;
}

/**
 * Request handlers map
 */
type RequestHandlers = Record<string, (data: GatewayExecutorRequestData) => Promise<any>>;

/**
 * In-progress requests tracking
 */
interface InProgressRequests {
  wg: { add: (n: number) => void; done: () => void };
  requestLeases: Record<string, string>;
}

/**
 * Message handler for processing gateway messages during both setup and active phases
 */
export class MessageHandler {
  private debug: Debugger;
  private inngestEnv: string;
  private options: ConnectHandlerOptions;

  constructor(inngestEnv: string, options: ConnectHandlerOptions) {
    this.debug = debug("inngest:connect:message-handler");
    this.inngestEnv = inngestEnv;
    this.options = options;
  }

  /**
   * Create setup phase message handler
   */
  createSetupMessageHandler(
    ws: WebSocket,
    startResp: StartResponse,
    data: ConnectionEstablishData,
    setupState: SetupState,
    attempt: number,
    onConnectionError: (error: unknown) => void,
    resolveWebsocketConnected?: () => void
  ): {
    handler: (event: MessageEvent) => Promise<void>;
    getHeartbeatInterval: () => number | undefined;
    getExtendLeaseInterval: () => number | undefined;
  } {
    let heartbeatIntervalMs: number | undefined;
    let extendLeaseIntervalMs: number | undefined;

    const handler = async (event: MessageEvent): Promise<void> => {
      const messageBytes = new Uint8Array(event.data as ArrayBuffer);
      const connectMessage = parseConnectMessage(messageBytes);

      this.debug(
        `Received setup message: ${gatewayMessageTypeToJSON(connectMessage.kind)}`,
        { connectionId: startResp.connectionId }
      );

      // First message must be GATEWAY_HELLO
      if (!setupState.receivedGatewayHello) {
        if (connectMessage.kind !== GatewayMessageType.GATEWAY_HELLO) {
          onConnectionError(
            new ReconnectError(
              `Expected hello message, got ${gatewayMessageTypeToJSON(
                connectMessage.kind
              )}`,
              attempt
            )
          );
          return;
        }
        setupState.receivedGatewayHello = true;
        return;
      }

      // Send worker connect after receiving hello
      if (!setupState.sentWorkerConnect) {
        await this.sendWorkerConnect(ws, startResp, data);
        setupState.sentWorkerConnect = true;
        return;
      }

      // Wait for connection ready
      if (!setupState.receivedConnectionReady) {
        if (connectMessage.kind !== GatewayMessageType.GATEWAY_CONNECTION_READY) {
          onConnectionError(
            new ReconnectError(
              `Expected ready message, got ${gatewayMessageTypeToJSON(
                connectMessage.kind
              )}`,
              attempt
            )
          );
          return;
        }

        const readyPayload = GatewayConnectionReadyData.decode(connectMessage.payload);
        setupState.receivedConnectionReady = true;

        // Extract intervals from gateway response
        heartbeatIntervalMs = this.parseInterval(
          readyPayload.heartbeatInterval,
          10_000 // 10 second fallback
        );
        extendLeaseIntervalMs = this.parseInterval(
          readyPayload.extendLeaseInterval,
          5_000 // 5 second fallback
        );

        this.debug("Setup complete, connection ready", {
          connectionId: startResp.connectionId,
          heartbeatIntervalMs,
          extendLeaseIntervalMs,
        });

        resolveWebsocketConnected?.();
        return;
      }

      // Unexpected message during setup
      this.debug("Unexpected message type during setup", {
        kind: gatewayMessageTypeToJSON(connectMessage.kind),
        rawKind: connectMessage.kind,
        attempt,
        setupState,
        connectionId: startResp.connectionId,
      });
    };

    return {
      handler,
      getHeartbeatInterval: () => heartbeatIntervalMs,
      getExtendLeaseInterval: () => extendLeaseIntervalMs,
    };
  }

  /**
   * Create active phase message handler
   */
  createActiveMessageHandler(
    ws: WebSocket,
    connectionId: string,
    requestHandlers: RequestHandlers,
    inProgressRequests: InProgressRequests,
    messageBuffer: MessageBuffer,
    extendLeaseIntervalMs: number | undefined,
    onDraining: () => Promise<void>,
    onConnectionError: (error: unknown) => void
  ): (event: MessageEvent) => Promise<void> {
    return async (event: MessageEvent): Promise<void> => {
      const messageBytes = new Uint8Array(event.data as ArrayBuffer);
      const connectMessage = parseConnectMessage(messageBytes);

      this.debug(
        `Received active message: ${gatewayMessageTypeToJSON(connectMessage.kind)}`,
        { connectionId }
      );

      // Handle draining message
      if (connectMessage.kind === GatewayMessageType.GATEWAY_CLOSING) {
        this.debug("Received draining message", { connectionId });
        await onDraining();
        return;
      }

      // Handle heartbeat
      if (connectMessage.kind === GatewayMessageType.GATEWAY_HEARTBEAT) {
        // Reset pending heartbeats - this should be handled by connection manager
        this.debug("Handled gateway heartbeat", { connectionId });
        return;
      }

      // Handle executor request
      if (connectMessage.kind === GatewayMessageType.GATEWAY_EXECUTOR_REQUEST) {
        await this.handleExecutorRequest(
          connectMessage,
          ws,
          connectionId,
          requestHandlers,
          inProgressRequests,
          messageBuffer,
          extendLeaseIntervalMs
        );
        return;
      }

      // Handle reply acknowledgment
      if (connectMessage.kind === GatewayMessageType.WORKER_REPLY_ACK) {
        const replyAck = parseWorkerReplyAck(connectMessage.payload);
        this.debug("Acknowledging reply ack", {
          connectionId,
          requestId: replyAck.requestId,
        });
        messageBuffer.acknowledgePending(replyAck.requestId);
        return;
      }

      // Handle lease extension acknowledgment
      if (connectMessage.kind === GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE_ACK) {
        await this.handleExtendLeaseAck(connectMessage, connectionId, inProgressRequests);
        return;
      }

      // Unexpected message during active phase
      this.debug("Unexpected message type during active phase", {
        kind: gatewayMessageTypeToJSON(connectMessage.kind),
        rawKind: connectMessage.kind,
        connectionId,
      });
    };
  }

  /**
   * Send worker connect message during setup phase
   */
  private async sendWorkerConnect(
    ws: WebSocket,
    startResp: StartResponse,
    data: ConnectionEstablishData
  ): Promise<void> {
    const startedAt = new Date(Date.now());

    const workerConnectRequestMsg = WorkerConnectRequestData.create({
      connectionId: startResp.connectionId,
      environment: this.inngestEnv,
      platform: getPlatformName({ ...allProcessEnv() }),
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
      startedAt,
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

    this.debug("Sent worker connect message", {
      connectionId: startResp.connectionId,
    });
  }

  /**
   * Handle gateway executor request
   */
  private async handleExecutorRequest(
    connectMessage: ConnectMessage,
    ws: WebSocket,
    connectionId: string,
    requestHandlers: RequestHandlers,
    inProgressRequests: InProgressRequests,
    messageBuffer: MessageBuffer,
    extendLeaseIntervalMs: number | undefined
  ): Promise<void> {
    const gatewayExecutorRequest = parseGatewayExecutorRequest(connectMessage.payload);

    this.debug("Received gateway executor request", {
      requestId: gatewayExecutorRequest.requestId,
      appId: gatewayExecutorRequest.appId,
      appName: gatewayExecutorRequest.appName,
      functionSlug: gatewayExecutorRequest.functionSlug,
      stepId: gatewayExecutorRequest.stepId,
      connectionId,
    });

    // Validate app name
    if (
      typeof gatewayExecutorRequest.appName !== "string" ||
      gatewayExecutorRequest.appName.length === 0
    ) {
      this.debug("No app name in request, skipping", {
        requestId: gatewayExecutorRequest.requestId,
        appId: gatewayExecutorRequest.appId,
        functionSlug: gatewayExecutorRequest.functionSlug,
        stepId: gatewayExecutorRequest.stepId,
        connectionId,
      });
      return;
    }

    // Find request handler
    const requestHandler = requestHandlers[gatewayExecutorRequest.appName];
    if (!requestHandler) {
      this.debug("No request handler found for app, skipping", {
        requestId: gatewayExecutorRequest.requestId,
        appId: gatewayExecutorRequest.appId,
        appName: gatewayExecutorRequest.appName,
        functionSlug: gatewayExecutorRequest.functionSlug,
        stepId: gatewayExecutorRequest.stepId,
        connectionId,
      });
      return;
    }

    // Send acknowledgment
    await this.sendRequestAck(ws, gatewayExecutorRequest);

    // Track request and set up lease extension
    inProgressRequests.wg.add(1);
    inProgressRequests.requestLeases[gatewayExecutorRequest.requestId] = 
      gatewayExecutorRequest.leaseId;

    let extendLeaseInterval: NodeJS.Timeout | undefined;
    try {
      // Start lease extension interval
      if (extendLeaseIntervalMs !== undefined) {
        extendLeaseInterval = setInterval(() => {
          this.extendLease(ws, gatewayExecutorRequest, inProgressRequests, connectionId);
        }, extendLeaseIntervalMs);
      }

      // Execute the request
      const res = await requestHandler(gatewayExecutorRequest);

      // Send reply back to gateway
      await this.sendWorkerReply(ws, res);

    } finally {
      // Clean up
      inProgressRequests.wg.done();
      delete inProgressRequests.requestLeases[gatewayExecutorRequest.requestId];
      if (extendLeaseInterval) {
        clearInterval(extendLeaseInterval);
      }
    }
  }

  /**
   * Send request acknowledgment
   */
  private async sendRequestAck(
    ws: WebSocket,
    gatewayExecutorRequest: GatewayExecutorRequestData
  ): Promise<void> {
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
            })
          ).finish(),
        })
      ).finish()
    );
  }

  /**
   * Send worker reply
   */
  private async sendWorkerReply(ws: WebSocket, response: SDKResponse): Promise<void> {
    ws.send(
      ConnectMessage.encode(
        ConnectMessage.create({
          kind: GatewayMessageType.WORKER_REPLY,
          payload: SDKResponse.encode(response).finish(),
        })
      ).finish()
    );
  }

  /**
   * Extend lease for ongoing request
   */
  private extendLease(
    ws: WebSocket,
    gatewayExecutorRequest: GatewayExecutorRequestData,
    inProgressRequests: InProgressRequests,
    connectionId: string
  ): void {
    // Only extend lease if it's still set on the request
    const currentLeaseId = inProgressRequests.requestLeases[
      gatewayExecutorRequest.requestId
    ];
    if (!currentLeaseId) {
      return;
    }

    this.debug("extending lease", {
      connectionId,
      leaseId: currentLeaseId,
    });

    // Send extend lease request
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
              userTraceCtx: gatewayExecutorRequest.userTraceCtx,
              systemTraceCtx: gatewayExecutorRequest.systemTraceCtx,
              leaseId: currentLeaseId,
              runId: gatewayExecutorRequest.runId,
            })
          ).finish(),
        })
      ).finish()
    );
  }

  /**
   * Handle lease extension acknowledgment
   */
  private async handleExtendLeaseAck(
    connectMessage: ConnectMessage,
    connectionId: string,
    inProgressRequests: InProgressRequests
  ): Promise<void> {
    const extendLeaseAck = WorkerRequestExtendLeaseAckData.decode(connectMessage.payload);

    this.debug("received extend lease ack", {
      connectionId,
      newLeaseId: extendLeaseAck.newLeaseId,
    });

    if (extendLeaseAck.newLeaseId) {
      inProgressRequests.requestLeases[extendLeaseAck.requestId] = 
        extendLeaseAck.newLeaseId;
    } else {
      this.debug("unable to extend lease", {
        connectionId,
        requestId: extendLeaseAck.requestId,
      });
      delete inProgressRequests.requestLeases[extendLeaseAck.requestId];
    }
  }

  /**
   * Parse interval string from gateway (e.g., "10s") to milliseconds
   */
  private parseInterval(intervalStr: string, fallbackMs: number): number {
    if (!intervalStr || intervalStr.length === 0) {
      return fallbackMs;
    }

    try {
      return ms(intervalStr);
    } catch {
      return fallbackMs;
    }
  }
}