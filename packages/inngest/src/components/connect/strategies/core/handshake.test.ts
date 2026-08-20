import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ConnectMessage,
  GatewayMessageType,
} from "../../../../proto/src/components/connect/protobuf/connect.ts";
import { ensureUnsharedArrayBuffer } from "../../buffer.ts";
import {
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

describe("ConnectionCore handshake", () => {
  describe("15. Connection timeout", () => {
    test("times out and reconnects if no GATEWAY_HELLO within 10s", async () => {
      const fetchMock = vi.fn();
      fetchMock.mockResolvedValueOnce(
        createMockStartResponse({
          connectionId: "conn-1",
          gatewayGroup: "slow-group",
        }),
      );
      fetchMock.mockResolvedValueOnce(
        createMockStartResponse({ connectionId: "conn-2" }),
      );
      global.fetch = fetchMock;

      const helpers = createTestCore();
      void helpers.core.start();

      await flushMicrotasks();

      // WebSocket is created but we don't drive the handshake
      const ws1 = MockWebSocket.instances[0]!;
      ws1.simulateOpen(); // WS opens but no HELLO is sent

      // Advance past the 10s timeout
      await vi.advanceTimersByTimeAsync(10_000);
      await flushMicrotasks();

      // Wait for backoff
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();

      // Should have created a second WebSocket for reconnection
      if (MockWebSocket.instances.length > 1) {
        const ws2 = MockWebSocket.instances[1]!;
        await driveHandshake(ws2);
        await flushMicrotasks();
      }

      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("16. HTTP 429 rate limit", () => {
    test("reconnects after 429 response", async () => {
      const fetchMock = vi.fn();
      // First call returns 429
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: () => Promise.resolve("Rate limited"),
      });
      // Second call succeeds
      fetchMock.mockResolvedValueOnce(
        createMockStartResponse({ connectionId: "conn-1" }),
      );
      global.fetch = fetchMock;

      const helpers = createTestCore();
      void helpers.core.start();

      // First attempt fails with 429
      await flushMicrotasks();

      // Wait for backoff
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();

      // Second attempt should succeed
      const ws = MockWebSocket.instances[0]!;
      if (ws) {
        await driveHandshake(ws);
        await flushMicrotasks();
      }

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(helpers.core.connectionId).toBe("conn-1");
    });
  });

  describe("17. Unexpected message during handshake rejects", () => {
    test("non-HELLO first message triggers reconnection", async () => {
      const fetchMock = vi.fn();
      fetchMock.mockResolvedValueOnce(
        createMockStartResponse({ connectionId: "conn-1" }),
      );
      fetchMock.mockResolvedValueOnce(
        createMockStartResponse({ connectionId: "conn-2" }),
      );
      global.fetch = fetchMock;

      const helpers = createTestCore();
      void helpers.core.start();

      await flushMicrotasks();

      const ws1 = MockWebSocket.instances[0]!;
      ws1.simulateOpen();

      // Send a HEARTBEAT instead of HELLO as the first message
      const heartbeatMsg = ConnectMessage.encode(
        ConnectMessage.create({
          kind: GatewayMessageType.GATEWAY_HEARTBEAT,
        }),
      ).finish();
      ws1.simulateMessage(
        ensureUnsharedArrayBuffer(heartbeatMsg).buffer as ArrayBuffer,
      );
      await flushMicrotasks();

      // Wait for backoff
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();

      // Should have created a second WebSocket for reconnection
      if (MockWebSocket.instances.length > 1) {
        const ws2 = MockWebSocket.instances[1]!;
        await driveHandshake(ws2);
        await flushMicrotasks();
      }

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
