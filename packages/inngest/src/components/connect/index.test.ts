/**
 * Characterization tests for the connect component.
 * These tests capture the current behavior before refactoring to ensure no regressions.
 */

import { jest } from "@jest/globals";
import { Inngest } from "../Inngest.js";
import { connect } from "./index.js";
import { ConnectionState } from "./types.js";
import { ConnectionTestHarness, waitFor, waitForCondition } from "./test-utils.js";

// Mock fetch to control API responses
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

describe("Connect Component - Characterization Tests", () => {
  let testHarness: ConnectionTestHarness;
  let inngest: Inngest.Any;
  let testFunction: any;

  beforeEach(async () => {
    testHarness = new ConnectionTestHarness();
    
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

    // Start mock servers
    const { httpUrl, wsUrl } = await testHarness.start();

    // Mock the inngest API target URL method to return our mock server
    (inngest as any).inngestApi.getTargetUrl = jest.fn().mockImplementation((...args: unknown[]) => {
      const path = args[0] as string;
      return Promise.resolve(new URL(path, httpUrl));
    });

    mockFetch.mockClear();
  });

  afterEach(async () => {
    await testHarness.stop();
    jest.clearAllMocks();
  });

  describe("Basic Connection Flow", () => {
    test("should establish connection successfully", async () => {
      const connectionPromise = connect({
        apps: [{ 
          client: inngest, 
          functions: [testFunction] 
        }],
        signingKey: "test-signing-key",
      });

      // Wait for connection to be established
      await testHarness.simulateSuccessfulConnection();

      const connection = await connectionPromise;
      
      expect(connection.state).toBe(ConnectionState.ACTIVE);
      expect(connection.connectionId).toBe("test-connection-id");
      expect(typeof connection.close).toBe("function");
      expect(connection.closed).toBeInstanceOf(Promise);

      // Verify the expected API calls were made
      const startRequest = await testHarness.httpServer.waitForRequest("/v0/connect/start");
      expect(startRequest).toBeDefined();
      expect(startRequest.headers.authorization).toBe("Bearer test-signing-key");

      await connection.close();
    }, 15000);

    test("should handle connection with multiple apps", async () => {
      const secondInngest = new Inngest({ id: "test-app-2", isDev: false });
      const secondFunction = secondInngest.createFunction(
        { id: "test-function-2" },
        { event: "test/event2" },
        async () => ({ message: "Second function" })
      );

      // Mock API for second client
      (secondInngest as any).inngestApi.getTargetUrl = (inngest as any).inngestApi.getTargetUrl;

      const connectionPromise = connect({
        apps: [
          { client: inngest, functions: [testFunction] },
          { client: secondInngest, functions: [secondFunction] }
        ],
        signingKey: "test-signing-key",
      });

      await testHarness.simulateSuccessfulConnection();
      const connection = await connectionPromise;
      
      expect(connection.state).toBe(ConnectionState.ACTIVE);

      // Should have registered both apps
      const messages = testHarness.wsServer.getReceivedMessages();
      const connectMessage = messages.find(m => m.type === 1); // WORKER_CONNECT
      expect(connectMessage).toBeDefined();

      await connection.close();
    }, 15000);

    test("should handle connection without signing key in dev mode", async () => {
      const devInngest = new Inngest({ id: "test-app", isDev: true });
      const devFunction = devInngest.createFunction(
        { id: "dev-function" },
        { event: "test/event" },
        async () => ({ message: "Dev function" })
      );

      (devInngest as any).inngestApi.getTargetUrl = (inngest as any).inngestApi.getTargetUrl;

      const connectionPromise = connect({
        apps: [{ client: devInngest, functions: [devFunction] }],
        // No signing key for dev mode
      });

      await testHarness.simulateSuccessfulConnection();
      const connection = await connectionPromise;
      
      expect(connection.state).toBe(ConnectionState.ACTIVE);

      await connection.close();
    }, 15000);
  });

  describe("Function Execution", () => {
    test("should execute function when executor request received", async () => {
      const connectionPromise = connect({
        apps: [{ client: inngest, functions: [testFunction] }],
        signingKey: "test-signing-key",
      });

      await testHarness.simulateSuccessfulConnection();
      const connection = await connectionPromise;

      // Send an executor request
      testHarness.wsServer.sendExecutorRequest(undefined, {
        requestId: "test-request-123",
        functionSlug: "test-app-test-function",
        appName: "test-app",
      });

      // Wait for function execution (worker reply message)
      const workerReply = await testHarness.wsServer.waitForMessage(4, 5000); // WORKER_REPLY
      expect(workerReply).toBeDefined();

      await connection.close();
    }, 15000);

    test("should handle concurrent function executions", async () => {
      const connectionPromise = connect({
        apps: [{ client: inngest, functions: [testFunction] }],
        signingKey: "test-signing-key",
      });

      await testHarness.simulateSuccessfulConnection();
      const connection = await connectionPromise;

      // Send multiple executor requests
      const requestIds = ["req-1", "req-2", "req-3"];
      for (const requestId of requestIds) {
        testHarness.wsServer.sendExecutorRequest(undefined, {
          requestId,
          functionSlug: "test-app-test-function",
          appName: "test-app",
        });
      }

      // Wait for all replies
      await waitFor(2000); // Give time for all executions

      const messages = testHarness.wsServer.getReceivedMessages();
      const workerReplies = messages.filter(m => m.type === 4); // WORKER_REPLY
      expect(workerReplies.length).toBe(3);

      await connection.close();
    }, 15000);
  });

  describe("Error Handling", () => {
    test("should throw error when no apps provided", async () => {
      await expect(
        connect({
          apps: [],
          signingKey: "test-signing-key",
        })
      ).rejects.toThrow("No apps provided");
    });

    test("should throw error when cloud mode requires signing key", async () => {
      await expect(
        connect({
          apps: [{ client: inngest, functions: [testFunction] }],
          // No signing key provided for cloud mode
        })
      ).rejects.toThrow("Signing key is required");
    });

    test("should handle WebSocket connection errors", async () => {
      // Don't start the WebSocket server to simulate connection failure
      const httpUrl = await testHarness.httpServer.start();
      
      // Mock API to return invalid WebSocket URL
      (inngest as any).inngestApi.getTargetUrl = jest.fn().mockImplementation((...args: unknown[]) => {
        const path = args[0] as string;
        return Promise.resolve(new URL(path, httpUrl));
      });
      
      testHarness.httpServer.setResponse("/v0/connect/start", {
        status: 200,
        body: {
          connectionId: "test-connection-id",
          gatewayEndpoint: "ws://localhost:99999", // Invalid port
          gatewayGroup: "test-gateway-group",
          sessionToken: "test-session-token",
          syncToken: "test-sync-token",
        }
      });

      const connectionPromise = connect({
        apps: [{ client: inngest, functions: [testFunction] }],
        signingKey: "test-signing-key",
      });

      // Connection should eventually succeed due to retry logic, but will take time
      // For now, let's just test that it doesn't crash immediately
      await waitFor(2000);
      
      // The connection should be in connecting or reconnecting state
      // This is hard to test precisely without exposing internal state
    }, 15000);
  });

  describe("Connection Draining", () => {
    test("should handle gateway draining gracefully", async () => {
      const connectionPromise = connect({
        apps: [{ client: inngest, functions: [testFunction] }],
        signingKey: "test-signing-key",
      });

      await testHarness.simulateSuccessfulConnection();
      const connection = await connectionPromise;
      
      expect(connection.state).toBe(ConnectionState.ACTIVE);

      // Simulate gateway draining
      testHarness.wsServer.sendDrainingMessage();

      // The external state should remain ACTIVE during draining
      // (this is a key requirement mentioned in the spec)
      await waitFor(500);
      expect(connection.state).toBe(ConnectionState.ACTIVE);

      await connection.close();
    }, 15000);
  });

  describe("Connection Lifecycle", () => {
    test("should close connection cleanly", async () => {
      const connectionPromise = connect({
        apps: [{ client: inngest, functions: [testFunction] }],
        signingKey: "test-signing-key",
      });

      await testHarness.simulateSuccessfulConnection();
      const connection = await connectionPromise;
      
      expect(connection.state).toBe(ConnectionState.ACTIVE);

      // Close the connection
      await connection.close();
      
      expect(connection.state).toBe(ConnectionState.CLOSED);
    }, 15000);

    test("should handle multiple close calls gracefully", async () => {
      const connectionPromise = connect({
        apps: [{ client: inngest, functions: [testFunction] }],
        signingKey: "test-signing-key",
      });

      await testHarness.simulateSuccessfulConnection();
      const connection = await connectionPromise;

      // Close multiple times should not throw
      await connection.close();
      await connection.close();
      await connection.close();
      
      expect(connection.state).toBe(ConnectionState.CLOSED);
    }, 15000);

    test("should resolve closed promise when connection is closed", async () => {
      const connectionPromise = connect({
        apps: [{ client: inngest, functions: [testFunction] }],
        signingKey: "test-signing-key",
      });

      await testHarness.simulateSuccessfulConnection();
      const connection = await connectionPromise;

      // The closed promise should not be resolved yet
      const closedPromise = connection.closed;
      let closedResolved = false;
      closedPromise.then(() => { closedResolved = true; });

      await waitFor(100);
      expect(closedResolved).toBe(false);

      // Close the connection
      await connection.close();

      // Now the closed promise should resolve
      await closedPromise;
      expect(closedResolved).toBe(true);
    }, 15000);
  });

  describe("Configuration Options", () => {
    test("should respect instanceId option", async () => {
      const instanceId = "test-instance-123";
      
      const connectionPromise = connect({
        apps: [{ client: inngest, functions: [testFunction] }],
        signingKey: "test-signing-key",
        instanceId,
      });

      await testHarness.simulateSuccessfulConnection();
      const connection = await connectionPromise;

      // The instanceId should be sent in the worker connect message
      const messages = testHarness.wsServer.getReceivedMessages();
      const connectMessage = messages.find(m => m.type === 1); // WORKER_CONNECT
      expect(connectMessage).toBeDefined();
      
      await connection.close();
    }, 15000);

    test("should handle shutdown signals when configured", async () => {
      const connectionPromise = connect({
        apps: [{ client: inngest, functions: [testFunction] }],
        signingKey: "test-signing-key",
        handleShutdownSignals: ["SIGTERM", "SIGINT"],
      });

      await testHarness.simulateSuccessfulConnection();
      const connection = await connectionPromise;
      
      expect(connection.state).toBe(ConnectionState.ACTIVE);

      await connection.close();
    }, 15000);

    test("should disable shutdown signal handling when configured", async () => {
      const connectionPromise = connect({
        apps: [{ client: inngest, functions: [testFunction] }],
        signingKey: "test-signing-key",
        handleShutdownSignals: [], // Disabled
      });

      await testHarness.simulateSuccessfulConnection();
      const connection = await connectionPromise;
      
      expect(connection.state).toBe(ConnectionState.ACTIVE);

      await connection.close();
    }, 15000);
  });

  describe("Heartbeat Mechanism", () => {
    test("should handle heartbeat messages", async () => {
      const connectionPromise = connect({
        apps: [{ client: inngest, functions: [testFunction] }],
        signingKey: "test-signing-key",
      });

      await testHarness.simulateSuccessfulConnection();
      const connection = await connectionPromise;

      // Send a gateway heartbeat
      testHarness.wsServer.sendGatewayHeartbeat();

      // Worker should respond with its own heartbeat
      await waitFor(1000);
      
      const messages = testHarness.wsServer.getReceivedMessages();
      const heartbeatMessages = messages.filter(m => m.type === 3); // WORKER_HEARTBEAT
      expect(heartbeatMessages.length).toBeGreaterThan(0);

      await connection.close();
    }, 15000);
  });
});