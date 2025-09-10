/**
 * Unit tests for MessageHandler
 */

import { jest } from "@jest/globals";
import { MessageHandler } from "./message-handler.js";
import { MessageBuffer } from "./buffer.js";
import { WebSocketManager, WebSocketState } from "./websocket-manager.js";
import {
  ConnectMessage,
  GatewayMessageType,
  GatewayConnectionReadyData,
  WorkerRequestAckData,
  WorkerReplyAckData,
  WorkerRequestExtendLeaseAckData,
  GatewayExecutorRequestData,
  SDKResponse,
} from "../../proto/src/components/connect/protobuf/connect.js";
import { ReconnectError } from "./util.js";

// Mock dependencies
jest.mock("./os.js", () => ({
  retrieveSystemAttributes: jest.fn<() => Promise<any>>().mockResolvedValue({ os: "test", arch: "x64" }),
  getHostname: jest.fn<() => Promise<string>>().mockResolvedValue("test-hostname"),
}));

jest.mock("../../helpers/env.js", () => ({
  getPlatformName: jest.fn<() => string>().mockReturnValue("test-platform"),
  allProcessEnv: jest.fn<() => any>().mockReturnValue({}),
}));

jest.mock("ms", () => jest.fn((val: string) => {
  // Simple mock implementation
  if (val.endsWith("s")) {
    return parseInt(val) * 1000;
  }
  if (val.endsWith("ms")) {
    return parseInt(val);
  }
  return 10000; // Default
}));

// Mock WebSocket interface
interface MockWebSocket {
  send: jest.MockedFunction<(data: string | ArrayBuffer | Uint8Array) => void>;
  readyState: WebSocketState;
  close: jest.MockedFunction<() => void>;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  binaryType: BinaryType;
}

// Test-friendly WebSocketManager that tracks calls and uses mock WebSocket
class TestWebSocketManager extends WebSocketManager {
  public sendCalls: Array<{ data: string | ArrayBuffer | Uint8Array }> = [];
  public sendMessageCalls: Array<{ message: ConnectMessage }> = [];
  private mockWebSocket: MockWebSocket;

  constructor(mockWebSocket: MockWebSocket) {
    super({
      url: "ws://test.com",
      protocol: "test", 
      binaryType: "arraybuffer",
    });
    this.mockWebSocket = mockWebSocket;
    // Inject the mock WebSocket
    (this as any).ws = mockWebSocket;
  }

  public override send(data: string | ArrayBuffer | Uint8Array): void {
    this.sendCalls.push({ data });
    super.send(data);
  }

  public override sendMessage(message: ConnectMessage): void {
    this.sendMessageCalls.push({ message });
    super.sendMessage(message);
  }

  public override get isOpen(): boolean {
    return this.mockWebSocket.readyState === WebSocketState.OPEN;
  }

  public override get readyState(): WebSocketState {
    return this.mockWebSocket.readyState;
  }
}

// Mock MessageBuffer - extends the real class with jest spies  
class MockMessageBuffer extends MessageBuffer {
  public override append = jest.fn<(response: SDKResponse) => void>();
  public override addPending = jest.fn<(response: SDKResponse, deadline: number) => void>();
  public override acknowledgePending = jest.fn<(requestId: string) => void>();
  public override flush = jest.fn<(hashedSigningKey: string | undefined) => Promise<void>>().mockResolvedValue(undefined);

  constructor() {
    // Create a mock Inngest instance for the parent constructor
    const mockInngest = {
      env: 'test',
      inngestApi: { getTargetUrl: jest.fn() },
    } as any;
    super(mockInngest);
  }
}

// Mock InProgressRequests interface
interface MockInProgressRequests {
  wg: {
    add: jest.MockedFunction<(n: number) => void>;
    done: jest.MockedFunction<() => void>;
  };
  requestLeases: Record<string, string>;
}

