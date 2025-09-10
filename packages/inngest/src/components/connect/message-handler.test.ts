/**
 * Unit tests for MessageHandler
 */

import { jest } from "@jest/globals";
import { MessageHandler } from "./message-handler.js";
import {
  ConnectMessage,
  GatewayMessageType,
  GatewayConnectionReadyData,
  WorkerRequestAckData,
  WorkerReplyAckData,
  WorkerRequestExtendLeaseAckData,
  GatewayExecutorRequestData,
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

describe("MessageHandler", () => {
  let messageHandler: MessageHandler;
  let mockWs: any;
  let mockMessageBuffer: any;
  let mockInProgressRequests: any;

  beforeEach(() => {
    messageHandler = new MessageHandler("test-env", {
      apps: [],
      instanceId: "test-instance",
    } as any);

    mockWs = {
      send: jest.fn(),
      readyState: 1,
    };

    mockMessageBuffer = {
      append: jest.fn(),
      acknowledgePending: jest.fn(),
    };

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
        mockWs,
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
        mockWs,
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
        mockWs,
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
      expect(mockWs.send).toHaveBeenCalled();
      
      // Verify the message sent was WORKER_CONNECT
      const sentBytes = mockWs.send.mock.calls[0][0];
      const sentMessage = ConnectMessage.decode(sentBytes);
      expect(sentMessage.kind).toBe(GatewayMessageType.WORKER_CONNECT);
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
          mockWs,
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
          mockWs,
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
        mockWs,
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
        mockWs,
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
      expect(mockWs.send).not.toHaveBeenCalled();
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
        mockWs,
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
      expect(mockWs.send).toHaveBeenCalledTimes(2); // ACK + Reply
      const ackBytes = mockWs.send.mock.calls[0][0];
      const ackMessage = ConnectMessage.decode(ackBytes);
      expect(ackMessage.kind).toBe(GatewayMessageType.WORKER_REQUEST_ACK);
      
      const replyBytes = mockWs.send.mock.calls[1][0];
      const replyMessage = ConnectMessage.decode(replyBytes);
      expect(replyMessage.kind).toBe(GatewayMessageType.WORKER_REPLY);

      // Should call request handler
      expect(mockRequestHandler).toHaveBeenCalled();

      // Should track the request
      expect(mockInProgressRequests.wg.add).toHaveBeenCalledWith(1);
      expect(mockInProgressRequests.wg.done).toHaveBeenCalled();
    });

    test("should skip executor request with missing app handler", async () => {
      const handler = messageHandler.createActiveMessageHandler(
        mockWs,
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
      expect(mockWs.send).not.toHaveBeenCalled();
      expect(mockInProgressRequests.wg.add).not.toHaveBeenCalled();
    });

    test("should handle WORKER_REPLY_ACK message", async () => {
      const handler = messageHandler.createActiveMessageHandler(
        mockWs,
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
        mockWs,
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
        mockWs,
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
        mockWs,
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
      expect(mockWs.send).not.toHaveBeenCalled();
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
        mockWs,
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
      const leaseExtensionCalls = mockWs.send.mock.calls.filter((call: any) => {
        const message = ConnectMessage.decode(call[0]);
        return message.kind === GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE;
      });
      expect(leaseExtensionCalls.length).toBeGreaterThan(0);

      // Clean up
      jest.advanceTimersByTime(10000);
      await handlerPromise;

      jest.useRealTimers();
    });
  });
});