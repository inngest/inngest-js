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

describe("ConnectionCore heartbeat", () => {
  describe("4. Reconnection on consecutive heartbeat misses", () => {
    test("reconnects after 2 missed heartbeats", async () => {
      const fetchMock = vi.fn();
      fetchMock.mockResolvedValueOnce(
        createMockStartResponse({ connectionId: "conn-1" }),
      );
      fetchMock.mockResolvedValueOnce(
        createMockStartResponse({ connectionId: "conn-2" }),
      );
      global.fetch = fetchMock;

      const helpers = createTestCore();
      const startPromise = helpers.core.start();

      await flushMicrotasks();
      const ws1 = MockWebSocket.instances[0]!;
      await driveHandshake(ws1);
      await startPromise;

      // Advance past 2 heartbeat intervals (10s each) without sending responses
      await vi.advanceTimersByTimeAsync(10_000); // First heartbeat sent
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(10_000); // Second heartbeat: pendingHeartbeats hits 2
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(10_000); // Third tick: pendingHeartbeats >= 2, reconnect
      await flushMicrotasks();

      // Should have created a new WebSocket for reconnection
      expect(MockWebSocket.instances.length).toBeGreaterThan(1);
    });
  });

  describe("5. Heartbeat response resets counter", () => {
    test("gateway heartbeat response prevents reconnection", async () => {
      const { ws } = await connectAndReady();

      // First heartbeat tick
      await vi.advanceTimersByTimeAsync(10_000);
      await flushMicrotasks();

      // Respond with heartbeat
      ws.sendGatewayHeartbeat();
      await flushMicrotasks();

      // Second heartbeat tick - counter should be 0 again
      await vi.advanceTimersByTimeAsync(10_000);
      await flushMicrotasks();

      // Should still only have 1 WebSocket (no reconnection)
      expect(MockWebSocket.instances.length).toBe(1);
    });
  });

  describe("Single heartbeat miss tolerated (blip)", () => {
    test("does not reconnect after only 1 missed heartbeat", async () => {
      const { ws } = await connectAndReady();

      // Advance past 1 heartbeat interval without sending a response
      await vi.advanceTimersByTimeAsync(10_000);
      await flushMicrotasks();

      // pendingHeartbeats should be 1, which is < 2 threshold
      // Should still only have 1 WebSocket (no reconnection)
      expect(MockWebSocket.instances.length).toBe(1);

      // Verify a heartbeat was sent
      const heartbeats = ws.getSentMessagesOfType(
        GatewayMessageType.WORKER_HEARTBEAT,
      );
      expect(heartbeats.length).toBe(1);
    });
  });

  describe("6. Single heartbeat targets active connection", () => {
    test("heartbeat sends to current active connection only", async () => {
      const fetchMock = vi.fn();
      fetchMock.mockResolvedValueOnce(
        createMockStartResponse({ connectionId: "conn-1" }),
      );
      fetchMock.mockResolvedValueOnce(
        createMockStartResponse({ connectionId: "conn-2" }),
      );
      global.fetch = fetchMock;

      const helpers = createTestCore();
      const startPromise = helpers.core.start();

      await flushMicrotasks();
      const ws1 = MockWebSocket.instances[0]!;
      await driveHandshake(ws1);
      await startPromise;

      // Send a heartbeat tick
      await vi.advanceTimersByTimeAsync(10_000);
      await flushMicrotasks();

      const ws1Heartbeats = ws1.getSentMessagesOfType(
        GatewayMessageType.WORKER_HEARTBEAT,
      );
      expect(ws1Heartbeats.length).toBe(1);

      // Kill connection and reconnect
      ws1.simulateError();
      await flushMicrotasks();

      const ws2 = MockWebSocket.instances[1]!;
      await driveHandshake(ws2);
      await flushMicrotasks();

      // Clear ws1 sent messages to track only new heartbeats
      const ws1HeartbeatsBefore = ws1.getSentMessagesOfType(
        GatewayMessageType.WORKER_HEARTBEAT,
      ).length;

      // Send another heartbeat tick
      await vi.advanceTimersByTimeAsync(10_000);
      await flushMicrotasks();

      // ws2 should have received the heartbeat
      const ws2Heartbeats = ws2.getSentMessagesOfType(
        GatewayMessageType.WORKER_HEARTBEAT,
      );
      expect(ws2Heartbeats.length).toBe(1);

      // ws1 should NOT have received a new heartbeat
      const ws1HeartbeatsAfter = ws1.getSentMessagesOfType(
        GatewayMessageType.WORKER_HEARTBEAT,
      ).length;
      expect(ws1HeartbeatsAfter).toBe(ws1HeartbeatsBefore);
    });
  });
});
