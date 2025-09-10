/**
 * Tests for the new ComposedWebSocketWorkerConnection
 */

import { jest } from "@jest/globals";
import { ComposedWebSocketWorkerConnection } from "./connection.js";
import { ConnectionState } from "./types.js";
import { Inngest } from "../Inngest.js";

// Mock all external dependencies
jest.mock("./websocket-manager.js");
jest.mock("./message-handler.js");
jest.mock("./buffer.js");
jest.mock("./os.js");

describe("ComposedWebSocketWorkerConnection", () => {
  let inngest: Inngest.Any;
  let testFunction: any;

  beforeEach(() => {
    inngest = new Inngest({ 
      id: "test-app",
      isDev: false,
    });

    testFunction = inngest.createFunction(
      { id: "test-function" },
      { event: "test/event" },
      async ({ event, step }) => {
        return { message: "Function executed", data: event.data };
      }
    );

    jest.clearAllMocks();
  });

  describe("Initialization", () => {
    test("should initialize with correct initial state", () => {
      const connection = new ComposedWebSocketWorkerConnection({
        apps: [{ client: inngest, functions: [testFunction] }],
        signingKey: "test-signing-key",
      });

      expect(connection.state).toBe(ConnectionState.CONNECTING);
      expect(connection.connectionId).toBe("");
    });

    test("should throw error when no apps provided", () => {
      expect(() => {
        new ComposedWebSocketWorkerConnection({
          apps: [],
          signingKey: "test-signing-key",
        });
      }).toThrow("No apps provided");
    });

    test("should accept event hooks in configuration", () => {
      const stateChangeHook = jest.fn();
      const connectedHook = jest.fn();

      const connection = new ComposedWebSocketWorkerConnection({
        apps: [{ client: inngest, functions: [testFunction] }],
        signingKey: "test-signing-key",
        eventHooks: {
          stateChange: stateChangeHook,
          connected: connectedHook,
        },
      });

      expect(connection.state).toBe(ConnectionState.CONNECTING);
    });

    test("should accept custom logger", () => {
      const customLogger = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      };

      const connection = new ComposedWebSocketWorkerConnection({
        apps: [{ client: inngest, functions: [testFunction] }],
        signingKey: "test-signing-key",
        logger: customLogger,
      });

      expect(connection.state).toBe(ConnectionState.CONNECTING);
    });
  });

  describe("Event Listener API", () => {
    test("should support adding and removing event listeners", () => {
      const connection = new ComposedWebSocketWorkerConnection({
        apps: [{ client: inngest, functions: [testFunction] }],
        signingKey: "test-signing-key",
      });

      const stateChangeListener = jest.fn();
      const connectedListener = jest.fn();

      // Add listeners
      const removeStateChange = connection.addEventListener('stateChange', stateChangeListener);
      const removeConnected = connection.addEventListener('connected', connectedListener);

      expect(typeof removeStateChange).toBe('function');
      expect(typeof removeConnected).toBe('function');

      // Remove listeners
      connection.removeEventListener('stateChange', stateChangeListener);
      removeConnected();
    });

    test("should provide state history access", () => {
      const connection = new ComposedWebSocketWorkerConnection({
        apps: [{ client: inngest, functions: [testFunction] }],
        signingKey: "test-signing-key",
      });

      const history = connection.getStateHistory();
      expect(Array.isArray(history)).toBe(true);
      expect(history.length).toBeGreaterThan(0);
      expect(history[0]).toMatchObject({
        state: expect.any(String),
        event: expect.any(String),
        timestamp: expect.any(Number),
      });
    });
  });

  describe("Connection Lifecycle", () => {
    test("should handle graceful close", async () => {
      const connection = new ComposedWebSocketWorkerConnection({
        apps: [{ client: inngest, functions: [testFunction] }],
        signingKey: "test-signing-key",
      });

      const closedPromise = connection.closed;

      // Should not be resolved initially
      let isResolved = false;
      closedPromise.then(() => { isResolved = true; });
      
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(isResolved).toBe(false);

      // Close the connection
      await connection.close();

      // Should be resolved now
      await closedPromise;
      expect(connection.state).toBe(ConnectionState.CLOSED);
    });

    test("should handle multiple close calls gracefully", async () => {
      const connection = new ComposedWebSocketWorkerConnection({
        apps: [{ client: inngest, functions: [testFunction] }],
        signingKey: "test-signing-key",
      });

      // Multiple close calls should not throw
      await Promise.all([
        connection.close(),
        connection.close(),
        connection.close(),
      ]);

      expect(connection.state).toBe(ConnectionState.CLOSED);
    });
  });

  describe("Configuration Options", () => {
    test("should accept instanceId option", () => {
      const connection = new ComposedWebSocketWorkerConnection({
        apps: [{ client: inngest, functions: [testFunction] }],
        signingKey: "test-signing-key",
        instanceId: "test-instance-123",
      });

      expect(connection.state).toBe(ConnectionState.CONNECTING);
    });

    test("should accept shutdown signal configuration", () => {
      const connection = new ComposedWebSocketWorkerConnection({
        apps: [{ client: inngest, functions: [testFunction] }],
        signingKey: "test-signing-key",
        handleShutdownSignals: ["SIGTERM"],
      });

      expect(connection.state).toBe(ConnectionState.CONNECTING);
    });

    test("should accept disabled shutdown signals", () => {
      const connection = new ComposedWebSocketWorkerConnection({
        apps: [{ client: inngest, functions: [testFunction] }],
        signingKey: "test-signing-key",
        handleShutdownSignals: [],
      });

      expect(connection.state).toBe(ConnectionState.CONNECTING);
    });

    test("should accept multiple apps", () => {
      const secondInngest = new Inngest({ id: "test-app-2", isDev: false });
      const secondFunction = secondInngest.createFunction(
        { id: "test-function-2" },
        { event: "test/event2" },
        async () => ({ message: "Second function" })
      );

      const connection = new ComposedWebSocketWorkerConnection({
        apps: [
          { client: inngest, functions: [testFunction] },
          { client: secondInngest, functions: [secondFunction] }
        ],
        signingKey: "test-signing-key",
      });

      expect(connection.state).toBe(ConnectionState.CONNECTING);
    });
  });

  describe("State Management", () => {
    test("should start in CONNECTING state", () => {
      const connection = new ComposedWebSocketWorkerConnection({
        apps: [{ client: inngest, functions: [testFunction] }],
        signingKey: "test-signing-key",
      });

      expect(connection.state).toBe(ConnectionState.CONNECTING);
    });

    test("should transition to CLOSED after close()", async () => {
      const connection = new ComposedWebSocketWorkerConnection({
        apps: [{ client: inngest, functions: [testFunction] }],
        signingKey: "test-signing-key",
      });

      await connection.close();
      expect(connection.state).toBe(ConnectionState.CLOSED);
    });
  });

  describe("Error Handling", () => {
    test("should handle invalid app configurations", () => {
      expect(() => {
        new ComposedWebSocketWorkerConnection({
          apps: [{ client: null as any, functions: [] }],
          signingKey: "test-signing-key",
        });
      }).toThrow();
    });
  });

  describe("Event Emission", () => {
    test("should emit state change events", async () => {
      const stateChangeListener = jest.fn();
      
      const connection = new ComposedWebSocketWorkerConnection({
        apps: [{ client: inngest, functions: [testFunction] }],
        signingKey: "test-signing-key",
      });

      connection.addEventListener('stateChange', stateChangeListener);

      // Set a connectionId for testing
      (connection as any).connectionId = "test-connection-id";

      await connection.close();

      // Should have emitted at least one state change event
      expect(stateChangeListener).toHaveBeenCalled();
      expect(stateChangeListener).toHaveBeenCalledWith(
        expect.objectContaining({
          from: expect.any(String),
          to: expect.any(String),
          event: expect.any(String),
          timestamp: expect.any(Number),
          connectionId: expect.any(String),
        })
      );
    });

    test("should work with event hooks from configuration", async () => {
      const stateChangeHook = jest.fn();
      
      const connection = new ComposedWebSocketWorkerConnection({
        apps: [{ client: inngest, functions: [testFunction] }],
        signingKey: "test-signing-key",
        eventHooks: {
          stateChange: stateChangeHook,
        },
      });

      await connection.close();

      // Hook should have been called
      expect(stateChangeHook).toHaveBeenCalled();
    });
  });
});