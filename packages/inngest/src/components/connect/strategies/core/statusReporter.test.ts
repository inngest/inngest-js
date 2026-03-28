import { WaitGroup } from "@jpwilliams/waitgroup";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  ConnectMessage,
  GatewayMessageType,
  WorkerStatusData,
} from "../../../../proto/src/components/connect/protobuf/connect.ts";
import type { Connection } from "./connection.ts";
import { StatusReporter } from "./statusReporter.ts";
import type { ConnectionAccessor } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const hasNativeWebSocket = typeof globalThis.WebSocket !== "undefined";

function createMockWs(readyState: number = WebSocket.OPEN) {
  return {
    send: vi.fn(),
    readyState,
    close: vi.fn(),
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    binaryType: "arraybuffer",
    url: "ws://gateway.test/connect",
    CONNECTING: 0 as const,
    OPEN: 1 as const,
    CLOSING: 2 as const,
    CLOSED: 3 as const,
  } as unknown as WebSocket;
}

function createAccessor(
  overrides: Partial<ConnectionAccessor> = {},
): ConnectionAccessor {
  const ws = createMockWs();
  return {
    activeConnection: {
      id: "conn-1",
      ws,
      pendingHeartbeats: 0,
      dead: false,
      heartbeatIntervalMs: 10_000,
      extendLeaseIntervalMs: 5_000,
      statusIntervalMs: 0,
      close: () => {},
    } as Connection,
    drainingConnection: undefined,
    shutdownRequested: false,
    inProgressRequests: {
      wg: new WaitGroup(),
      requestLeases: {},
      requestMeta: {},
    },
    appIds: ["test-app"],
    ...overrides,
  };
}

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

/** Decode the first call's argument into ConnectMessage + WorkerStatusData. */
function decodeSentStatus(ws: WebSocket) {
  const sendMock = ws.send as ReturnType<typeof vi.fn>;
  const bytes = sendMock.mock.calls[sendMock.mock.calls.length - 1]![0];
  const msg = ConnectMessage.decode(new Uint8Array(bytes));
  expect(msg.kind).toBe(GatewayMessageType.WORKER_STATUS);
  const status = WorkerStatusData.decode(msg.payload);
  return { msg, status };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!hasNativeWebSocket)("StatusReporter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("sends WORKER_STATUS on each tick", () => {
    const accessor = createAccessor();
    const reporter = new StatusReporter(accessor, logger);

    reporter.updateInterval(100);
    vi.advanceTimersByTime(100);

    const ws = accessor.activeConnection!.ws;
    expect((ws.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    const { msg, status } = decodeSentStatus(ws);
    expect(msg.kind).toBe(GatewayMessageType.WORKER_STATUS);
    expect(status.inFlightRequestIds).toEqual([]);
    expect(status.shutdownRequested).toBe(false);

    reporter.stop();
  });

  test("does not send when interval is 0", () => {
    const accessor = createAccessor();
    const reporter = new StatusReporter(accessor, logger);

    reporter.updateInterval(0);
    vi.advanceTimersByTime(1000);

    const ws = accessor.activeConnection!.ws;
    expect((ws.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);

    reporter.stop();
  });

  test("stops sending after stop()", () => {
    const accessor = createAccessor();
    const reporter = new StatusReporter(accessor, logger);

    reporter.updateInterval(100);
    vi.advanceTimersByTime(100);

    const ws = accessor.activeConnection!.ws;
    expect((ws.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    reporter.stop();
    vi.advanceTimersByTime(500);

    expect((ws.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  test("skips send when no active connection", () => {
    const accessor = createAccessor({ activeConnection: undefined });
    const reporter = new StatusReporter(accessor, logger);

    reporter.updateInterval(100);
    vi.advanceTimersByTime(100);

    // No error thrown, no send attempted
    reporter.stop();
  });

  test("skips send when WebSocket is not OPEN", () => {
    const ws = createMockWs(WebSocket.CLOSED);
    const accessor = createAccessor({
      activeConnection: {
        id: "conn-1",
        ws,
        pendingHeartbeats: 0,
        dead: false,
        heartbeatIntervalMs: 10_000,
        extendLeaseIntervalMs: 5_000,
        statusIntervalMs: 0,
        close: () => {},
      },
    });
    const reporter = new StatusReporter(accessor, logger);

    reporter.updateInterval(100);
    vi.advanceTimersByTime(100);

    expect((ws.send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);

    reporter.stop();
  });

  test("includes in-flight request IDs", () => {
    const accessor = createAccessor();
    accessor.inProgressRequests.requestLeases["req-1"] = "lease-1";
    accessor.inProgressRequests.requestLeases["req-2"] = "lease-2";

    const reporter = new StatusReporter(accessor, logger);
    reporter.updateInterval(100);
    vi.advanceTimersByTime(100);

    const { status } = decodeSentStatus(accessor.activeConnection!.ws);
    expect(status.inFlightRequestIds.sort()).toEqual(["req-1", "req-2"].sort());

    reporter.stop();
  });

  test("includes shutdownRequested flag", () => {
    const accessor = createAccessor();
    // Cast to mutable to set the flag
    (accessor as { shutdownRequested: boolean }).shutdownRequested = true;

    const reporter = new StatusReporter(accessor, logger);
    reporter.updateInterval(100);
    vi.advanceTimersByTime(100);

    const { status } = decodeSentStatus(accessor.activeConnection!.ws);
    expect(status.shutdownRequested).toBe(true);

    reporter.stop();
  });

  test("updateInterval restarts timer on change", () => {
    const accessor = createAccessor();
    const reporter = new StatusReporter(accessor, logger);
    const ws = accessor.activeConnection!.ws;
    const sendMock = ws.send as ReturnType<typeof vi.fn>;

    reporter.updateInterval(100);
    vi.advanceTimersByTime(100);
    expect(sendMock.mock.calls.length).toBe(1);

    // Change to longer interval
    reporter.updateInterval(500);
    vi.advanceTimersByTime(200);
    // Should not have sent again yet (only 200ms of 500ms)
    expect(sendMock.mock.calls.length).toBe(1);

    vi.advanceTimersByTime(300);
    // Now 500ms have passed since the interval change
    expect(sendMock.mock.calls.length).toBe(2);

    reporter.stop();
  });

  test("updateInterval is idempotent for same value", () => {
    const accessor = createAccessor();
    const reporter = new StatusReporter(accessor, logger);
    const ws = accessor.activeConnection!.ws;
    const sendMock = ws.send as ReturnType<typeof vi.fn>;

    reporter.updateInterval(100);
    reporter.updateInterval(100); // same value — should not restart

    vi.advanceTimersByTime(100);
    // Only one send, not two (would be two if two intervals were running)
    expect(sendMock.mock.calls.length).toBe(1);

    vi.advanceTimersByTime(100);
    expect(sendMock.mock.calls.length).toBe(2);

    reporter.stop();
  });
});
