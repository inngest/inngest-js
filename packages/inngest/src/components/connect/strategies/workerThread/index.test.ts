/**
 * Integration tests for WorkerThreadStrategy using a real worker thread and
 * the mock gateway's real HTTP + WebSocket servers.
 */

import type { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Mode } from "../../../../helpers/env.ts";
import type { Logger } from "../../../../middleware/logger.ts";
import {
  GatewayMessageType,
  SDKResponse,
  SDKResponseStatus,
  WorkerRequestExtendLeaseData,
} from "../../../../proto/src/components/connect/protobuf/connect.ts";
import { Inngest } from "../../../Inngest.ts";
import { MockGateway } from "../core/mock-gateway.ts";
import { WorkerThreadStrategy } from "./index.ts";

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

async function waitFor(
  condition: () => boolean,
  timeout = 10_000,
): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) {
      throw new Error(`waitFor timed out after ${timeout}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * A request handler that blocks until the test releases it, like a long step.
 */
function createBlockingHandler() {
  let started = false;
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    get started() {
      return started;
    },
    release,
    handler: async ({ requestId }: { requestId: string }) => {
      started = true;
      await released;
      return SDKResponse.create({
        requestId,
        status: SDKResponseStatus.DONE,
        body: new TextEncoder().encode('"done"'),
      });
    },
  };
}

function createStrategy(
  gateway: MockGateway,
  handler: ReturnType<typeof createBlockingHandler>["handler"],
) {
  const inngest = new Inngest({ id: "test-app", isDev: true });
  return new WorkerThreadStrategy({
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
    internalLogger: createLogger(),
    requestHandlers: { "test-app": handler },
    options: {
      apps: [{ client: inngest, functions: [] }],
      handleShutdownSignals: [],
    },
  });
}

function getWorker(strategy: WorkerThreadStrategy): Worker {
  const worker = strategy["worker"];
  if (!worker) {
    throw new Error("No worker thread");
  }
  return worker;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const hasNativeWebSocket = typeof globalThis.WebSocket !== "undefined";

describe.skipIf(!hasNativeWebSocket)(
  "WorkerThreadStrategy worker respawn",
  () => {
    let gateway: MockGateway;
    let strategy: WorkerThreadStrategy | undefined;

    beforeEach(async () => {
      gateway = new MockGateway({ extendLeaseInterval: "100ms" });
      await gateway.start();

      // Keep connections alive, and renew the lease only once so the test
      // knows which lease ID is current when the worker thread dies.
      let leaseRenewed = false;
      gateway.onWorkerMessage = (msg, client) => {
        if (msg.kind === GatewayMessageType.WORKER_HEARTBEAT) {
          gateway.sendHeartbeat(client);
        }
        if (
          msg.kind === GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE &&
          !leaseRenewed
        ) {
          leaseRenewed = true;
          const { requestId } = WorkerRequestExtendLeaseData.decode(
            msg.payload,
          );
          gateway.sendExtendLeaseAck(
            { requestId, newLeaseId: "lease-2" },
            client,
          );
        }
      };
    });

    afterEach(async () => {
      await strategy?.close();
      strategy = undefined;
      await gateway.stop();
    });

    async function startStepAndKillWorker(
      blocking: ReturnType<typeof createBlockingHandler>,
    ) {
      strategy = createStrategy(gateway, blocking.handler);
      await strategy.connect();

      gateway.sendExecutorRequest({
        requestId: "req-1",
        appName: "test-app",
        leaseId: "lease-1",
      });
      await waitFor(() => blocking.started);

      // Wait until the worker extends with the renewed lease, so the lease
      // has rotated once before the worker thread dies.
      await waitFor(() =>
        gateway
          .getMessagesOfType(GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE)
          .some(
            (msg) =>
              WorkerRequestExtendLeaseData.decode(msg.payload).leaseId ===
              "lease-2",
          ),
      );

      const firstClient = gateway.lastClient;
      await getWorker(strategy).terminate();
      return firstClient;
    }

    it("resumes lease extension and delivers the reply of a step that finishes after the respawn", async () => {
      const blocking = createBlockingHandler();
      const firstClient = await startStepAndKillWorker(blocking);

      // The respawned worker opens a new connection.
      await waitFor(() => gateway.connectionCount === 2);
      const secondClient = gateway.lastClient;
      expect(secondClient).not.toBe(firstClient);

      // The new worker keeps extending the lease, with the renewed lease ID.
      const extendLease = await gateway.waitForMessage(
        GatewayMessageType.WORKER_REQUEST_EXTEND_LEASE,
        5_000,
      );
      const extendLeaseData = WorkerRequestExtendLeaseData.decode(
        extendLease.payload,
      );
      expect(extendLeaseData.requestId).toBe("req-1");
      expect(extendLeaseData.leaseId).toBe("lease-2");

      // The step finishes and the new worker sends its reply.
      const replyPromise = gateway.waitForMessage(
        GatewayMessageType.WORKER_REPLY,
        5_000,
      );
      blocking.release();
      const reply = await replyPromise;
      expect(SDKResponse.decode(reply.payload).requestId).toBe("req-1");
    }, 30_000);

    it("delivers the reply of a step that finishes while the worker is down", async () => {
      const blocking = createBlockingHandler();
      await startStepAndKillWorker(blocking);

      // The step finishes before the worker respawns.
      const replyPromise = gateway.waitForMessage(
        GatewayMessageType.WORKER_REPLY,
        15_000,
      );
      blocking.release();

      const reply = await replyPromise;
      expect(gateway.connectionCount).toBe(2);
      expect(SDKResponse.decode(reply.payload).requestId).toBe("req-1");
    }, 30_000);
  },
);
