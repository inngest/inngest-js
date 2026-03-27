import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ConnectMessage,
  GatewayMessageType,
  WorkerRequestExtendLeaseData,
} from "../../../../proto/src/components/connect/protobuf/connect.ts";
import {
  connectAndReady,
  createMockStartResponse,
  createTestCore,
  driveHandshake,
  flushMicrotasks,
  MockWebSocket,
  setupCoreMocks,
  teardownCoreMocks,
} from "./test-helpers.ts";

beforeEach(() => {
  setupCoreMocks();
});

afterEach(() => {
  teardownCoreMocks();
});

describe("ConnectionCore request processing", () => {
  describe("WORKER_REQUEST_ACK sent on request", () => {
    test("sends ACK immediately when executor request received", async () => {
      const { ws } = await connectAndReady();

      ws.sendExecutorRequest({
        requestId: "req-1",
        appName: "test-app",
      });
      await flushMicrotasks();

      const acks = ws.getSentMessagesOfType(
        GatewayMessageType.WORKER_REQUEST_ACK,
      );
      expect(acks.length).toBe(1);
    });
  });

  describe("WORKER_REPLY sent after execution", () => {
    test("sends reply after handleExecutionRequest completes", async () => {
      const { ws } = await connectAndReady({
        callbacks: {
          handleExecutionRequest: vi.fn(async () => new Uint8Array([1, 2, 3])),
        },
      });

      ws.sendExecutorRequest({
        requestId: "req-1",
        appName: "test-app",
      });
      await flushMicrotasks();

      const replies = ws.getSentMessagesOfType(GatewayMessageType.WORKER_REPLY);
      expect(replies.length).toBe(1);
    });
  });

  describe("WORKER_REPLY_ACK dispatched to callback", () => {
    test("calls onReplyAck with requestId", async () => {
      const onReplyAck = vi.fn();
      const { ws } = await connectAndReady({
        callbacks: { onReplyAck },
      });

      ws.sendWorkerReplyAck("req-1");
      await flushMicrotasks();

      expect(onReplyAck).toHaveBeenCalledWith("req-1");
    });
  });

  describe("Unknown app name skipped", () => {
    test("does not send ACK for unrecognized app name", async () => {
      const { ws } = await connectAndReady();

      ws.sendExecutorRequest({
        requestId: "req-1",
        appName: "unknown-app",
      });
      await flushMicrotasks();

      const acks = ws.getSentMessagesOfType(
        GatewayMessageType.WORKER_REQUEST_ACK,
      );
      expect(acks.length).toBe(0);
    });
  });

  describe("Response buffered when no active connection", () => {
    test("calls onBufferResponse when connection lost during execution", async () => {
      let resolveExecution: ((value: Uint8Array) => void) | undefined;
      const executionPromise = new Promise<Uint8Array>((resolve) => {
        resolveExecution = resolve;
      });
      const onBufferResponse = vi.fn();

      const fetchMock = vi.fn();
      fetchMock.mockResolvedValueOnce(
        createMockStartResponse({ connectionId: "conn-1" }),
      );
      // Second call for reconnection after error
      fetchMock.mockResolvedValueOnce(
        createMockStartResponse({ connectionId: "conn-2" }),
      );
      global.fetch = fetchMock;

      const helpers = createTestCore({
        callbacks: {
          handleExecutionRequest: vi.fn(() => executionPromise),
          onBufferResponse,
        },
      });

      const startPromise = helpers.core.start();
      await flushMicrotasks();
      const ws1 = MockWebSocket.instances[0]!;
      await driveHandshake(ws1);
      await startPromise;

      // Send executor request
      ws1.sendExecutorRequest({
        requestId: "req-1",
        appName: "test-app",
      });
      await flushMicrotasks();

      // Kill connection while request is in-flight
      ws1.simulateError();
      await flushMicrotasks();

      // Resolve execution after connection is dead
      const responseBytes = new Uint8Array([4, 5, 6]);
      resolveExecution!(responseBytes);
      await flushMicrotasks();

      expect(onBufferResponse).toHaveBeenCalledWith("req-1", responseBytes);
    });
  });

  describe("Lease extensions", () => {
    test("WORKER_REQUEST_EXTEND_LEASE sent periodically during execution", async () => {
      let resolveExecution: ((value: Uint8Array) => void) | undefined;
      const executionPromise = new Promise<Uint8Array>((resolve) => {
        resolveExecution = resolve;
      });

      const { ws } = await connectAndReady({
        callbacks: {
          handleExecutionRequest: vi.fn(() => executionPromise),
        },
      });

      ws.sendExecutorRequest({
        requestId: "req-1",
        appName: "test-app",
      });
      await flushMicrotasks();

      // Advance past the extend lease interval (5s from CONNECTION_READY)
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();

      const leaseExtensions = ws.getSentMessagesOfType(
        GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE,
      );
      expect(leaseExtensions.length).toBeGreaterThanOrEqual(1);

      // Clean up
      resolveExecution!(new Uint8Array(0));
      await flushMicrotasks();
    });

    test("lease extension ACK updates lease ID", async () => {
      let resolveExecution: ((value: Uint8Array) => void) | undefined;
      const executionPromise = new Promise<Uint8Array>((resolve) => {
        resolveExecution = resolve;
      });

      const { ws } = await connectAndReady({
        callbacks: {
          handleExecutionRequest: vi.fn(() => executionPromise),
        },
      });

      ws.sendExecutorRequest({
        requestId: "req-1",
        appName: "test-app",
        leaseId: "lease-1",
      });
      await flushMicrotasks();

      // Advance to trigger first lease extension
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();

      // Send ACK with a new lease ID
      ws.sendExtendLeaseAck({
        requestId: "req-1",
        newLeaseId: "new-lease",
      });
      await flushMicrotasks();

      // Advance to trigger second lease extension
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();

      // Decode the second EXTEND_LEASE message to verify it uses "new-lease"
      const leaseExtensions = ws.getSentMessagesOfType(
        GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE,
      );
      expect(leaseExtensions.length).toBeGreaterThanOrEqual(2);

      const secondExtension = leaseExtensions[1]!;
      const extendData = WorkerRequestExtendLeaseData.decode(
        secondExtension.payload,
      );
      expect(extendData.leaseId).toBe("new-lease");

      // Clean up
      resolveExecution!(new Uint8Array(0));
      await flushMicrotasks();
    });

    test("lease extension ACK without newLeaseId removes lease", async () => {
      let resolveExecution: ((value: Uint8Array) => void) | undefined;
      const executionPromise = new Promise<Uint8Array>((resolve) => {
        resolveExecution = resolve;
      });

      const { ws } = await connectAndReady({
        callbacks: {
          handleExecutionRequest: vi.fn(() => executionPromise),
        },
      });

      ws.sendExecutorRequest({
        requestId: "req-1",
        appName: "test-app",
      });
      await flushMicrotasks();

      // Advance to trigger first lease extension
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();

      const extensionsBefore = ws.getSentMessagesOfType(
        GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE,
      ).length;

      // Send ACK without newLeaseId — this should remove the lease
      ws.sendExtendLeaseAck({ requestId: "req-1" });
      await flushMicrotasks();

      // Advance past another interval
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();

      // No further EXTEND_LEASE messages should be sent (interval cleared)
      const extensionsAfter = ws.getSentMessagesOfType(
        GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE,
      ).length;
      expect(extensionsAfter).toBe(extensionsBefore);

      // Clean up
      resolveExecution!(new Uint8Array(0));
      await flushMicrotasks();
    });
  });

  describe("10. Graceful shutdown with in-flight requests", () => {
    test("close() waits for in-flight requests to complete", async () => {
      let resolveExecution: ((value: Uint8Array) => void) | undefined;
      const executionPromise = new Promise<Uint8Array>((resolve) => {
        resolveExecution = resolve;
      });

      const { core, ws } = await connectAndReady({
        callbacks: {
          handleExecutionRequest: vi.fn(() => executionPromise),
        },
      });

      // Send an executor request to create in-flight work
      ws.sendExecutorRequest({
        requestId: "req-1",
        appName: "test-app",
      });
      await flushMicrotasks();

      // Start shutdown
      const closePromise = core.close();
      await flushMicrotasks();

      // Verify WORKER_PAUSE was sent
      const pauseMessages = ws.getSentMessagesOfType(
        GatewayMessageType.WORKER_PAUSE,
      );
      expect(pauseMessages.length).toBe(1);

      // close() should NOT have resolved yet
      let closed = false;
      closePromise.then(() => {
        closed = true;
      });
      await flushMicrotasks();
      expect(closed).toBe(false);

      // Complete the execution request
      resolveExecution!(new Uint8Array(0));
      await flushMicrotasks();

      // Now close() should resolve
      await closePromise;
      expect(core.connectionId).toBeUndefined();
    });
  });

  describe("11. Graceful shutdown reconnects if connection dies during in-flight", () => {
    test("reconnects during shutdown for heartbeats/lease extensions", async () => {
      let resolveExecution: ((value: Uint8Array) => void) | undefined;
      const executionPromise = new Promise<Uint8Array>((resolve) => {
        resolveExecution = resolve;
      });

      const fetchMock = vi.fn();
      fetchMock.mockResolvedValueOnce(
        createMockStartResponse({ connectionId: "conn-1" }),
      );
      fetchMock.mockResolvedValueOnce(
        createMockStartResponse({ connectionId: "conn-2" }),
      );
      global.fetch = fetchMock;

      const helpers = createTestCore({
        callbacks: {
          handleExecutionRequest: vi.fn(() => executionPromise),
        },
      });

      const startPromise = helpers.core.start();
      await flushMicrotasks();
      const ws1 = MockWebSocket.instances[0]!;
      await driveHandshake(ws1);
      await startPromise;

      // Send an executor request
      ws1.sendExecutorRequest({
        requestId: "req-1",
        appName: "test-app",
      });
      await flushMicrotasks();

      // Start shutdown
      const closePromise = helpers.core.close();
      await flushMicrotasks();

      // Kill the connection during shutdown
      ws1.simulateError();
      await flushMicrotasks();

      // Should reconnect even during shutdown
      const ws2 = MockWebSocket.instances[1]!;
      expect(ws2).toBeDefined();
      await driveHandshake(ws2);
      await flushMicrotasks();

      // Complete the request
      resolveExecution!(new Uint8Array(0));
      await flushMicrotasks();

      // Now close should resolve
      await closePromise;
    });
  });
});
