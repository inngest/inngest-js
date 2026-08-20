/**
 * Mock gateway server for integration testing of ConnectionCore.
 *
 * Starts real HTTP and WebSocket servers on ephemeral ports so tests exercise
 * actual network code paths — protocol framing, TCP lifecycle, binary WS
 * encoding, and HTTP round-trips.
 */

import { EventEmitter } from "events";
import { createServer, type IncomingMessage, type Server } from "http";
import { WebSocketServer, type WebSocket as WsWebSocket } from "ws";
import {
  ConnectMessage,
  GatewayConnectionReadyData,
  GatewayExecutorRequestData,
  GatewayMessageType,
  StartResponse,
  WorkerReplyAckData,
  WorkerRequestExtendLeaseAckData,
} from "../../../../proto/src/components/connect/protobuf/connect.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StartRequestInterception {
  status: number;
  body?: Uint8Array | string;
}

export interface MockGatewayOptions {
  /** When true (default), gateway auto-performs HELLO → wait for WORKER_CONNECT → CONNECTION_READY. */
  autoHandshake?: boolean;
  /** Heartbeat interval string sent in CONNECTION_READY (e.g. "200ms"). */
  heartbeatInterval?: string;
  /** Extend lease interval string sent in CONNECTION_READY (e.g. "100ms"). */
  extendLeaseInterval?: string;
  /** Status interval string sent in CONNECTION_READY (e.g. "200ms"). "0" or "" = disabled. */
  statusInterval?: string;
}

// ---------------------------------------------------------------------------
// MockGateway
// ---------------------------------------------------------------------------

export class MockGateway {
  // Servers
  private httpServer: Server | undefined;
  private wsServer: WebSocketServer | undefined;

  // Addresses
  httpUrl = "";
  wsUrl = "";

  // Counters & tracking
  connectionCount = 0;
  startRequestCount = 0;
  receivedMessages: ConnectMessage[] = [];
  clients: WsWebSocket[] = [];
  lastClient: WsWebSocket | undefined;

  // Captured HTTP headers from start requests
  startRequestHeaders: Record<string, string | string[] | undefined>[] = [];

  // Configuration
  private autoHandshake: boolean;
  private heartbeatInterval: string;
  private extendLeaseInterval: string;
  private statusInterval: string;

  // Hooks
  onStartRequest:
    | ((
        req: IncomingMessage,
        headers: Record<string, string | string[] | undefined>,
      ) => StartRequestInterception | null)
    | undefined;

  onWorkerMessage:
    | ((msg: ConnectMessage, client: WsWebSocket) => void)
    | undefined;

  // Internal event emitter for waiters
  private emitter = new EventEmitter();

  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: used in handleStartRequest
  private nextConnId = 1;

  constructor(opts: MockGatewayOptions = {}) {
    this.autoHandshake = opts.autoHandshake ?? true;
    this.heartbeatInterval = opts.heartbeatInterval ?? "200ms";
    this.extendLeaseInterval = opts.extendLeaseInterval ?? "100ms";
    this.statusInterval = opts.statusInterval ?? "0";
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    await Promise.all([this.startHttpServer(), this.startWsServer()]);
  }

  async stop(): Promise<void> {
    // Terminate all WS clients
    for (const client of this.clients) {
      client.terminate();
    }
    this.clients = [];

    await Promise.all([
      new Promise<void>((resolve) => {
        if (this.wsServer) {
          this.wsServer.close(() => resolve());
        } else {
          resolve();
        }
      }),
      new Promise<void>((resolve) => {
        if (this.httpServer) {
          this.httpServer.close(() => resolve());
        } else {
          resolve();
        }
      }),
    ]);
  }

  // -------------------------------------------------------------------------
  // HTTP server
  // -------------------------------------------------------------------------

