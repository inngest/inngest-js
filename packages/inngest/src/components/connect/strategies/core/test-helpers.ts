import { type MockInstance, vi } from "vitest";
import type { Mode } from "../../../../helpers/env.ts";
import type { Logger } from "../../../../middleware/logger.ts";
import {
  ConnectMessage,
  GatewayConnectionReadyData,
  GatewayExecutorRequestData,
  GatewayMessageType,
  StartResponse,
} from "../../../../proto/src/components/connect/protobuf/connect.ts";
import { ensureUnsharedArrayBuffer } from "../../buffer.ts";
import { ConnectionState } from "../../types.ts";
import {
  ConnectionCore,
  type ConnectionCoreCallbacks,
  type ConnectionCoreConfig,
} from "./connection.ts";

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

export class MockWebSocket {
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

export function createMockStartResponse(
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

export function createLogger(): Logger & {
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

export let connectionIdCounter = 0;

export function resetConnectionIdCounter() {
  connectionIdCounter = 0;
}

export function incrementConnectionIdCounter() {
  connectionIdCounter++;
}

export function createTestCore(
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
export async function driveHandshake(ws: MockWebSocket): Promise<void> {
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
export async function connectAndReady(
  overrides: Parameters<typeof createTestCore>[0] = {},
) {
  incrementConnectionIdCounter();

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

export async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Common beforeEach/afterEach setup
// ---------------------------------------------------------------------------

const originalWebSocket = global.WebSocket;
const originalFetch = global.fetch;

export function setupCoreMocks() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  MockWebSocket.reset();
  resetConnectionIdCounter();
  // biome-ignore lint/suspicious/noExplicitAny: Mock
  global.WebSocket = MockWebSocket as any;
  global.fetch = vi.fn().mockResolvedValue(createMockStartResponse());
}

export function teardownCoreMocks() {
  vi.useRealTimers();
  global.WebSocket = originalWebSocket;
  global.fetch = originalFetch;
}
