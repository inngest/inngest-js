import http from "node:http";
import { WebSocketServer } from "ws";
import { type AddressInfo } from "node:net";
import debug from "debug";
import {
  ConnectMessage,
  GatewayMessageType,
  GatewayConnectionReadyData,
  GatewayExecutorRequestData,
  WorkerConnectRequestData,
  WorkerRequestAckData,
  WorkerReplyAckData,
  SDKResponse,
  StartRequest,
  StartResponse,
  WorkerDisconnectReason,
} from "../../proto/src/components/connect/protobuf/connect.js";

const testDebug = debug("inngest:connect:test");

/**
 * Mock WebSocket server for testing connect functionality
 */
export class MockWebSocketServer {
  private wss: WebSocketServer | undefined;
  private server: http.Server | undefined;
  private connections = new Set<any>();
  private messageHistory: any[] = [];
  private port: number = 0;

  constructor() {}

  async start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer();
      this.wss = new WebSocketServer({ server: this.server });

      this.wss.on("connection", (ws) => {
        testDebug("WebSocket connection established");
        this.connections.add(ws);

        ws.on("message", (data) => {
          try {
            const message = ConnectMessage.decode(new Uint8Array(data as ArrayBuffer));
            testDebug("Received message:", GatewayMessageType[message.kind]);
            this.messageHistory.push({
              type: message.kind,
              payload: message.payload,
              timestamp: Date.now(),
            });

            // Handle different message types for realistic simulation
            this.handleIncomingMessage(ws, message);
          } catch (err) {
            testDebug("Failed to parse message:", err);
          }
        });

        ws.on("close", () => {
          testDebug("WebSocket connection closed");
          this.connections.delete(ws);
        });

        ws.on("error", (err) => {
          testDebug("WebSocket error:", err);
        });

        // Send gateway hello immediately upon connection
        this.sendGatewayHello(ws);
      });

      this.server.listen(0, "localhost", () => {
        const address = this.server!.address() as AddressInfo;
        this.port = address.port;
        const wsUrl = `ws://localhost:${this.port}`;
        testDebug("Mock WebSocket server started on", wsUrl);
        resolve(wsUrl);
      });

      this.server.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      // Close all connections
      for (const ws of this.connections) {
        ws.close();
      }
      this.connections.clear();

      // Close WebSocket server
      if (this.wss) {
        this.wss.close(() => {
          testDebug("WebSocket server closed");
        });
      }

