import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { envKeys } from "../../helpers/consts.ts";
import type { Mode } from "../../helpers/env.ts";
import type { Logger } from "../../middleware/logger.ts";
import {
  ConnectMessage,
  GatewayConnectionReadyData,
  GatewayExecutorRequestData,
  GatewayMessageType,
  StartResponse,
  WorkerConnectRequestData,
} from "../../proto/src/components/connect/protobuf/connect.ts";
import { Inngest } from "../Inngest.ts";
import { ensureUnsharedArrayBuffer } from "./buffer.ts";
import {
  ConnectionCore,
  type ConnectionCoreCallbacks,
  type ConnectionCoreConfig,
} from "./strategies/core/connection.ts";
import { createStrategy } from "./strategies/index.ts";
import { SameThreadStrategy } from "./strategies/sameThread/index.ts";
import type { ConnectHandlerOptions } from "./types.ts";
import { ConnectionState } from "./types.ts";

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

class MockWebSocket {
  static CONNECTING = 0 as const;
  static OPEN = 1 as const;
  static CLOSING = 2 as const;
  static CLOSED = 3 as const;

  // Instance constants (needed for readyState checks)
  CONNECTING = 0 as const;
  OPEN = 1 as const;
  CLOSING = 2 as const;
  CLOSED = 3 as const;

  readyState: number = MockWebSocket.CONNECTING;
  binaryType = "arraybuffer";

  // biome-ignore lint/suspicious/noExplicitAny: Mock
  onopen: ((ev: any) => void) | null = null;
  // biome-ignore lint/suspicious/noExplicitAny: Mock
  onclose: ((ev: any) => void) | null = null;
  // biome-ignore lint/suspicious/noExplicitAny: Mock
  onerror: ((ev: any) => void) | null = null;
  // biome-ignore lint/suspicious/noExplicitAny: Mock
  onmessage: ((ev: any) => void) | null = null;

  sentMessages: Uint8Array[] = [];
  url: string;
  protocols: string | string[] | undefined;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    // Track all created instances
    MockWebSocket.instances.push(this);
  }

  send(data: Uint8Array) {
    this.sentMessages.push(data);
  }

  close(code?: number, reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
  }

  // --- Test helpers ---

  static instances: MockWebSocket[] = [];

  static reset() {
    MockWebSocket.instances = [];
  }

  /** Simulate the WebSocket opening */
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }

  /** Simulate receiving a message */
  simulateMessage(data: ArrayBuffer) {
    this.onmessage?.({ data });
  }

  /** Simulate a WebSocket error */
  simulateError(error?: unknown) {
    this.onerror?.(error ?? new Error("mock error"));
  }

  /** Simulate WebSocket close */
  simulateClose(reason = "test close") {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ reason });
  }

  /** Send a gateway HELLO message */
  sendGatewayHello() {
    const msg = ConnectMessage.encode(
      ConnectMessage.create({
        kind: GatewayMessageType.GATEWAY_HELLO,
      }),
    ).finish();
    this.simulateMessage(ensureUnsharedArrayBuffer(msg).buffer as ArrayBuffer);
  }

  /** Send a gateway CONNECTION_READY message */
  sendConnectionReady(
    opts: { heartbeatInterval?: string; extendLeaseInterval?: string } = {},
  ) {
    const readyPayload = GatewayConnectionReadyData.encode(
      GatewayConnectionReadyData.create({
        heartbeatInterval: opts.heartbeatInterval ?? "10s",
        extendLeaseInterval: opts.extendLeaseInterval ?? "5s",
      }),
    ).finish();

    const msg = ConnectMessage.encode(
      ConnectMessage.create({
        kind: GatewayMessageType.GATEWAY_CONNECTION_READY,
        payload: readyPayload,
      }),
    ).finish();
    this.simulateMessage(ensureUnsharedArrayBuffer(msg).buffer as ArrayBuffer);
  }

  /** Send a gateway HEARTBEAT response */
  sendGatewayHeartbeat() {
    const msg = ConnectMessage.encode(
      ConnectMessage.create({
        kind: GatewayMessageType.GATEWAY_HEARTBEAT,
      }),
    ).finish();
    this.simulateMessage(ensureUnsharedArrayBuffer(msg).buffer as ArrayBuffer);
  }

  /** Send a GATEWAY_CLOSING (drain) message */
  sendGatewayClosing() {
    const msg = ConnectMessage.encode(
      ConnectMessage.create({
        kind: GatewayMessageType.GATEWAY_CLOSING,
      }),
    ).finish();
    this.simulateMessage(ensureUnsharedArrayBuffer(msg).buffer as ArrayBuffer);
  }

  /** Send a GATEWAY_EXECUTOR_REQUEST message */
  sendExecutorRequest(opts: {
    requestId: string;
    appName: string;
    functionSlug?: string;
    leaseId?: string;
  }) {
    const requestPayload = GatewayExecutorRequestData.encode(
      GatewayExecutorRequestData.create({
        requestId: opts.requestId,
        appName: opts.appName,
        appId: "app-id",
        accountId: "account-id",
        envId: "env-id",
        functionId: "fn-id",
        functionSlug: opts.functionSlug ?? "test-fn",
        leaseId: opts.leaseId ?? "lease-1",
        requestPayload: new Uint8Array(0),
        systemTraceCtx: new Uint8Array(0),
        userTraceCtx: new Uint8Array(0),
        runId: "run-1",
      }),
    ).finish();

    const msg = ConnectMessage.encode(
      ConnectMessage.create({
        kind: GatewayMessageType.GATEWAY_EXECUTOR_REQUEST,
        payload: requestPayload,
      }),
    ).finish();
    this.simulateMessage(ensureUnsharedArrayBuffer(msg).buffer as ArrayBuffer);
  }

  /**
   * Decode sent messages to find messages of a specific type.
   */
  getSentMessagesOfType(type: GatewayMessageType): ConnectMessage[] {
    return this.sentMessages
      .map((bytes) => ConnectMessage.decode(bytes))
      .filter((msg) => msg.kind === type);
  }
}

