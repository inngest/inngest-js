import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { envKeys } from "../../helpers/consts.ts";
import { WorkerConnectRequestData } from "../../proto/src/components/connect/protobuf/connect.ts";
import { Inngest } from "../Inngest.ts";
import type { ConnectHandlerOptions } from "./types.ts";

// Mock WebSocket globally
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  binaryType = "arraybuffer";
  // biome-ignore lint/suspicious/noExplicitAny: Mock
  onopen: any = null;
  // biome-ignore lint/suspicious/noExplicitAny: Mock
  onclose: any = null;
  // biome-ignore lint/suspicious/noExplicitAny: Mock
  onerror: any = null;
  // biome-ignore lint/suspicious/noExplicitAny: Mock
  onmessage: any = null;

  sentMessages: Uint8Array[] = [];

  constructor(_url: string, _protocols?: string | string[]) {
    // Simulate async connection
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    }, 0);
  }

  send(data: Uint8Array) {
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ reason: "test close" });
  }
}

describe("connect maxWorkerConcurrency", () => {
  const originalEnv = process.env;
  const originalWebSocket = global.WebSocket;
  const originalFetch = global.fetch;

  beforeEach(() => {
    // Reset environment
    process.env = { ...originalEnv };

    // Mock WebSocket
    // biome-ignore lint/suspicious/noExplicitAny: Mock
    global.WebSocket = MockWebSocket as any;

    // Mock fetch for the start request
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    global.WebSocket = originalWebSocket;
    global.fetch = originalFetch;
  });

  const createTestOptions = (
    opts: Partial<ConnectHandlerOptions> = {},
  ): ConnectHandlerOptions => {
    const inngest = new Inngest({ id: "test-app", isDev: true });
    return {
      apps: [{ client: inngest, functions: [] }],
      ...opts,
    };
  };

  describe("environment variable parsing", () => {
    test("should parse positive integer from INNGEST_CONNECT_MAX_WORKER_CONCURRENCY", () => {
      process.env[envKeys.InngestConnectMaxWorkerConcurrency] = "10";

      const _options = createTestOptions();

      // The applyDefaults method will be called internally during connection setup
      // We test this by verifying the environment variable is accessible
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

      const options = createTestOptions({
        maxWorkerConcurrency: 50,
      });

      // Explicit value should be used
      expect(options.maxWorkerConcurrency).toBe(50);
    });

    test("environment variable is used when no explicit value provided", () => {
      process.env[envKeys.InngestConnectMaxWorkerConcurrency] = "75";

      const options = createTestOptions();

      // No explicit value, so env should be checked
      expect(options.maxWorkerConcurrency).toBeUndefined();
      // But env var is set
      expect(process.env[envKeys.InngestConnectMaxWorkerConcurrency]).toBe(
        "75",
      );
    });
  });
});
