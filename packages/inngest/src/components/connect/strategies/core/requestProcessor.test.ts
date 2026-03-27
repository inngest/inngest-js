import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GatewayMessageType } from "../../../../proto/src/components/connect/protobuf/connect.ts";
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