  private startHttpServer(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer = createServer((req, res) => {
        if (req.method === "POST" && req.url?.startsWith("/v0/connect/start")) {
          this.handleStartRequest(req, res);
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      this.httpServer.listen(0, "127.0.0.1", () => {
        const addr = this.httpServer!.address();
        if (typeof addr === "object" && addr) {
          this.httpUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  }

  private handleStartRequest(
    req: IncomingMessage,
    res: import("http").ServerResponse,
  ): void {
    this.startRequestCount++;
    this.startRequestHeaders.push({ ...req.headers });

    // Allow hook to intercept
    if (this.onStartRequest) {
      const interception = this.onStartRequest(req, req.headers);
      if (interception) {
        res.writeHead(interception.status, {
          "Content-Type":
            typeof interception.body === "string"
              ? "text/plain"
              : "application/protobuf",
        });
        res.end(interception.body ?? "");
        return;
      }
    }

    // Collect body (for potential StartRequest parsing)
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const connId = `conn-${this.nextConnId++}`;

      const startResp = StartResponse.encode(
        StartResponse.create({
          connectionId: connId,
          gatewayEndpoint: this.wsUrl,
          gatewayGroup: "test-group",
          sessionToken: "session-token",
          syncToken: "sync-token",
        }),
      ).finish();

      res.writeHead(200, { "Content-Type": "application/protobuf" });
      res.end(Buffer.from(startResp));
    });
  }

  // -------------------------------------------------------------------------
  // WebSocket server
  // -------------------------------------------------------------------------

  private startWsServer(): Promise<void> {
    return new Promise((resolve) => {
      this.wsServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });

      this.wsServer.on("listening", () => {
        const addr = this.wsServer!.address();
        if (typeof addr === "object" && addr) {
          this.wsUrl = `ws://127.0.0.1:${addr.port}`;
        }
        resolve();
      });

      this.wsServer.on("connection", (client) => {
        this.connectionCount++;
        this.clients.push(client);
        this.lastClient = client;
        this.emitter.emit("connection", client);

        client.on("message", (data: Buffer) => {
          const msg = ConnectMessage.decode(new Uint8Array(data));
          this.receivedMessages.push(msg);
          this.emitter.emit("message", msg, client);
          this.onWorkerMessage?.(msg, client);
        });

        if (this.autoHandshake) {
          this.performAutoHandshake(client);
        }
      });
    });
  }

  private performAutoHandshake(client: WsWebSocket): void {
    // Send HELLO immediately
    this.sendHello(client);

    // Wait for WORKER_CONNECT, then send CONNECTION_READY
    const handler = (msg: ConnectMessage, msgClient: WsWebSocket) => {
      if (
        msgClient === client &&
        msg.kind === GatewayMessageType.WORKER_CONNECT
      ) {
        this.emitter.off("message", handler);
        this.sendConnectionReady(client);
      }
    };
    this.emitter.on("message", handler);
  }

  // -------------------------------------------------------------------------
  // Message senders
  // -------------------------------------------------------------------------

  sendHello(client?: WsWebSocket): void {
    const target = client ?? this.lastClient;
    if (!target) return;
    const msg = ConnectMessage.encode(
      ConnectMessage.create({
        kind: GatewayMessageType.GATEWAY_HELLO,
      }),
    ).finish();
    target.send(msg);
  }

  sendConnectionReady(
    client?: WsWebSocket,
    opts?: {
      heartbeatInterval?: string;
      extendLeaseInterval?: string;
      statusInterval?: string;
    },
  ): void {
    const target = client ?? this.lastClient;
    if (!target) return;

    const readyPayload = GatewayConnectionReadyData.encode(
      GatewayConnectionReadyData.create({
        heartbeatInterval: opts?.heartbeatInterval ?? this.heartbeatInterval,
        extendLeaseInterval:
          opts?.extendLeaseInterval ?? this.extendLeaseInterval,
        statusInterval: opts?.statusInterval ?? this.statusInterval,
      }),
    ).finish();

    const msg = ConnectMessage.encode(
      ConnectMessage.create({
        kind: GatewayMessageType.GATEWAY_CONNECTION_READY,
        payload: readyPayload,
      }),
    ).finish();
    target.send(msg);
  }

  sendHeartbeat(client?: WsWebSocket): void {
    const target = client ?? this.lastClient;
    if (!target) return;
    const msg = ConnectMessage.encode(
      ConnectMessage.create({
        kind: GatewayMessageType.GATEWAY_HEARTBEAT,
      }),
    ).finish();
    target.send(msg);
  }

  sendGatewayClosing(client?: WsWebSocket): void {
    const target = client ?? this.lastClient;
    if (!target) return;
    const msg = ConnectMessage.encode(
      ConnectMessage.create({
        kind: GatewayMessageType.GATEWAY_CLOSING,
      }),
    ).finish();
    target.send(msg);
  }

  sendExecutorRequest(
    opts: {
      requestId: string;
      appName: string;
      functionSlug?: string;
      leaseId?: string;
    },
    client?: WsWebSocket,
  ): void {
    const target = client ?? this.lastClient;
    if (!target) return;

    const requestPayload = GatewayExecutorRequestData.encode(
      GatewayExecutorRequestData.create({
        requestId: opts.requestId,
        appName: opts.appName,
        appId: "app-id",
        accountId: "account-id",
        envId: "env-id",
        functionId: "fn-id",
        functionSlug: opts.functionSlug ?? "test-fn",
        leaseId: opts.leaseId ?? "lease-1",
        requestPayload: new Uint8Array(0),
        systemTraceCtx: new Uint8Array(0),
        userTraceCtx: new Uint8Array(0),
        runId: "run-1",
      }),
    ).finish();

    const msg = ConnectMessage.encode(
      ConnectMessage.create({
        kind: GatewayMessageType.GATEWAY_EXECUTOR_REQUEST,
        payload: requestPayload,
      }),
    ).finish();
    target.send(msg);
  }

  sendReplyAck(requestId: string, client?: WsWebSocket): void {
    const target = client ?? this.lastClient;
    if (!target) return;

    const payload = WorkerReplyAckData.encode(
      WorkerReplyAckData.create({ requestId }),
    ).finish();

    const msg = ConnectMessage.encode(
      ConnectMessage.create({
        kind: GatewayMessageType.WORKER_REPLY_ACK,
        payload,
      }),
    ).finish();
    target.send(msg);
  }

  sendExtendLeaseAck(
    opts: { requestId: string; newLeaseId?: string },
    client?: WsWebSocket,
  ): void {
    const target = client ?? this.lastClient;
    if (!target) return;

    const payload = WorkerRequestExtendLeaseAckData.encode(
      WorkerRequestExtendLeaseAckData.create({
        requestId: opts.requestId,
        accountId: "account-id",
        envId: "env-id",
        appId: "app-id",
        functionSlug: "test-fn",
        newLeaseId: opts.newLeaseId,
      }),
    ).finish();

    const msg = ConnectMessage.encode(
      ConnectMessage.create({
        kind: GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE_ACK,
        payload,
      }),
    ).finish();
    target.send(msg);
  }

  // -------------------------------------------------------------------------
  // Promise-based waiters
  // -------------------------------------------------------------------------

  waitForConnection(timeout = 5000): Promise<WsWebSocket> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.emitter.off("connection", handler);
        reject(new Error(`Timed out waiting for connection (${timeout}ms)`));
      }, timeout);