      // Close HTTP server
      if (this.server) {
        this.server.close(() => {
          testDebug("HTTP server closed");
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private handleIncomingMessage(ws: any, message: ConnectMessage) {
    switch (message.kind) {
      case GatewayMessageType.WORKER_CONNECT:
        // Simulate connection ready response
        setTimeout(() => this.sendConnectionReady(ws), 100);
        break;
      
      case GatewayMessageType.WORKER_HEARTBEAT:
        // Respond with gateway heartbeat
        this.sendGatewayHeartbeat(ws);
        break;

      case GatewayMessageType.WORKER_REQUEST_ACK:
        // Just acknowledge - in real system this would route to executor
        testDebug("Worker acknowledged request");
        break;

      case GatewayMessageType.WORKER_REPLY:
        // Simulate reply acknowledgment
        setTimeout(() => {
          const sdkResponse = SDKResponse.decode(message.payload);
          this.sendWorkerReplyAck(ws, sdkResponse.requestId);
        }, 50);
        break;
    }
  }

  sendGatewayHello(ws?: any): void {
    const target = ws || this.getFirstConnection();
    if (!target) return;

    const message = ConnectMessage.create({
      kind: GatewayMessageType.GATEWAY_HELLO,
      payload: new Uint8Array(),
    });

    target.send(ConnectMessage.encode(message).finish());
    testDebug("Sent gateway hello");
  }

  sendConnectionReady(ws?: any, options: { 
    heartbeatInterval?: string; 
    extendLeaseInterval?: string 
  } = {}): void {
    const target = ws || this.getFirstConnection();
    if (!target) return;

    const readyData = GatewayConnectionReadyData.create({
      heartbeatInterval: options.heartbeatInterval || "10s",
      extendLeaseInterval: options.extendLeaseInterval || "5s",
    });

    const message = ConnectMessage.create({
      kind: GatewayMessageType.GATEWAY_CONNECTION_READY,
      payload: GatewayConnectionReadyData.encode(readyData).finish(),
    });

    target.send(ConnectMessage.encode(message).finish());
    testDebug("Sent connection ready");
  }

  sendGatewayHeartbeat(ws?: any): void {
    const target = ws || this.getFirstConnection();
    if (!target) return;

    const message = ConnectMessage.create({
      kind: GatewayMessageType.GATEWAY_HEARTBEAT,
      payload: new Uint8Array(),
    });

    target.send(ConnectMessage.encode(message).finish());
    testDebug("Sent gateway heartbeat");
  }

  sendDrainingMessage(ws?: any): void {
    const target = ws || this.getFirstConnection();
    if (!target) return;

    const message = ConnectMessage.create({
      kind: GatewayMessageType.GATEWAY_CLOSING,
      payload: new Uint8Array(),
    });

    target.send(ConnectMessage.encode(message).finish());
    testDebug("Sent draining message");
  }

  sendExecutorRequest(ws?: any, options: {
    requestId?: string;
    functionSlug?: string;
    appName?: string;
    requestPayload?: Uint8Array;
  } = {}): void {
    const target = ws || this.getFirstConnection();
    if (!target) return;

    const executorRequest = GatewayExecutorRequestData.create({
      requestId: options.requestId || "test-request-id",
      functionSlug: options.functionSlug || "test-function",
      appName: options.appName || "test-app",
      requestPayload: options.requestPayload || new TextEncoder().encode(JSON.stringify({
        ctx: { fn_id: "test-function", run_id: "test-run-id", step_id: "step" },
        event: { name: "test/event", data: {} },
        events: [{ name: "test/event", data: {} }],
        steps: {},
        use_api: false,
      })),
      accountId: "test-account",
      envId: "test-env", 
      appId: "test-app-id",
      leaseId: "test-lease-id",
      userTraceCtx: new Uint8Array(),
      systemTraceCtx: new Uint8Array(),
      runId: "test-run-id",
    });

    const message = ConnectMessage.create({
      kind: GatewayMessageType.GATEWAY_EXECUTOR_REQUEST,
      payload: GatewayExecutorRequestData.encode(executorRequest).finish(),
    });

    target.send(ConnectMessage.encode(message).finish());
    testDebug("Sent executor request");
  }

  private sendWorkerReplyAck(ws: any, requestId: string): void {
    const ackData = WorkerReplyAckData.create({
      requestId,
    });

    const message = ConnectMessage.create({
      kind: GatewayMessageType.WORKER_REPLY_ACK,
      payload: WorkerReplyAckData.encode(ackData).finish(),
    });

    ws.send(ConnectMessage.encode(message).finish());
    testDebug("Sent reply ack for request:", requestId);
  }

  private getFirstConnection(): any {
    return this.connections.values().next().value;
  }

  getReceivedMessages(): any[] {
    return [...this.messageHistory];
  }

  clearMessageHistory(): void {
    this.messageHistory = [];
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  waitForConnection(timeoutMs: number = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.connections.size > 0) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error(`No connection received within ${timeoutMs}ms`));
      }, timeoutMs);

      const checkConnection = () => {
        if (this.connections.size > 0) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(checkConnection, 50);
        }
      };

