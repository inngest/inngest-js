/**
 * Simple characterization tests for the connect component.
 * These tests capture the current behavior before refactoring to ensure no regressions.
 */

import { jest } from "@jest/globals";
import { Inngest } from "../Inngest.js";
import { connect } from "./index.js";
import { ConnectionState } from "./types.js";

// Mock fetch globally
const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch;

// Mock WebSocket globally since we can't easily test real WebSocket connections
const mockWebSocket = {
  readyState: 1, // OPEN
  send: jest.fn(),
  close: jest.fn(),
  addEventListener: jest.fn(),
  removeEventListener: jest.fn(),
  onopen: null,
  onclose: null,
  onerror: null,
  onmessage: null,
};

const mockWebSocketConstructor = jest.fn().mockImplementation(() => mockWebSocket);
global.WebSocket = mockWebSocketConstructor as any;

describe("Connect Component - Basic Characterization Tests", () => {
  let inngest: Inngest.Any;
  let testFunction: any;

  beforeEach(async () => {
    // Create test Inngest client
    inngest = new Inngest({ 
      id: "test-app",
      isDev: false,
    });

    // Create a test function
    testFunction = inngest.createFunction(
      { id: "test-function" },
      { event: "test/event" },
      async ({ event, step }) => {
        return { message: "Function executed", data: event.data };
      }
    );

    // Reset mocks
    mockFetch.mockClear();
    (mockWebSocket.send as jest.Mock).mockClear();
    (mockWebSocket.close as jest.Mock).mockClear();
    mockWebSocketConstructor.mockClear();

    // Mock successful HTTP responses
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)), // StartResponse
      } as Response)
      .mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)), // FlushResponse  
      } as Response);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("Basic API Tests", () => {
    test("should throw error when no apps provided", async () => {
      await expect(
        connect({
          apps: [],
          signingKey: "test-signing-key",
        })
      ).rejects.toThrow("No apps provided");
    });

    test("should throw error when cloud mode client requires signing key", async () => {
      await expect(
        connect({
          apps: [{ client: inngest, functions: [testFunction] }],
          // No signing key provided for cloud mode
        })
      ).rejects.toThrow("Signing key is required");
    });

    test("should accept connection with signing key for cloud mode", async () => {
      // This will try to establish connection but should fail gracefully in test environment
      const connectPromise = connect({
        apps: [{ client: inngest, functions: [testFunction] }],
        signingKey: "test-signing-key",
      });

      // The connect function should start attempting connection
      // In the test environment, it will likely fail but shouldn't crash
      
      // Wait a bit and then expect WebSocket to be created
      await new Promise(resolve => setTimeout(resolve, 100));
      
      expect(mockWebSocketConstructor).toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalled();

      // Clean up - try to close the connection
      try {
        const connection = await Promise.race([
          connectPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1000))
        ]);
        if (connection && typeof (connection as any).close === 'function') {
          await (connection as any).close();
        }
      } catch (err) {
        // Expected in test environment
      }
    });

    test("should accept connection without signing key for dev mode", async () => {
      const devInngest = new Inngest({ id: "test-app", isDev: true });
      const devFunction = devInngest.createFunction(
        { id: "dev-function" },
        { event: "test/event" },
        async () => ({ message: "Dev function" })
      );

      const connectPromise = connect({
        apps: [{ client: devInngest, functions: [devFunction] }],
        // No signing key for dev mode
      });

      // Should attempt connection
      await new Promise(resolve => setTimeout(resolve, 100));
      
      expect(mockWebSocketConstructor).toHaveBeenCalled();

      // Clean up
      try {
        const connection = await Promise.race([
          connectPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1000))
        ]);
        if (connection && typeof (connection as any).close === 'function') {
          await (connection as any).close();
        }
      } catch (err) {
        // Expected in test environment
      }
    });

    test("should handle multiple apps", async () => {
      const secondInngest = new Inngest({ id: "test-app-2", isDev: false });
      const secondFunction = secondInngest.createFunction(
        { id: "test-function-2" },
        { event: "test/event2" },
        async () => ({ message: "Second function" })
      );

      const connectPromise = connect({
        apps: [
          { client: inngest, functions: [testFunction] },
          { client: secondInngest, functions: [secondFunction] }
        ],
        signingKey: "test-signing-key",
      });

      // Should attempt connection
      await new Promise(resolve => setTimeout(resolve, 100));
      
      expect(mockWebSocketConstructor).toHaveBeenCalled();

      // Clean up
      try {
        const connection = await Promise.race([
          connectPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1000))
        ]);
        if (connection && typeof (connection as any).close === 'function') {
          await (connection as any).close();
        }
      } catch (err) {
        // Expected in test environment
      }
    });

    test("should reject apps with different environments", async () => {
      const secondInngest = new Inngest({ id: "test-app-2", env: "different-env" });
      const secondFunction = secondInngest.createFunction(
        { id: "test-function-2" },
        { event: "test/event2" },
        async () => ({ message: "Second function" })
      );

      await expect(
        connect({
          apps: [
            { client: inngest, functions: [testFunction] },
            { client: secondInngest, functions: [secondFunction] }
          ],
          signingKey: "test-signing-key",
        })
      ).rejects.toThrow("All apps must be configured to the same environment");
    });
  });

  describe("Configuration Options", () => {
    test("should accept instanceId option", async () => {
      const connectPromise = connect({
        apps: [{ client: inngest, functions: [testFunction] }],
        signingKey: "test-signing-key",
        instanceId: "test-instance-123",
      });

      await new Promise(resolve => setTimeout(resolve, 100));
      expect(mockWebSocketConstructor).toHaveBeenCalled();

      // Clean up
      try {
        const connection = await Promise.race([
          connectPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1000))
        ]);
        if (connection && typeof (connection as any).close === 'function') {
          await (connection as any).close();
        }
      } catch (err) {
        // Expected in test environment
      }
    });

    test("should accept handleShutdownSignals option", async () => {
      const connectPromise = connect({
        apps: [{ client: inngest, functions: [testFunction] }],
        signingKey: "test-signing-key",
        handleShutdownSignals: ["SIGTERM", "SIGINT"],
      });

      await new Promise(resolve => setTimeout(resolve, 100));
      expect(mockWebSocketConstructor).toHaveBeenCalled();

      // Clean up
      try {
        const connection = await Promise.race([
          connectPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1000))
        ]);
        if (connection && typeof (connection as any).close === 'function') {
          await (connection as any).close();
        }
      } catch (err) {
        // Expected in test environment
      }
    });

    test("should accept empty handleShutdownSignals to disable", async () => {
      const connectPromise = connect({
        apps: [{ client: inngest, functions: [testFunction] }],
        signingKey: "test-signing-key",
        handleShutdownSignals: [], // Disabled
      });

      await new Promise(resolve => setTimeout(resolve, 100));
      expect(mockWebSocketConstructor).toHaveBeenCalled();

      // Clean up
      try {
        const connection = await Promise.race([
          connectPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1000))
        ]);
        if (connection && typeof (connection as any).close === 'function') {
          await (connection as any).close();
        }
      } catch (err) {
        // Expected in test environment
      }
    });
  });

  describe("Types and Exports", () => {
    test("ConnectionState enum should have correct values", () => {
      expect(ConnectionState.CONNECTING).toBe("CONNECTING");
      expect(ConnectionState.ACTIVE).toBe("ACTIVE");
      expect(ConnectionState.PAUSED).toBe("PAUSED");
      expect(ConnectionState.RECONNECTING).toBe("RECONNECTING");
      expect(ConnectionState.CLOSING).toBe("CLOSING");
      expect(ConnectionState.CLOSED).toBe("CLOSED");
    });

    test("connect function should be exported", () => {
      expect(typeof connect).toBe("function");
    });
  });
});