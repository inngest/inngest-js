import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GatewayMessageType } from "../../../../proto/src/components/connect/protobuf/connect.ts";
import { ConnectionState } from "../../types.ts";
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

describe("ConnectionCore reconcile loop", () => {
  describe("1. Initial connection establishment", () => {
    test("start() sends HTTP start request, creates WebSocket, completes handshake", async () => {
      const { fetchMock, core } = await connectAndReady();

      // Verify fetch was called for /v0/connect/start
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const fetchCall = fetchMock.mock.calls[0]!;
      expect(fetchCall[0].toString()).toContain("/v0/connect/start");

      // Verify WebSocket was created
      expect(MockWebSocket.instances.length).toBe(1);

      // Verify connectionId is set
      expect(core.connectionId).toBe("conn-1");
    });

    test("state transitions through CONNECTING -> ACTIVE", async () => {
      const { callbacks } = await connectAndReady();
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const onStateChange = callbacks.onStateChange as any;

      const states = onStateChange.mock.calls.map(
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        (call: any) => call[0],
      );
      expect(states).toContain(ConnectionState.CONNECTING);
      expect(states).toContain(ConnectionState.ACTIVE);

      // CONNECTING should come before ACTIVE
      const connectingIdx = states.indexOf(ConnectionState.CONNECTING);
      const activeIdx = states.indexOf(ConnectionState.ACTIVE);
      expect(connectingIdx).toBeLessThan(activeIdx);
    });
  });

  describe("2. Reconnection on WebSocket error", () => {
    test("reconnects when ws.onerror fires", async () => {
      const fetchMock = vi.fn();

      // First call: initial connection
      fetchMock.mockResolvedValueOnce(
        createMockStartResponse({ connectionId: "conn-1" }),
      );
      // Second call: reconnection
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

      expect(helpers.core.connectionId).toBe("conn-1");

      // Simulate error
      ws1.simulateError(new Error("network error"));
      await flushMicrotasks();

      // The reconcile loop should have started a new connection
      const ws2 = MockWebSocket.instances[1]!;
      expect(ws2).toBeDefined();
      await driveHandshake(ws2);
      await flushMicrotasks();

      expect(helpers.core.connectionId).toBe("conn-2");
    });

    test("state transitions through ACTIVE -> RECONNECTING -> ACTIVE", async () => {
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

      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const onStateChange = helpers.callbacks.onStateChange as any;
      onStateChange.mockClear();

      // Simulate error
      ws1.simulateError();
      await flushMicrotasks();

      const ws2 = MockWebSocket.instances[1]!;
      await driveHandshake(ws2);
      await flushMicrotasks();

      // biome-ignore lint/suspicious/noExplicitAny: test mock
      const states = onStateChange.mock.calls.map((call: any) => call[0]);
      expect(states).toContain(ConnectionState.RECONNECTING);
      expect(states).toContain(ConnectionState.ACTIVE);
    });
  });

  describe("3. Reconnection on WebSocket close", () => {
    test("reconnects when ws.onclose fires", async () => {
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

      // Simulate close
      ws1.simulateClose("server gone");
      await flushMicrotasks();

      const ws2 = MockWebSocket.instances[1]!;
      expect(ws2).toBeDefined();
      await driveHandshake(ws2);
      await flushMicrotasks();

      expect(helpers.core.connectionId).toBe("conn-2");
    });
  });

  describe("7. Gateway drain recreates connection", () => {
    test("GATEWAY_CLOSING triggers new connection", async () => {
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

      expect(helpers.core.connectionId).toBe("conn-1");

      // Send drain message
      ws1.sendGatewayClosing();
      await flushMicrotasks();

      // New WebSocket should be created
      const ws2 = MockWebSocket.instances[1]!;
      expect(ws2).toBeDefined();
      await driveHandshake(ws2);
      await flushMicrotasks();

      expect(helpers.core.connectionId).toBe("conn-2");
    });

    test("old connection is closed after new one is ready", async () => {
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

      // Send drain message
      ws1.sendGatewayClosing();
      await flushMicrotasks();

      // ws1 should still be "alive" (not closed by us yet) while we wait for ws2
      // since ws1 is the draining connection

      const ws2 = MockWebSocket.instances[1]!;
      await driveHandshake(ws2);
      await flushMicrotasks();

      // After ws2 is ready, ws1 should be closed
      expect(ws1.readyState).toBe(MockWebSocket.CLOSED);
    });
  });

  describe("9. Graceful shutdown without in-flight requests", () => {
    test("close() resolves promptly when no in-flight requests", async () => {
      const { core, ws } = await connectAndReady();

      // Verify WORKER_PAUSE is sent
      const closePromise = core.close();
      await flushMicrotasks();

      const pauseMessages = ws.getSentMessagesOfType(
        GatewayMessageType.WORKER_PAUSE,
      );
      expect(pauseMessages.length).toBe(1);

      await closePromise;

      // Connection should be cleaned up
      expect(core.connectionId).toBeUndefined();
    });
  });

  describe("13. Backoff on repeated failures", () => {
    test("uses exponential backoff on connection failures", async () => {
      const fetchMock = vi.fn();

      // First 3 calls fail
      fetchMock.mockRejectedValueOnce(new Error("network error"));
      fetchMock.mockRejectedValueOnce(new Error("network error"));
      // Third call succeeds
      fetchMock.mockResolvedValueOnce(
        createMockStartResponse({ connectionId: "conn-1" }),
      );
      global.fetch = fetchMock;

      const helpers = createTestCore();
      void helpers.core.start();

      // First failure + backoff
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(2_000); // 1s backoff for attempt 1
      await flushMicrotasks();

      // Second failure + backoff
      await vi.advanceTimersByTimeAsync(5_000); // 2s backoff for attempt 2
      await flushMicrotasks();

      // Third attempt succeeds
      await vi.advanceTimersByTimeAsync(10_000);
      await flushMicrotasks();

      const ws = MockWebSocket.instances[0]!;
      if (ws) {
        await driveHandshake(ws);
      }
      await flushMicrotasks();

      // Should have tried fetch 3 times
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  describe("GATEWAY_CLOSING during shutdown with in-flight requests", () => {
    test("reconnects for lease extensions when gateway drains during shutdown", async () => {
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

      // Send an executor request to create in-flight work
      ws1.sendExecutorRequest({
        requestId: "req-1",
        appName: "test-app",
      });
      await flushMicrotasks();

      // Start shutdown
      const closePromise = helpers.core.close();
      await flushMicrotasks();

      // Gateway sends CLOSING (drain) on ws1
      ws1.sendGatewayClosing();
      await flushMicrotasks();

      // Should create a new WebSocket for reconnection
      const ws2 = MockWebSocket.instances[1]!;
      expect(ws2).toBeDefined();
      await driveHandshake(ws2);
      await flushMicrotasks();

      // Verify new connection is active
      expect(helpers.core.connectionId).toBe("conn-2");

      // Complete the execution to allow close to finish
      resolveExecution!(new Uint8Array(0));
      await flushMicrotasks();

      await closePromise;
    });
  });

  describe("14. Auth key fallback", () => {
    test("switches to fallback key on 401", async () => {
      const fetchMock = vi.fn();

      // First call returns 401
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
      });
      // Second call with fallback key succeeds
      fetchMock.mockResolvedValueOnce(
        createMockStartResponse({ connectionId: "conn-1" }),
      );
      global.fetch = fetchMock;

      const helpers = createTestCore();
      void helpers.core.start();

      // First attempt fails with 401
      await flushMicrotasks();

      // Wait for backoff
      await vi.advanceTimersByTimeAsync(5_000);
      await flushMicrotasks();

      // Second attempt should use fallback key
      const ws = MockWebSocket.instances[0]!;
      if (ws) {
        await driveHandshake(ws);
        await flushMicrotasks();
      }

      // Verify the second fetch used the fallback key
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const secondCall = fetchMock.mock.calls[1]!;
      expect(secondCall[1].headers.Authorization).toBe(
        "Bearer test-fallback-key",
      );
    });
  });

  describe("shutdown in-flight telemetry", () => {
    // Drop a synthetic in-flight lease onto the core so we can exercise the
    // dump helpers without driving a full request/response round-trip.
    function seedInFlight(
      core: unknown,
      count: number,
      opts: { ageMs?: number; sinceLastExtendMs?: number } = {},
    ): void {
      const { ageMs = 5_000, sinceLastExtendMs = 5_000 } = opts;
      const now = Date.now();
      // biome-ignore lint/suspicious/noExplicitAny: tests reach into private state
      const inProgress = (core as any)._inProgressRequests as {
        requestLeases: Record<string, string>;
        requestMeta: Record<string, Record<string, unknown>>;
      };
      for (let i = 0; i < count; i++) {
        const requestId = `req-${i + 1}`;
        inProgress.requestLeases[requestId] = `lease-${i + 1}`;
        inProgress.requestMeta[requestId] = {
          requestId,
          runId: `run-${i + 1}`,
          stepId: "step",
          appId: "app-1",
          envId: "env-1",
          functionSlug: "app-1-fn",
          accountId: "acct-1",
          leaseAcquiredAt: now - ageMs,
          leaseLastExtendedAt: now - sinceLastExtendMs,
        };
      }
    }

    test("dumpInFlightForShutdown is a no-op when nothing is in flight", () => {
      const { core, logger } = createTestCore();
      // biome-ignore lint/suspicious/noExplicitAny: reach private method for test
      (core as any).dumpInFlightForShutdown("drain-start");
      expect(logger.debug).not.toHaveBeenCalled();
    });

    test("emits a summary line plus one debug line per in-flight request", () => {
      const { core, logger } = createTestCore();
      seedInFlight(core, 3, { ageMs: 1_234, sinceLastExtendMs: 500 });

      // biome-ignore lint/suspicious/noExplicitAny: reach private method
      (core as any).dumpInFlightForShutdown("drain-start");

      const summaryCalls = logger.debug.mock.calls.filter(
        (c) => c[1] === "Shutdown: still draining",
      );
      expect(summaryCalls).toHaveLength(1);
      const summary = summaryCalls[0]![0] as Record<string, unknown>;
      expect(summary).toMatchObject({
        reason: "drain-start",
        inFlightCount: 3,
      });
      expect(typeof summary.oldestAgeMs).toBe("number");

      const perRequestCalls = logger.debug.mock.calls.filter(
        (c) => c[1] === "Shutdown: still draining in-flight request",
      );
      expect(perRequestCalls).toHaveLength(3);

      const payload = perRequestCalls[0]![0] as Record<string, unknown>;
      expect(payload).toMatchObject({
        reason: "drain-start",
        stepId: "step",
        functionSlug: "app-1-fn",
        appId: "app-1",
      });
      expect(payload.requestId).toMatch(/^req-\d+$/);
      expect(payload.runId).toMatch(/^run-\d+$/);
      expect(typeof payload.ageMs).toBe("number");
      expect(typeof payload.sinceLastLeaseExtendMs).toBe("number");
      expect(payload.ageMs as number).toBeGreaterThanOrEqual(1_234);
      expect(payload.ageMs as number).toBeLessThan(1_234 + 1_000);
      expect(payload.sinceLastLeaseExtendMs as number).toBeGreaterThanOrEqual(
        500,
      );
    });

    test("close() emits a drain-start dump and starts a periodic ticker", async () => {
      const { core, logger } = await connectAndReady();
      seedInFlight(core, 2);

      // Kick off close() without awaiting — it will hang on the seeded
      // in-flight leases, which is exactly the scenario we want to observe.
      void core.close();
      await flushMicrotasks();

      const initialPerRequest = logger.debug.mock.calls.filter(
        (c) =>
          c[0] &&
          (c[0] as { reason?: string }).reason === "drain-start" &&
          c[1] === "Shutdown: still draining in-flight request",
      );
      expect(initialPerRequest).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(60_000);
      await flushMicrotasks();

      const periodicPerRequest = logger.debug.mock.calls.filter(
        (c) =>
          c[0] &&
          (c[0] as { reason?: string }).reason === "periodic" &&
          c[1] === "Shutdown: still draining in-flight request",
      );
      expect(periodicPerRequest.length).toBeGreaterThanOrEqual(2);
    });
  });
});