describe("MessageHandler", () => {
  let messageHandler: MessageHandler;
  let wsManager: TestWebSocketManager;
  let mockWebSocket: MockWebSocket;
  let mockMessageBuffer: MockMessageBuffer;
  let mockInProgressRequests: MockInProgressRequests;

  beforeEach(() => {
    messageHandler = new MessageHandler("test-env", {
      apps: [],
      instanceId: "test-instance",
    } as any);

    // Create mock WebSocket
    mockWebSocket = {
      send: jest.fn(),
      readyState: WebSocketState.OPEN,
      close: jest.fn(),
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      binaryType: "arraybuffer",
    };

    // Create TestWebSocketManager with mock WebSocket
    wsManager = new TestWebSocketManager(mockWebSocket);

    mockMessageBuffer = new MockMessageBuffer();

    mockInProgressRequests = {
      wg: {
        add: jest.fn(),
        done: jest.fn(),
      },
      requestLeases: {},
    };
  });

  describe("Setup Phase Message Handler", () => {
    test("should handle GATEWAY_HELLO as first message", async () => {
      const setupState = {
        receivedGatewayHello: false,
        sentWorkerConnect: false,
        receivedConnectionReady: false,
      };

      const onConnectionError = jest.fn();
      const resolveWebsocketConnected = jest.fn();

      const { handler } = messageHandler.createSetupMessageHandler(
        wsManager,
        {
          connectionId: "test-conn-id",
          sessionToken: "test-session",
          syncToken: "test-sync",
          gatewayGroup: "test-group",
        },
        {
          marshaledCapabilities: "{}",
          manualReadinessAck: false,
          apps: [],
        },
        setupState,
        0,
        onConnectionError,
        resolveWebsocketConnected
      );

      // Send GATEWAY_HELLO message
      const helloMessage = ConnectMessage.encode({
        kind: GatewayMessageType.GATEWAY_HELLO,
        payload: new Uint8Array(),
      }).finish();

      await handler({ data: helloMessage } as MessageEvent);

      expect(setupState.receivedGatewayHello).toBe(true);
      expect(setupState.sentWorkerConnect).toBe(false);
      expect(onConnectionError).not.toHaveBeenCalled();
    });

    test("should reject non-HELLO as first message", async () => {
      const setupState = {
        receivedGatewayHello: false,
        sentWorkerConnect: false,
        receivedConnectionReady: false,
      };

      const onConnectionError = jest.fn();

      const { handler } = messageHandler.createSetupMessageHandler(
        wsManager,
        {
          connectionId: "test-conn-id",
          sessionToken: "test-session",
          syncToken: "test-sync",
          gatewayGroup: "test-group",
        },
        {
          marshaledCapabilities: "{}",
          manualReadinessAck: false,
          apps: [],
        },
        setupState,
        0,
        onConnectionError
      );

      // Send wrong message type
      const wrongMessage = ConnectMessage.encode({
        kind: GatewayMessageType.GATEWAY_HEARTBEAT,
        payload: new Uint8Array(),
      }).finish();

      await handler({ data: wrongMessage } as MessageEvent);

      expect(onConnectionError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("Expected hello message"),
        })
      );
    });

    test("should send WORKER_CONNECT after receiving HELLO", async () => {
      const setupState = {
        receivedGatewayHello: true,
        sentWorkerConnect: false,
        receivedConnectionReady: false,
      };

      const { handler } = messageHandler.createSetupMessageHandler(
        wsManager,
        {
          connectionId: "test-conn-id",
          sessionToken: "test-session",
          syncToken: "test-sync",
          gatewayGroup: "test-group",
        },
        {
          marshaledCapabilities: "{}",
          manualReadinessAck: false,
          apps: [
            {
              appName: "test-app",
              appVersion: "1.0.0",
              functions: new Uint8Array(),
            },
          ],
        },
        setupState,
        0,
        jest.fn()
      );

      // Trigger sending worker connect
      const helloMessage = ConnectMessage.encode({
        kind: GatewayMessageType.GATEWAY_HELLO,
        payload: new Uint8Array(),
      }).finish();

      await handler({ data: helloMessage } as MessageEvent);

      expect(setupState.sentWorkerConnect).toBe(true);
      expect(wsManager.sendMessageCalls).toHaveLength(1);
      
      // Verify the message sent was WORKER_CONNECT
      const sentMessage = wsManager.sendMessageCalls[0]?.message;
      expect(sentMessage).toBeDefined();
      expect(sentMessage!.kind).toBe(GatewayMessageType.WORKER_CONNECT);
    });

    test("should handle GATEWAY_CONNECTION_READY and extract intervals", async () => {
      const setupState = {
        receivedGatewayHello: true,
        sentWorkerConnect: true,
        receivedConnectionReady: false,
      };

      const resolveWebsocketConnected = jest.fn();

      const { handler, getHeartbeatInterval, getExtendLeaseInterval } = 
        messageHandler.createSetupMessageHandler(
          wsManager,
          {
            connectionId: "test-conn-id",
            sessionToken: "test-session",
            syncToken: "test-sync",
            gatewayGroup: "test-group",
          },
          {
            marshaledCapabilities: "{}",
            manualReadinessAck: false,
            apps: [],
          },
          setupState,
          0,
          jest.fn(),
          resolveWebsocketConnected
        );

      // Send CONNECTION_READY message
      const readyPayload = GatewayConnectionReadyData.encode({
        heartbeatInterval: "15s",
        extendLeaseInterval: "7s",
      }).finish();

      const readyMessage = ConnectMessage.encode({
        kind: GatewayMessageType.GATEWAY_CONNECTION_READY,
        payload: readyPayload,
      }).finish();

      await handler({ data: readyMessage } as MessageEvent);

      expect(setupState.receivedConnectionReady).toBe(true);
      expect(resolveWebsocketConnected).toHaveBeenCalled();
      expect(getHeartbeatInterval()).toBe(15000);
      expect(getExtendLeaseInterval()).toBe(7000);
    });

    test("should use fallback intervals when not provided", async () => {
      const setupState = {
        receivedGatewayHello: true,
        sentWorkerConnect: true,
        receivedConnectionReady: false,
      };

      const { handler, getHeartbeatInterval, getExtendLeaseInterval } = 
        messageHandler.createSetupMessageHandler(
          wsManager,
          {
            connectionId: "test-conn-id",
            sessionToken: "test-session",
            syncToken: "test-sync",
            gatewayGroup: "test-group",
          },
          {
            marshaledCapabilities: "{}",
            manualReadinessAck: false,
            apps: [],
          },
          setupState,
          0,
          jest.fn()
        );

      // Send CONNECTION_READY message with empty intervals
      const readyPayload = GatewayConnectionReadyData.encode({
        heartbeatInterval: "",
        extendLeaseInterval: "",
      }).finish();

      const readyMessage = ConnectMessage.encode({
        kind: GatewayMessageType.GATEWAY_CONNECTION_READY,
        payload: readyPayload,
      }).finish();

      await handler({ data: readyMessage } as MessageEvent);

      expect(getHeartbeatInterval()).toBe(10000); // 10s fallback
      expect(getExtendLeaseInterval()).toBe(5000); // 5s fallback
    });
  });

  describe("Active Phase Message Handler", () => {
    test("should handle GATEWAY_CLOSING message", async () => {
      const onDraining = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

      const handler = messageHandler.createActiveMessageHandler(
        wsManager,
        "test-conn-id",
        {},
        mockInProgressRequests,
        mockMessageBuffer,
        5000,
        onDraining,
        jest.fn<(error: unknown) => void>()
      );

      const drainingMessage = ConnectMessage.encode({
        kind: GatewayMessageType.GATEWAY_CLOSING,
        payload: new Uint8Array(),
      }).finish();

      await handler({ data: drainingMessage } as MessageEvent);

      expect(onDraining).toHaveBeenCalled();
    });

    test("should handle GATEWAY_HEARTBEAT message", async () => {
      const handler = messageHandler.createActiveMessageHandler(
        wsManager,
        "test-conn-id",
        {},
        mockInProgressRequests,
        mockMessageBuffer,
        5000,
        jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        jest.fn<(error: unknown) => void>()
      );

      const heartbeatMessage = ConnectMessage.encode({
        kind: GatewayMessageType.GATEWAY_HEARTBEAT,
        payload: new Uint8Array(),
      }).finish();

      await handler({ data: heartbeatMessage } as MessageEvent);

      // Should handle gracefully without errors
      expect(wsManager.sendMessageCalls).toHaveLength(0);
    });

    test("should handle GATEWAY_EXECUTOR_REQUEST with valid app", async () => {
      const mockRequestHandler = jest.fn<(data: GatewayExecutorRequestData) => Promise<any>>().mockResolvedValue({
        requestId: "req-123",
        status: 200,
        body: new Uint8Array(),
        noRetry: false,
        retryAfter: "",
        requestVersion: 0,
        systemTraceCtx: new Uint8Array(),
        userTraceCtx: new Uint8Array(),
      });

      const requestHandlers = {
        "test-app": mockRequestHandler,
      };

      const handler = messageHandler.createActiveMessageHandler(
        wsManager,
        "test-conn-id",
        requestHandlers,
        mockInProgressRequests,
        mockMessageBuffer,
        5000,
        jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        jest.fn<(error: unknown) => void>()
      );

      const executorRequest = GatewayExecutorRequestData.encode({
        requestId: "req-123",
        accountId: "acc-123",
        envId: "env-123",
        appId: "app-123",
        appName: "test-app",
        functionSlug: "test-function",
        functionId: "func-123",
        stepId: "step-123",
        leaseId: "lease-123",
        runId: "run-123",
        requestPayload: new Uint8Array(),
        systemTraceCtx: new Uint8Array(),
        userTraceCtx: new Uint8Array(),
      } as GatewayExecutorRequestData).finish();

      const requestMessage = ConnectMessage.encode({
        kind: GatewayMessageType.GATEWAY_EXECUTOR_REQUEST,
        payload: executorRequest,
      }).finish();

      await handler({ data: requestMessage } as MessageEvent);

      // Should acknowledge the request and send reply
      expect(wsManager.sendMessageCalls).toHaveLength(2); // ACK + Reply
      const ackMessage = wsManager.sendMessageCalls[0]?.message;
      expect(ackMessage).toBeDefined();
      expect(ackMessage!.kind).toBe(GatewayMessageType.WORKER_REQUEST_ACK);
      
      const replyMessage = wsManager.sendMessageCalls[1]?.message;
      expect(replyMessage).toBeDefined();
      expect(replyMessage!.kind).toBe(GatewayMessageType.WORKER_REPLY);

      // Should call request handler
      expect(mockRequestHandler).toHaveBeenCalled();

      // Should track the request
      expect(mockInProgressRequests.wg.add).toHaveBeenCalledWith(1);
      expect(mockInProgressRequests.wg.done).toHaveBeenCalled();
    });

    test("should skip executor request with missing app handler", async () => {
      const handler = messageHandler.createActiveMessageHandler(
        wsManager,
        "test-conn-id",
        {}, // No handlers
        mockInProgressRequests,
        mockMessageBuffer,
        5000,
        jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        jest.fn<(error: unknown) => void>()
      );

      const executorRequest = GatewayExecutorRequestData.encode({
        requestId: "req-123",
        accountId: "acc-123",
        envId: "env-123",
        appId: "app-123",
        appName: "unknown-app",
        functionSlug: "test-function",
        functionId: "func-123",
        stepId: "step-123",
        leaseId: "lease-123",
        runId: "run-123",
        requestPayload: new Uint8Array(),
        systemTraceCtx: new Uint8Array(),
        userTraceCtx: new Uint8Array(),
      } as GatewayExecutorRequestData).finish();

      const requestMessage = ConnectMessage.encode({
        kind: GatewayMessageType.GATEWAY_EXECUTOR_REQUEST,
        payload: executorRequest,
      }).finish();

      await handler({ data: requestMessage } as MessageEvent);

      // Should not send any response
      expect(wsManager.sendMessageCalls).toHaveLength(0);
      expect(mockInProgressRequests.wg.add).not.toHaveBeenCalled();
    });

    test("should handle WORKER_REPLY_ACK message", async () => {
      const handler = messageHandler.createActiveMessageHandler(
        wsManager,
        "test-conn-id",
        {},
        mockInProgressRequests,
        mockMessageBuffer,
        5000,
        jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        jest.fn<(error: unknown) => void>()
      );

      const replyAckPayload = WorkerReplyAckData.encode({
        requestId: "req-123",
      }).finish();

      const replyAckMessage = ConnectMessage.encode({
        kind: GatewayMessageType.WORKER_REPLY_ACK,
        payload: replyAckPayload,
      }).finish();

      await handler({ data: replyAckMessage } as MessageEvent);

      expect(mockMessageBuffer.acknowledgePending).toHaveBeenCalledWith("req-123");
    });

    test("should handle WORKER_REQUEST_EXTEND_LEASE_ACK with new lease", async () => {
      mockInProgressRequests.requestLeases["req-123"] = "old-lease";

      const handler = messageHandler.createActiveMessageHandler(
        wsManager,
        "test-conn-id",
        {},
        mockInProgressRequests,
        mockMessageBuffer,
        5000,
        jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        jest.fn<(error: unknown) => void>()
      );

      const extendLeaseAckPayload = WorkerRequestExtendLeaseAckData.encode({
        requestId: "req-123",
        newLeaseId: "new-lease",
        accountId: "acc-123",
        envId: "env-123",
        appId: "app-123",
        functionSlug: "test-function",
      } as WorkerRequestExtendLeaseAckData).finish();

      const extendLeaseAckMessage = ConnectMessage.encode({
        kind: GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE_ACK,
        payload: extendLeaseAckPayload,
      }).finish();

      await handler({ data: extendLeaseAckMessage } as MessageEvent);

      expect(mockInProgressRequests.requestLeases["req-123"]).toBe("new-lease");
    });

    test("should handle WORKER_REQUEST_EXTEND_LEASE_ACK without new lease", async () => {
      mockInProgressRequests.requestLeases["req-123"] = "old-lease";

      const handler = messageHandler.createActiveMessageHandler(
        wsManager,
        "test-conn-id",
        {},
        mockInProgressRequests,
        mockMessageBuffer,
        5000,
        jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        jest.fn<(error: unknown) => void>()
      );

      const extendLeaseAckPayload = WorkerRequestExtendLeaseAckData.encode({
        requestId: "req-123",
        newLeaseId: "", // No new lease
        accountId: "acc-123",
        envId: "env-123",
        appId: "app-123",
        functionSlug: "test-function",
      } as WorkerRequestExtendLeaseAckData).finish();

      const extendLeaseAckMessage = ConnectMessage.encode({
        kind: GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE_ACK,
        payload: extendLeaseAckPayload,
      }).finish();

      await handler({ data: extendLeaseAckMessage } as MessageEvent);

      expect(mockInProgressRequests.requestLeases["req-123"]).toBeUndefined();
    });

    test("should handle unexpected message types gracefully", async () => {
      const handler = messageHandler.createActiveMessageHandler(
        wsManager,
        "test-conn-id",
        {},
        mockInProgressRequests,
        mockMessageBuffer,
        5000,
        jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        jest.fn<(error: unknown) => void>()
      );

      // Send GATEWAY_HELLO during active phase (unexpected)
      const unexpectedMessage = ConnectMessage.encode({
        kind: GatewayMessageType.GATEWAY_HELLO,
        payload: new Uint8Array(),
      }).finish();

      await handler({ data: unexpectedMessage } as MessageEvent);

      // Should handle gracefully without throwing
      expect(wsManager.sendMessageCalls).toHaveLength(0);
    });
  });

  describe("Lease Extension", () => {
    test("should set up lease extension interval for executor requests", async () => {
      jest.useFakeTimers();

      const mockRequestHandler = jest.fn<(data: GatewayExecutorRequestData) => Promise<any>>().mockImplementation(() => {
        return new Promise((resolve) => {
          // Simulate long-running request
          setTimeout(() => {
            resolve({
              requestId: "req-123",
              status: 200,
              body: new Uint8Array(),
              noRetry: false,
              retryAfter: "",
              requestVersion: 0,
              systemTraceCtx: new Uint8Array(),
              userTraceCtx: new Uint8Array(),
            });
          }, 10000);
        });
      });

      const requestHandlers = {
        "test-app": mockRequestHandler,
      };

      const handler = messageHandler.createActiveMessageHandler(
        wsManager,
        "test-conn-id",
        requestHandlers,
        mockInProgressRequests,
        mockMessageBuffer,
        3000, // 3 second lease extension interval
        jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        jest.fn<(error: unknown) => void>()
      );

      const executorRequest = GatewayExecutorRequestData.encode({
        requestId: "req-123",
        accountId: "acc-123",
        envId: "env-123",
        appId: "app-123",
        appName: "test-app",
        functionSlug: "test-function",
        functionId: "func-123",
        stepId: "step-123",
        leaseId: "lease-123",
        runId: "run-123",
        requestPayload: new Uint8Array(),
        systemTraceCtx: new Uint8Array(),
        userTraceCtx: new Uint8Array(),
      } as GatewayExecutorRequestData).finish();

      const requestMessage = ConnectMessage.encode({
        kind: GatewayMessageType.GATEWAY_EXECUTOR_REQUEST,
        payload: executorRequest,
      }).finish();

      const handlerPromise = handler({ data: requestMessage } as MessageEvent);

      // Wait a tick for the handler to set up the lease
      await Promise.resolve();
      
      // Should set the lease
      expect(mockInProgressRequests.requestLeases["req-123"]).toBe("lease-123");

      // Fast-forward 3 seconds
      jest.advanceTimersByTime(3000);

      // Should have sent lease extension
      const leaseExtensionCalls = wsManager.sendMessageCalls.filter(call => {
        return call.message.kind === GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE;
      });
      expect(leaseExtensionCalls.length).toBeGreaterThan(0);

      // Clean up
      jest.advanceTimersByTime(10000);
      await handlerPromise;

      jest.useRealTimers();
    });
  });
});