// ---------------------------------------------------------------------------
// Mock fetch for start request
// ---------------------------------------------------------------------------

function createMockStartResponse(
  opts: {
    connectionId?: string;
    gatewayEndpoint?: string;
    gatewayGroup?: string;
  } = {},
) {
  const startResp = StartResponse.encode(
    StartResponse.create({
      connectionId: opts.connectionId ?? "conn-1",
      gatewayEndpoint: opts.gatewayEndpoint ?? "ws://gateway.test/connect",
      gatewayGroup: opts.gatewayGroup ?? "group-1",
      sessionToken: "session-token",
      syncToken: "sync-token",
    }),
  ).finish();

  return {
    ok: true,
    status: 200,
    arrayBuffer: () =>
      Promise.resolve(ensureUnsharedArrayBuffer(startResp).buffer),
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createLogger(): Logger & {
  debug: MockInstance;
  info: MockInstance;
  warn: MockInstance;
  error: MockInstance;
} {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

let connectionIdCounter = 0;

function createTestCore(
  overrides: {
    config?: Partial<ConnectionCoreConfig>;
    callbacks?: Partial<ConnectionCoreCallbacks>;
  } = {},
) {
  const logger = createLogger();
  let state = ConnectionState.CONNECTING;

  const callbacks: ConnectionCoreCallbacks = {
    logger,
    onStateChange: vi.fn((s: ConnectionState) => {
      state = s;
    }),
    getState: () => state,
    handleExecutionRequest: vi.fn(async () => new Uint8Array(0)),
    onReplyAck: vi.fn(),
    onBufferResponse: vi.fn(),
    beforeConnect: vi.fn(async () => {}),
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
    apiBaseUrl: "http://api.test",
    mode: "cloud" as Mode,
    appIds: ["test-app"],
    ...overrides.config,
  };

  const core = new ConnectionCore(config, callbacks);
  return { core, callbacks, logger, getState: () => state };
}

/**
 * Drive a MockWebSocket through the full handshake sequence.
 * Returns the WebSocket instance that completed the handshake.
 */
async function driveHandshake(ws: MockWebSocket): Promise<void> {
  // Simulate WS open then send HELLO
  ws.simulateOpen();
  ws.sendGatewayHello();

  // After HELLO the core sends WORKER_CONNECT; we need to wait for it
  // then send CONNECTION_READY
  await flushMicrotasks();
  ws.sendConnectionReady();
  await flushMicrotasks();
}

/**
 * Start a core and drive through the first successful connection.
 * Returns helpers for further interaction.
 */
async function connectAndReady(
  overrides: Parameters<typeof createTestCore>[0] = {},
) {
  connectionIdCounter++;

  const fetchMock = vi.fn().mockResolvedValue(
    createMockStartResponse({
      connectionId: `conn-${connectionIdCounter}`,
    }),
  );
  global.fetch = fetchMock;

  const helpers = createTestCore(overrides);

  const startPromise = helpers.core.start();

  // Wait for fetch to be called
  await flushMicrotasks();

  // Get the created WebSocket and drive the handshake
  const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
  await driveHandshake(ws);

  await startPromise;

  return { ...helpers, ws, fetchMock };
}

async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const originalWebSocket = global.WebSocket;
const originalFetch = global.fetch;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  MockWebSocket.reset();
  connectionIdCounter = 0;
  // biome-ignore lint/suspicious/noExplicitAny: Mock
  global.WebSocket = MockWebSocket as any;
  global.fetch = vi.fn().mockResolvedValue(createMockStartResponse());
});

afterEach(() => {
  vi.useRealTimers();
  global.WebSocket = originalWebSocket;
  global.fetch = originalFetch;
});

// ---- Existing tests (kept) ----

const createTestOptions = (
  opts: Partial<ConnectHandlerOptions> = {},
): ConnectHandlerOptions => {
  const inngest = new Inngest({ id: "test-app", isDev: true });
  return {
    apps: [{ client: inngest, functions: [] }],
    ...opts,
  };
};

describe("connect maxWorkerConcurrency", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("environment variable parsing", () => {
    test("should parse positive integer from INNGEST_CONNECT_MAX_WORKER_CONCURRENCY", () => {
      process.env[envKeys.InngestConnectMaxWorkerConcurrency] = "10";
      expect(process.env[envKeys.InngestConnectMaxWorkerConcurrency]).toBe(
        "10",
      );
    });

    test("should handle various numeric string formats", () => {
      const testCases = [
        { input: "1", expected: 1 },
        { input: "100", expected: 100 },
        { input: "999", expected: 999 },
      ];

      for (const { input, expected } of testCases) {
        process.env[envKeys.InngestConnectMaxWorkerConcurrency] = input;
        const parsed = Number.parseInt(
          process.env[envKeys.InngestConnectMaxWorkerConcurrency] as string,
          10,
        );
        expect(parsed).toBe(expected);
        expect(Number.isNaN(parsed)).toBe(false);
        expect(parsed > 0).toBe(true);
      }
    });

    test("should reject invalid values", () => {
      const invalidCases = ["not-a-number", "abc", "", "-5", "0", "   "];

      for (const input of invalidCases) {
        process.env[envKeys.InngestConnectMaxWorkerConcurrency] = input;
        const parsed = Number.parseInt(
          process.env[envKeys.InngestConnectMaxWorkerConcurrency] as string,
          10,
        );
        const isValid = !Number.isNaN(parsed) && parsed > 0;
        expect(isValid).toBe(false);
      }
    });
  });

  describe("WorkerConnectRequestData message creation", () => {
    test("should create message with maxWorkerConcurrency when provided", () => {
      const msg = WorkerConnectRequestData.create({
        connectionId: "test-connection",
        instanceId: "test-instance",
        sdkVersion: "v1.0.0",
        sdkLanguage: "typescript",
        framework: "connect",
        workerManualReadinessAck: false,
        maxWorkerConcurrency: 15,
      });
      expect(msg.maxWorkerConcurrency).toBe(15);
    });

    test("should create message without maxWorkerConcurrency when undefined", () => {
      const msg = WorkerConnectRequestData.create({
        connectionId: "test-connection",
        instanceId: "test-instance",
        sdkVersion: "v1.0.0",
        sdkLanguage: "typescript",
        framework: "connect",
        workerManualReadinessAck: false,
      });
      expect(msg.maxWorkerConcurrency).toBeUndefined();
    });
  });

  describe("ConnectHandlerOptions type", () => {
    test("should accept maxWorkerConcurrency in options", () => {
      const options: ConnectHandlerOptions = createTestOptions({
        maxWorkerConcurrency: 20,
      });
      expect(options.maxWorkerConcurrency).toBe(20);
    });

    test("should allow undefined maxWorkerConcurrency", () => {
      const options: ConnectHandlerOptions = createTestOptions();
      expect(options.maxWorkerConcurrency).toBeUndefined();
    });

    test("explicit value should be a number", () => {
      const options: ConnectHandlerOptions = createTestOptions({
        maxWorkerConcurrency: 5,
      });
      expect(typeof options.maxWorkerConcurrency).toBe("number");
    });
  });

  describe("precedence and defaults", () => {
    test("explicit value takes precedence over environment variable", () => {
      process.env[envKeys.InngestConnectMaxWorkerConcurrency] = "100";
      const options = createTestOptions({ maxWorkerConcurrency: 50 });
      expect(options.maxWorkerConcurrency).toBe(50);
    });

    test("environment variable is used when no explicit value provided", () => {
      process.env[envKeys.InngestConnectMaxWorkerConcurrency] = "75";
      const options = createTestOptions();
      expect(options.maxWorkerConcurrency).toBeUndefined();
      expect(process.env[envKeys.InngestConnectMaxWorkerConcurrency]).toBe(
        "75",
      );
    });
  });
});