      const handler = (client: WsWebSocket) => {
        clearTimeout(timer);
        resolve(client);
      };
      this.emitter.once("connection", handler);
    });
  }

  waitForMessage(
    kind: GatewayMessageType,
    timeout = 5000,
  ): Promise<ConnectMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.emitter.off("message", handler);
        reject(
          new Error(
            `Timed out waiting for message kind ${kind} (${timeout}ms)`,
          ),
        );
      }, timeout);

      const handler = (msg: ConnectMessage) => {
        if (msg.kind === kind) {
          clearTimeout(timer);
          this.emitter.off("message", handler);
          resolve(msg);
        }
      };
      this.emitter.on("message", handler);
    });
  }

  waitForMessageCount(
    kind: GatewayMessageType,
    count: number,
    timeout = 5000,
  ): Promise<ConnectMessage[]> {
    return new Promise((resolve, reject) => {
      const collected: ConnectMessage[] = [];

      const timer = setTimeout(() => {
        this.emitter.off("message", handler);
        reject(
          new Error(
            `Timed out waiting for ${count} messages of kind ${kind}, got ${collected.length} (${timeout}ms)`,
          ),
        );
      }, timeout);

      const handler = (msg: ConnectMessage) => {
        if (msg.kind === kind) {
          collected.push(msg);
          if (collected.length >= count) {
            clearTimeout(timer);
            this.emitter.off("message", handler);
            resolve(collected);
          }
        }
      };
      this.emitter.on("message", handler);
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Get all received messages of a specific type. */
  getMessagesOfType(kind: GatewayMessageType): ConnectMessage[] {
    return this.receivedMessages.filter((msg) => msg.kind === kind);
  }
}
