import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
});