      checkConnection();
    });
  }

  waitForMessage(messageType: GatewayMessageType, timeoutMs: number = 5000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Message type ${GatewayMessageType[messageType]} not received within ${timeoutMs}ms`));
      }, timeoutMs);

      const checkMessage = () => {
        const message = this.messageHistory.find(m => m.type === messageType);
        if (message) {
          clearTimeout(timeout);
          resolve(message);
        } else {
          setTimeout(checkMessage, 50);
        }
      };

      checkMessage();
    });
  }
}

/**
 * Mock HTTP server for testing Inngest API endpoints
 */
export class MockHTTPServer {
  private server: http.Server | undefined;
  private requestHistory: any[] = [];
  private port: number = 0;
  private responses: Map<string, any> = new Map();

  constructor() {
    // Set default responses
    this.responses.set("/v0/connect/start", {
      status: 200,
      body: StartResponse.create({
        connectionId: "test-connection-id",
        gatewayEndpoint: "",
        gatewayGroup: "test-gateway-group",
        sessionToken: "test-session-token",
        syncToken: "test-sync-token",
      }),
    });

    this.responses.set("/v0/connect/flush", {
      status: 200,
      body: new Uint8Array(),
    });
  }

  async start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.listen(0, "localhost", () => {
        const address = this.server!.address() as AddressInfo;
        this.port = address.port;
        const baseUrl = `http://localhost:${this.port}`;
        testDebug("Mock HTTP server started on", baseUrl);
        resolve(baseUrl);
      });

      this.server.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          testDebug("Mock HTTP server closed");
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || "", `http://localhost:${this.port}`);
    const path = url.pathname;

    // Parse request body
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", () => {
      // Record the request
      this.requestHistory.push({
        method: req.method,
        path,
        headers: req.headers,
        body,
        timestamp: Date.now(),
      });

      testDebug(`Received ${req.method} ${path}`);

      // Get configured response
      const response = this.responses.get(path);
      if (response) {
        res.statusCode = response.status;
        res.setHeader("Content-Type", "application/protobuf");
        
        if (path === "/v0/connect/start") {
          // Return protobuf-encoded response
          const startResponse = response.body as StartResponse;
          res.end(StartResponse.encode(startResponse).finish());
        } else {
          res.end(response.body);
        }
      } else {
        res.statusCode = 404;
        res.end("Not found");
      }
    });
  }

  setResponse(path: string, response: { status: number; body: any }) {
    this.responses.set(path, response);
  }

  setWebSocketEndpoint(wsUrl: string) {
    const startResponse = this.responses.get("/v0/connect/start")?.body as StartResponse;
    if (startResponse) {
      startResponse.gatewayEndpoint = wsUrl;
    }
  }

  getRequestHistory(): any[] {
    return [...this.requestHistory];
  }

  clearRequestHistory(): void {
    this.requestHistory = [];
  }

  waitForRequest(path: string, timeoutMs: number = 5000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Request to ${path} not received within ${timeoutMs}ms`));
      }, timeoutMs);

      const checkRequest = () => {
        const request = this.requestHistory.find(r => r.path === path);
        if (request) {
          clearTimeout(timeout);
          resolve(request);
        } else {
          setTimeout(checkRequest, 50);
        }
      };

      checkRequest();
    });
  }
}

/**
 * Test harness for coordinating complex connection scenarios
 */
export class ConnectionTestHarness {
  public httpServer: MockHTTPServer;
  public wsServer: MockWebSocketServer;

  constructor() {
    this.httpServer = new MockHTTPServer();
    this.wsServer = new MockWebSocketServer();
  }

  async start(): Promise<{ httpUrl: string; wsUrl: string }> {
    const httpUrl = await this.httpServer.start();
    const wsUrl = await this.wsServer.start();
    
    // Configure HTTP server to return correct WebSocket endpoint
    this.httpServer.setWebSocketEndpoint(wsUrl);

    return { httpUrl, wsUrl };
  }

  async stop(): Promise<void> {
    await Promise.all([
      this.httpServer.stop(),
      this.wsServer.stop(),
    ]);
  }

  async waitForConnectionEstablished(timeoutMs: number = 10000): Promise<void> {
    await this.wsServer.waitForConnection(timeoutMs);
    await this.wsServer.waitForMessage(GatewayMessageType.WORKER_CONNECT, timeoutMs);
  }

  async simulateSuccessfulConnection(): Promise<void> {
    // Wait for worker to connect and send ready
    await this.waitForConnectionEstablished();
    this.wsServer.sendConnectionReady();
  }

  async simulateGatewayDraining(): Promise<void> {
    await this.simulateSuccessfulConnection();
    // Send draining message
    this.wsServer.sendDrainingMessage();
  }

  async simulateNetworkDrop(): Promise<void> {
    // Close all WebSocket connections abruptly
    await this.wsServer.stop();
  }

  clearHistory(): void {
    this.httpServer.clearRequestHistory();
    this.wsServer.clearMessageHistory();
  }
}

/**
 * Utility for waiting with timeout
 */
export function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Utility for waiting for a condition to be true
 */
export async function waitForCondition(
  condition: () => boolean,
  timeoutMs: number = 5000,
  intervalMs: number = 50
): Promise<void> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    if (condition()) {
      return;
    }
    await waitFor(intervalMs);
  }
  
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}