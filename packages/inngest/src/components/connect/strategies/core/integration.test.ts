/**
 * Integration tests for ConnectionCore using real HTTP + WebSocket servers.
 *
 * These complement the unit tests (which use MockWebSocket and mock fetch)
 * by exercising real network behavior — protocol framing, TCP connection
 * lifecycle, binary WS message encoding, and actual HTTP round-trips.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mode } from "../../../../helpers/env.ts";
import type { Logger } from "../../../../middleware/logger.ts";
import {
  GatewayMessageType,
  WorkerConnectRequestData,
  WorkerRequestExtendLeaseData,
  WorkerStatusData,
} from "../../../../proto/src/components/connect/protobuf/connect.ts";
import { ConnectionState } from "../../types.ts";
import {
  ConnectionCore,
  type ConnectionCoreCallbacks,
  type ConnectionCoreConfig,
} from "./connection.ts";
import { MockGateway, type MockGatewayOptions } from "./mock-gateway.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function createIntegrationCore(
  gateway: MockGateway,
  overrides: {
    config?: Partial<ConnectionCoreConfig>;
    callbacks?: Partial<ConnectionCoreCallbacks>;
  } = {},
) {
  const logger = createLogger();
  let state = ConnectionState.CONNECTING;

  const callbacks: ConnectionCoreCallbacks = {
    logger,
    onStateChange: (s: ConnectionState) => {
      state = s;
    },
    getState: () => state,
    handleExecutionRequest: async () => new Uint8Array(0),
    onReplyAck: vi.fn(),
    onBufferResponse: vi.fn(),
    ...overrides.callbacks,
  };

  const config: ConnectionCoreConfig = {
    hashedSigningKey: "test-signing-key",
    hashedFallbackKey: "test-fallback-key",
    envName: "test-env",
    connectionData: {
      marshaledCapabilities: "",
      manualReadinessAck: false,
      apps: [],
    },
    apiBaseUrl: gateway.httpUrl,
    mode: "cloud" as Mode,
    appIds: ["test-app"],
    ...overrides.config,
  };

  const core = new ConnectionCore(config, callbacks);
  return { core, callbacks, getState: () => state };
}

async function waitFor(
  condition: () => boolean,
  timeout = 5000,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) {
      throw new Error(`waitFor timed out after ${timeout}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const hasNativeWebSocket = typeof globalThis.WebSocket !== "undefined";

describe.skipIf(!hasNativeWebSocket)("ConnectionCore integration", () => {
  let gateway: MockGateway;

  afterEach(async () => {
    await gateway.stop();
  });

  // =========================================================================
  // 1. Basic Connection
  // =========================================================================

  describe("Basic Connection", () => {
    beforeEach(async () => {
      gateway = new MockGateway();
      await gateway.start();
    });

    it("completes full handshake", async () => {
      const { core, getState } = createIntegrationCore(gateway);

      await core.start();

      expect(core.connectionId).toBeDefined();
      expect(getState()).toBe(ConnectionState.ACTIVE);
      expect(gateway.startRequestCount).toBe(1);
      expect(gateway.connectionCount).toBe(1);

      await core.close();
    });

    it("WORKER_CONNECT contains correct fields", async () => {
      gateway = new MockGateway({ autoHandshake: false });
      await gateway.stop(); // stop the default one
      await gateway.start();

      // Set up manual handshake: listen for connection, do it ourselves
      const connectMsgPromise = gateway.waitForMessage(
        GatewayMessageType.WORKER_CONNECT,
      );

      const { core } = createIntegrationCore(gateway);

      const startPromise = core.start();

      // Wait for WS connection, send HELLO
      const client = await gateway.waitForConnection();
      gateway.sendHello(client);

      // Wait for WORKER_CONNECT
      const connectMsg = await connectMsgPromise;
      const workerConnect = WorkerConnectRequestData.decode(connectMsg.payload);

      expect(workerConnect.connectionId).toBeDefined();
      expect(workerConnect.connectionId.length).toBeGreaterThan(0);
      expect(workerConnect.sdkLanguage).toBe("typescript");
      expect(workerConnect.sdkVersion).toMatch(/^v\d+/);
      expect(workerConnect.authData).toBeDefined();
      expect(workerConnect.authData?.sessionToken).toBe("session-token");
      expect(workerConnect.authData?.syncToken).toBe("sync-token");

      // Complete handshake
      gateway.sendConnectionReady(client);
      await startPromise;

      await core.close();
    });
  });

  // =========================================================================
  // 2. Heartbeats
  // =========================================================================

  describe("Heartbeats", () => {
    beforeEach(async () => {
      gateway = new MockGateway({ heartbeatInterval: "200ms" });
      await gateway.start();
    });

    it("sends WORKER_HEARTBEAT at configured interval", async () => {
      const { core } = createIntegrationCore(gateway);
      await core.start();

      // Auto-respond to heartbeats to keep connection alive
      gateway.onWorkerMessage = (msg, client) => {
        if (msg.kind === GatewayMessageType.WORKER_HEARTBEAT) {
          gateway.sendHeartbeat(client);
        }
      };

      // Wait for at least 2 heartbeats
      const heartbeats = await gateway.waitForMessageCount(
        GatewayMessageType.WORKER_HEARTBEAT,
        2,
        2000,
      );
      expect(heartbeats.length).toBeGreaterThanOrEqual(2);

      await core.close();
    });

    it("gateway heartbeat response prevents reconnection", async () => {
      // Auto-respond to all heartbeats
      gateway.onWorkerMessage = (msg, client) => {
        if (msg.kind === GatewayMessageType.WORKER_HEARTBEAT) {
          gateway.sendHeartbeat(client);
        }
      };

      const { core } = createIntegrationCore(gateway);
      await core.start();

      // Wait 1.5s — should stay on same connection
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(gateway.connectionCount).toBe(1);

      await core.close();
    });

    it("missing heartbeat responses trigger reconnection", async () => {
      // Don't respond to heartbeats — should trigger reconnection
      const { core } = createIntegrationCore(gateway);
      await core.start();

      // Wait for a second connection (reconnection after missed heartbeats)
      await waitFor(() => gateway.connectionCount >= 2, 5000);
      expect(gateway.connectionCount).toBeGreaterThanOrEqual(2);

      await core.close();
    });
  });

  // =========================================================================
  // 3. Request Processing
  // =========================================================================

  describe("Request Processing", () => {
    beforeEach(async () => {
      gateway = new MockGateway({
        heartbeatInterval: "10s",
        extendLeaseInterval: "100ms",
      });
      await gateway.start();
    });

    it("EXECUTOR_REQUEST triggers ACK then REPLY", async () => {
      const responseData = new TextEncoder().encode('{"result":"ok"}');
      const { core } = createIntegrationCore(gateway, {
        callbacks: {
          handleExecutionRequest: async () => responseData,
        },
      });
      await core.start();

      // Set up both waiters BEFORE sending the request, since execution
      // resolves instantly and the REPLY may arrive before the ACK waiter
      // completes.
      const ackPromise = gateway.waitForMessage(
        GatewayMessageType.WORKER_REQUEST_ACK,
        3000,
      );
      const replyPromise = gateway.waitForMessage(
        GatewayMessageType.WORKER_REPLY,
        3000,
      );

      // Send an executor request
      gateway.sendExecutorRequest({
        requestId: "req-1",
        appName: "test-app",
      });

      const ack = await ackPromise;
      expect(ack.kind).toBe(GatewayMessageType.WORKER_REQUEST_ACK);

      const reply = await replyPromise;
      expect(reply.kind).toBe(GatewayMessageType.WORKER_REPLY);
      // The payload should be the response bytes
      expect(reply.payload).toEqual(responseData);

      await core.close();
    });

    it("REPLY_ACK triggers onReplyAck callback", async () => {
      const onReplyAck = vi.fn();
      const { core } = createIntegrationCore(gateway, {
        callbacks: {
          handleExecutionRequest: async () => new Uint8Array(0),
          onReplyAck,
        },
      });
      await core.start();

      // Send request, wait for reply, then send ACK
      gateway.sendExecutorRequest({
        requestId: "req-ack-test",
        appName: "test-app",
      });

      await gateway.waitForMessage(GatewayMessageType.WORKER_REPLY, 3000);
      gateway.sendReplyAck("req-ack-test");

      await waitFor(() => onReplyAck.mock.calls.length > 0, 3000);
      expect(onReplyAck).toHaveBeenCalledWith("req-ack-test");

      await core.close();
    });

    it("unknown app name is silently skipped", async () => {
      const handleExecution = vi.fn(async () => new Uint8Array(0));
      const { core } = createIntegrationCore(gateway, {
        callbacks: { handleExecutionRequest: handleExecution },
      });
      await core.start();

      // Send request with wrong app name
      gateway.sendExecutorRequest({
        requestId: "req-unknown",
        appName: "wrong-app",
      });

      // Wait a bit and verify no ACK was sent
      await new Promise((resolve) => setTimeout(resolve, 500));
      const acks = gateway.getMessagesOfType(
        GatewayMessageType.WORKER_REQUEST_ACK,
      );
      expect(acks.length).toBe(0);
      expect(handleExecution).not.toHaveBeenCalled();

      await core.close();
    });
  });

  // =========================================================================
  // 4. Lease Extensions
  // =========================================================================

  describe("Lease Extensions", () => {
    beforeEach(async () => {
      gateway = new MockGateway({
        heartbeatInterval: "10s",
        extendLeaseInterval: "100ms",
      });
      await gateway.start();
    });

    it("EXTEND_LEASE sent periodically during execution", async () => {
      let resolveExecution: (() => void) | undefined;
      const executionPromise = new Promise<void>((resolve) => {
        resolveExecution = resolve;
      });

      const { core } = createIntegrationCore(gateway, {
        callbacks: {
          handleExecutionRequest: async () => {
            await executionPromise;
            return new Uint8Array(0);
          },
        },
      });
      await core.start();

      // Respond to heartbeats to keep alive
      gateway.onWorkerMessage = (msg, client) => {
        if (msg.kind === GatewayMessageType.WORKER_HEARTBEAT) {
          gateway.sendHeartbeat(client);
        }
      };

      gateway.sendExecutorRequest({
        requestId: "req-lease",
        appName: "test-app",
        leaseId: "original-lease",
      });

      // Wait for at least 2 lease extensions
      const extensions = await gateway.waitForMessageCount(
        GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE,
        2,
        3000,
      );
      expect(extensions.length).toBeGreaterThanOrEqual(2);

      // Verify the leaseId in the extension
      const extData = WorkerRequestExtendLeaseData.decode(
        extensions[0]!.payload,
      );
      expect(extData.leaseId).toBe("original-lease");

      // Complete execution
      resolveExecution!();

      await core.close();
    });

    it("EXTEND_LEASE_ACK with newLeaseId updates future extensions", async () => {
      let resolveExecution: (() => void) | undefined;
      const executionPromise = new Promise<void>((resolve) => {
        resolveExecution = resolve;
      });

      const { core } = createIntegrationCore(gateway, {
        callbacks: {
          handleExecutionRequest: async () => {
            await executionPromise;
            return new Uint8Array(0);
          },
        },
      });
      await core.start();

      // Respond to heartbeats
      gateway.onWorkerMessage = (msg, client) => {
        if (msg.kind === GatewayMessageType.WORKER_HEARTBEAT) {
          gateway.sendHeartbeat(client);
        }
      };

      gateway.sendExecutorRequest({
        requestId: "req-lease-update",
        appName: "test-app",
        leaseId: "original-lease",
      });

      // Wait for first extension
      await gateway.waitForMessage(
        GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE,
        3000,
      );

      // ACK with a new lease ID
      gateway.sendExtendLeaseAck({
        requestId: "req-lease-update",
        newLeaseId: "updated-lease",
      });

      // Wait for subsequent extension and verify it uses the new lease
      // We need to collect a few more extensions and check that at least one
      // has the updated lease
      const moreExtensions = await gateway.waitForMessageCount(
        GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE,
        3,
        3000,
      );

      const hasUpdatedLease = moreExtensions.some((ext) => {
        const data = WorkerRequestExtendLeaseData.decode(ext.payload);
        return data.leaseId === "updated-lease";
      });
      expect(hasUpdatedLease).toBe(true);

      resolveExecution!();
      await core.close();
    });

    it("EXTEND_LEASE_ACK without newLeaseId stops extensions", async () => {
      let resolveExecution: (() => void) | undefined;
      const executionPromise = new Promise<void>((resolve) => {
        resolveExecution = resolve;
      });

      const { core } = createIntegrationCore(gateway, {
        callbacks: {
          handleExecutionRequest: async () => {
            await executionPromise;
            return new Uint8Array(0);
          },
        },
      });
      await core.start();

      // Respond to heartbeats
      gateway.onWorkerMessage = (msg, client) => {
        if (msg.kind === GatewayMessageType.WORKER_HEARTBEAT) {
          gateway.sendHeartbeat(client);
        }
      };

      gateway.sendExecutorRequest({
        requestId: "req-lease-stop",
        appName: "test-app",
        leaseId: "original-lease",
      });

      // Wait for first extension
      await gateway.waitForMessage(
        GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE,
        3000,
      );

      // Count extensions before ACK
      const countBefore = gateway.getMessagesOfType(
        GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE,
      ).length;

      // ACK without newLeaseId — signals lease no longer needed
      gateway.sendExtendLeaseAck({ requestId: "req-lease-stop" });

      // Wait a bit and verify no more extensions
      await new Promise((resolve) => setTimeout(resolve, 500));
      const countAfter = gateway.getMessagesOfType(
        GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE,
      ).length;

      // Should not have sent significantly more extensions
      // Allow at most 1 more that was in-flight before the ACK was processed
      expect(countAfter - countBefore).toBeLessThanOrEqual(1);

      resolveExecution!();
      await core.close();
    });
  });

  // =========================================================================
  // 5. Gateway Drain
  // =========================================================================

  describe("Gateway Drain", () => {
    beforeEach(async () => {
      gateway = new MockGateway({ heartbeatInterval: "10s" });
      await gateway.start();
    });

    it("GATEWAY_CLOSING triggers new connection", async () => {
      const { core } = createIntegrationCore(gateway);
      await core.start();

      const firstConnectionId = core.connectionId;
      const firstClient = gateway.lastClient!;

      // Send drain signal
      gateway.sendGatewayClosing(firstClient);

      // Wait for second connection to complete handshake and become active
      await waitFor(
        () =>
          core.connectionId !== undefined &&
          core.connectionId !== firstConnectionId,
        5000,
      );
      expect(gateway.connectionCount).toBeGreaterThanOrEqual(2);
      expect(core.connectionId).toBeDefined();
      expect(core.connectionId).not.toBe(firstConnectionId);

      await core.close();
    });
  });

  // =========================================================================
  // 6. Reconnection
  // =========================================================================

  describe("Reconnection", () => {
    beforeEach(async () => {
      gateway = new MockGateway({ heartbeatInterval: "10s" });
      await gateway.start();
    });

    it(
      "server-side WS close triggers reconnection",
      { timeout: 20000 },
      async () => {
        const { core } = createIntegrationCore(gateway);
        await core.start();

        // Use close() for a graceful WebSocket close frame; terminate() drops
        // the TCP socket without a close frame, which the native Node 22
        // WebSocket client does not reliably surface via onclose.
        gateway.lastClient!.close();

        // Wait for reconnection
        await waitFor(() => gateway.connectionCount >= 2, 10000);
        expect(gateway.connectionCount).toBeGreaterThanOrEqual(2);

        await core.close();
      },
    );

    it("401 response switches auth key", { timeout: 15000 }, async () => {
      let startCallCount = 0;

      gateway.onStartRequest = (req, headers) => {
        startCallCount++;
        if (startCallCount === 1) {
          // First call: return 401
          return { status: 401, body: "Unauthorized" };
        }
        // Subsequent calls: allow through
        return null;
      };

      const { core } = createIntegrationCore(gateway);
      await core.start();

      // Verify we got at least 2 start requests (first 401, then success)
      expect(gateway.startRequestCount).toBeGreaterThanOrEqual(2);

      // Check auth headers differ between first and second request
      const firstAuth = gateway.startRequestHeaders[0]?.authorization;
      const secondAuth = gateway.startRequestHeaders[1]?.authorization;
      expect(firstAuth).toBeDefined();
      expect(secondAuth).toBeDefined();
      expect(firstAuth).not.toBe(secondAuth);

      // First should be primary key, second should be fallback
      expect(firstAuth).toBe("Bearer test-signing-key");
      expect(secondAuth).toBe("Bearer test-fallback-key");

      await core.close();
    });
  });

  // =========================================================================
  // 7. Worker Status
  // =========================================================================

  describe("Worker Status", () => {
    it("sends WORKER_STATUS at configured interval", async () => {
      gateway = new MockGateway({
        heartbeatInterval: "10s",
        statusInterval: "200ms",
      });
      await gateway.start();

      // Respond to heartbeats to keep alive
      gateway.onWorkerMessage = (msg, client) => {
        if (msg.kind === GatewayMessageType.WORKER_HEARTBEAT) {
          gateway.sendHeartbeat(client);
        }
      };

      const { core } = createIntegrationCore(gateway);
      await core.start();

      // Wait for at least 2 status messages
      const statusMsgs = await gateway.waitForMessageCount(
        GatewayMessageType.WORKER_STATUS,
        2,
        3000,
      );
      expect(statusMsgs.length).toBeGreaterThanOrEqual(2);

      // Verify payload structure
      const data = WorkerStatusData.decode(statusMsgs[0]!.payload);
      expect(data.shutdownRequested).toBe(false);
      expect(Array.isArray(data.inFlightRequestIds)).toBe(true);

      await core.close();
    });

    it("does not send WORKER_STATUS when interval is 0", async () => {
      gateway = new MockGateway({
        heartbeatInterval: "10s",
        statusInterval: "0",
      });
      await gateway.start();

      const { core } = createIntegrationCore(gateway);
      await core.start();

      // Wait and verify no status messages sent
      await new Promise((resolve) => setTimeout(resolve, 500));
      const statusMsgs = gateway.getMessagesOfType(
        GatewayMessageType.WORKER_STATUS,
      );
      expect(statusMsgs.length).toBe(0);

      await core.close();
    });

    it("includes in-flight request IDs in status", async () => {
      gateway = new MockGateway({
        heartbeatInterval: "10s",
        statusInterval: "100ms",
      });
      await gateway.start();

      let resolveExecution: (() => void) | undefined;
      const executionPromise = new Promise<void>((resolve) => {
        resolveExecution = resolve;
      });

      const { core } = createIntegrationCore(gateway, {
        callbacks: {
          handleExecutionRequest: async () => {
            await executionPromise;
            return new Uint8Array(0);
          },
        },
      });
      await core.start();

      // Respond to heartbeats
      gateway.onWorkerMessage = (msg, client) => {
        if (msg.kind === GatewayMessageType.WORKER_HEARTBEAT) {
          gateway.sendHeartbeat(client);
        }
      };

      // Send an executor request that blocks
      gateway.sendExecutorRequest({
        requestId: "req-status-test",
        appName: "test-app",
      });

      // Wait for ACK confirming the request is in-flight
      await gateway.waitForMessage(GatewayMessageType.WORKER_REQUEST_ACK, 3000);

      // Wait for a status message that includes the request ID
      const statusMsgs = await gateway.waitForMessageCount(
        GatewayMessageType.WORKER_STATUS,
        1,
        3000,
      );
      const data = WorkerStatusData.decode(statusMsgs[0]!.payload);
      expect(data.inFlightRequestIds).toContain("req-status-test");

      // Clean up
      resolveExecution!();
      await core.close();
    });
  });

  // =========================================================================
  // 8. Graceful Shutdown
  // =========================================================================

  describe("Graceful Shutdown", () => {
    beforeEach(async () => {
      gateway = new MockGateway({ heartbeatInterval: "10s" });
      await gateway.start();
    });

    it("close() sends WORKER_PAUSE and resolves promptly", async () => {
      const { core } = createIntegrationCore(gateway);
      await core.start();

      const pausePromise = gateway.waitForMessage(
        GatewayMessageType.WORKER_PAUSE,
        3000,
      );

      await core.close();

      const pauseMsg = await pausePromise;
      expect(pauseMsg.kind).toBe(GatewayMessageType.WORKER_PAUSE);
    });

    it("close() waits for in-flight requests", async () => {
      let resolveExecution: (() => void) | undefined;
      const executionPromise = new Promise<void>((resolve) => {
        resolveExecution = resolve;
      });

      const { core } = createIntegrationCore(gateway, {
        callbacks: {
          handleExecutionRequest: async () => {
            await executionPromise;
            return new Uint8Array(0);
          },
        },
      });
      await core.start();

      // Respond to heartbeats
      gateway.onWorkerMessage = (msg, client) => {
        if (msg.kind === GatewayMessageType.WORKER_HEARTBEAT) {
          gateway.sendHeartbeat(client);
        }
      };

      // Send request (will block on executionPromise)
      gateway.sendExecutorRequest({
        requestId: "req-inflight",
        appName: "test-app",
      });

      // Wait for ACK to confirm request was received
      await gateway.waitForMessage(GatewayMessageType.WORKER_REQUEST_ACK, 3000);

      // Start close — should not resolve yet
      let closed = false;
      const closePromise = core.close().then(() => {
        closed = true;
      });

      // Give time for close to potentially resolve
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(closed).toBe(false);

      // Resolve the in-flight request
      resolveExecution!();

      // Now close should complete
      await closePromise;
      expect(closed).toBe(true);
    });
  });
});
