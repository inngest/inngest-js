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

    test("lease extension ACK without newLeaseId removes lease and logs error", async () => {
      let resolveExecution: ((value: Uint8Array) => void) | undefined;
      const executionPromise = new Promise<Uint8Array>((resolve) => {
        resolveExecution = resolve;
      });

      const { ws, logger } = await connectAndReady({
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

      // Should log an error about the lost lease
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: "req-1" }),
        expect.stringContaining("Lease lost"),
      );

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

    test("skips extension when WebSocket is not OPEN", async () => {
      let resolveExecution: ((value: Uint8Array) => void) | undefined;
      const executionPromise = new Promise<Uint8Array>((resolve) => {
        resolveExecution = resolve;
      });

      const { ws, logger } = await connectAndReady({
        callbacks: {
          handleExecutionRequest: vi.fn(() => executionPromise),
        },
      });

      ws.sendExecutorRequest({
        requestId: "req-1",
        appName: "test-app",
      });
      await flushMicrotasks();

      const extensionsBefore = ws.getSentMessagesOfType(
        GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE,
      ).length;

      // Close the WebSocket so readyState is no longer OPEN
      ws.readyState = MockWebSocket.CLOSED;

      // Advance past lease extension interval
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();

      // No new extension should have been sent
      const extensionsAfter = ws.getSentMessagesOfType(
        GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE,
      ).length;
      expect(extensionsAfter).toBe(extensionsBefore);

      // Warning should have been logged
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: "req-1" }),
        "Cannot extend lease, no open WebSocket available",
      );

      // Clean up
      resolveExecution!(new Uint8Array(0));
      await flushMicrotasks();
    });

    test("resumes extensions after WebSocket recovers", async () => {
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

      // Close the WebSocket — extension should be skipped
      ws.readyState = MockWebSocket.CLOSED;
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();

      const extensionsWhileClosed = ws.getSentMessagesOfType(
        GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE,
      ).length;

      // Reopen the WebSocket — next tick should succeed
      ws.readyState = MockWebSocket.OPEN;
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();

      const extensionsAfterRecovery = ws.getSentMessagesOfType(
        GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE,
      ).length;
      expect(extensionsAfterRecovery).toBeGreaterThan(extensionsWhileClosed);

      // Clean up
      resolveExecution!(new Uint8Array(0));
      await flushMicrotasks();
    });

    test("uses new connection after drain", async () => {
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

      // Send executor request on first connection
      ws1.sendExecutorRequest({
        requestId: "req-1",
        appName: "test-app",
      });
      await flushMicrotasks();

      // Trigger drain — gateway sends GATEWAY_CLOSING
      ws1.sendGatewayClosing();
      await flushMicrotasks();

      // Drive the new connection handshake
      const ws2 = MockWebSocket.instances[1]!;
      expect(ws2).toBeDefined();
      await driveHandshake(ws2);
      await flushMicrotasks();

      // Advance past lease extension interval
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();

      // The extension should be sent on the new connection (ws2), not the old one (ws1)
      const ws2Extensions = ws2.getSentMessagesOfType(
        GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE,
      );
      expect(ws2Extensions.length).toBeGreaterThanOrEqual(1);

      // Clean up
      resolveExecution!(new Uint8Array(0));
      await flushMicrotasks();
    });

    test("falls back to original WS when no active connection", async () => {
      let resolveExecution: ((value: Uint8Array) => void) | undefined;
      const executionPromise = new Promise<Uint8Array>((resolve) => {
        resolveExecution = resolve;
      });

      const fetchMock = vi.fn();
      fetchMock.mockResolvedValueOnce(
        createMockStartResponse({ connectionId: "conn-1" }),
      );
      // Second fetch for reconnection after error
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

      // Send executor request
      ws1.sendExecutorRequest({
        requestId: "req-1",
        appName: "test-app",
      });
      await flushMicrotasks();

      // Kill the connection — activeConnection becomes undefined
      ws1.simulateError();
      await flushMicrotasks();

      // ws1 is still OPEN in our mock (readyState not auto-changed by error),
      // so the fallback should still use it for lease extensions
      const extensionsBefore = ws1.getSentMessagesOfType(
        GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE,
      ).length;

      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();

      const extensionsAfter = ws1.getSentMessagesOfType(
        GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE,
      ).length;
      expect(extensionsAfter).toBeGreaterThan(extensionsBefore);

      // Clean up
      resolveExecution!(new Uint8Array(0));
      await flushMicrotasks();
    });

    test("continues retrying after ws.send() throws", async () => {
      let resolveExecution: ((value: Uint8Array) => void) | undefined;
      const executionPromise = new Promise<Uint8Array>((resolve) => {
        resolveExecution = resolve;
      });

      const { ws, logger } = await connectAndReady({
        callbacks: {
          handleExecutionRequest: vi.fn(() => executionPromise),
        },
      });

      ws.sendExecutorRequest({
        requestId: "req-1",
        appName: "test-app",
      });
      await flushMicrotasks();

      // Make ws.send throw on the next call
      const originalSend = ws.send.bind(ws);
      let throwCount = 0;
      ws.send = (data: Uint8Array) => {
        if (throwCount === 0) {
          throwCount++;
          throw new Error("network failure");
        }
        originalSend(data);
      };

      // First tick — send throws
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: "req-1" }),
        "Failed to send lease extension",
      );

      const extensionsAfterFailure = ws.getSentMessagesOfType(
        GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE,
      ).length;

      // Second tick — send succeeds (throw was one-shot)
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();

      const extensionsAfterRecovery = ws.getSentMessagesOfType(
        GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE,
      ).length;
      expect(extensionsAfterRecovery).toBeGreaterThan(extensionsAfterFailure);

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

  describe("12. Graceful shutdown wakes reconcile loop when lease is lost", () => {
    test("close() resolves after lease-lost ack clears the last in-flight request", async () => {
      // Userland promise that never resolves. Mirrors a function that keeps
      // running after the gateway reassigns its lease to another worker.
      const executionPromise = new Promise<Uint8Array>(() => {});

      const { core, ws } = await connectAndReady({
        callbacks: {
          handleExecutionRequest: vi.fn(() => executionPromise),
        },
      });

      ws.sendExecutorRequest({
        requestId: "req-1",
        appName: "test-app",
      });
      await flushMicrotasks();

      const closePromise = core.close();
      await flushMicrotasks();

      let closed = false;
      closePromise.then(() => {
        closed = true;
      });
      await flushMicrotasks();
      expect(closed).toBe(false);

      // Sanity: one in-flight request before the lease-lost ack.
      expect(core.getDebugState().inFlightRequestCount).toBe(1);

      // Gateway sends extend-lease-ack with empty newLeaseId: lease lost.
      ws.sendExtendLeaseAck({ requestId: "req-1" });
      await flushMicrotasks();

      // Lease has been removed: break condition is now satisfied
      // (shutdownRequested && !hasInFlightRequests()).
      expect(core.getDebugState().inFlightRequestCount).toBe(0);
      expect(core.getDebugState().shutdownRequested).toBe(true);

      // Without wake() in the lost-lease branch of handleExtendLeaseAck,
      // the reconcile loop stays blocked on wakeSignal.promise and
      // close() never resolves.
      await closePromise;
      expect(core.connectionId).toBeUndefined();
    });
  });
});