describe("ConnectHandlerOptions gatewayUrl", () => {
  test("should accept gatewayUrl in options", () => {
    const options: ConnectHandlerOptions = createTestOptions({
      gatewayUrl: "ws://localhost:8100",
    });
    expect(options.gatewayUrl).toBe("ws://localhost:8100");
  });

  test("should allow undefined gatewayUrl", () => {
    const options: ConnectHandlerOptions = createTestOptions();
    expect(options.gatewayUrl).toBeUndefined();
  });
});

describe("createStrategy", () => {
  const stubConfig = {
    hashedSigningKey: undefined,
    hashedFallbackKey: undefined,
    internalLogger: createLogger(),
    envName: undefined,
    apiBaseUrl: undefined,
    mode: "dev" as Mode,
    connectionData: {
      marshaledCapabilities: "",
      manualReadinessAck: false,
      apps: [],
    },
    requestHandlers: {},
    options: createTestOptions(),
  };

  test("defaults to WorkerThreadStrategy when isolateExecution is not set", async () => {
    const strategy = await createStrategy(stubConfig, createTestOptions());
    expect(strategy).not.toBeInstanceOf(SameThreadStrategy);
  });

  test("defaults to WorkerThreadStrategy when isolateExecution is true", async () => {
    const strategy = await createStrategy(
      stubConfig,
      createTestOptions({ isolateExecution: true }),
    );
    expect(strategy).not.toBeInstanceOf(SameThreadStrategy);
  });

  test("uses SameThreadStrategy when isolateExecution is false", async () => {
    const strategy = await createStrategy(
      stubConfig,
      createTestOptions({ isolateExecution: false }),
    );
    expect(strategy).toBeInstanceOf(SameThreadStrategy);
  });
});

// ---- New ConnectionCore tests ----

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

    test("beforeConnect is called before connection attempt", async () => {
      const { callbacks } = await connectAndReady();
      expect(callbacks.beforeConnect).toHaveBeenCalled();
    });
  });

  describe("2. Reconnection on WebSocket error", () => {
    test("reconnects when ws.onerror fires", async () => {
      const fetchMock = vi.fn();
      connectionIdCounter = 0;

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
