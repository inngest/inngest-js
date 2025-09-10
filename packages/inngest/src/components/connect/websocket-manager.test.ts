/**
 * Unit tests for WebSocketManager
 */

import { jest } from "@jest/globals";
import { WebSocketManager, WebSocketState } from "./websocket-manager.js";
import { ConnectMessage, GatewayMessageType } from "../../proto/src/components/connect/protobuf/connect.js";

// Mock WebSocket
class MockWebSocket {
  public readyState: number = WebSocketState.CONNECTING;
  public binaryType?: BinaryType;
  public onopen: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public onclose: ((event: CloseEvent) => void) | null = null;
  
  public send = jest.fn();
  public close = jest.fn();

  constructor(public url: string, public protocol?: string | string[]) {}

  public simulateOpen(): void {
    this.readyState = WebSocketState.OPEN;
    if (this.onopen) {
      this.onopen(new Event("open"));
    }
  }

  public simulateMessage(data: any): void {
    if (this.onmessage) {
      this.onmessage(new MessageEvent("message", { data }));
    }
  }

  public simulateError(error?: any): void {
    if (this.onerror) {
      this.onerror(new Event("error"));
    }
  }

  public simulateClose(code = 1000, reason = ""): void {
    this.readyState = WebSocketState.CLOSED;
    if (this.onclose) {
      this.onclose(new CloseEvent("close", { code, reason }));
    }
  }
}

// Replace global WebSocket with mock
const mockWebSocketConstructor = jest.fn<(url: string, protocol?: string | string[]) => MockWebSocket>();
let mockWebSocketInstance: MockWebSocket;

beforeEach(() => {
  mockWebSocketInstance = new MockWebSocket("ws://test");
  mockWebSocketConstructor.mockImplementation((url: string, protocol?: string | string[]) => {
    mockWebSocketInstance = new MockWebSocket(url, protocol);
    return mockWebSocketInstance as any;
  });
  global.WebSocket = mockWebSocketConstructor as any;
});

afterEach(() => {
  jest.clearAllMocks();
});

describe("WebSocketManager", () => {
  describe("Connection Management", () => {
    test("should connect successfully", async () => {
      const manager = new WebSocketManager({
        url: "ws://test.example.com",
        protocol: "test-protocol",
        binaryType: "arraybuffer",
      });

      const connectPromise = manager.connect();

      // Verify WebSocket was created with correct parameters
      expect(mockWebSocketConstructor).toHaveBeenCalledWith(
        "ws://test.example.com",
        "test-protocol"
      );
      expect(mockWebSocketInstance.binaryType).toBe("arraybuffer");

      // Simulate successful connection
      mockWebSocketInstance.simulateOpen();

      await expect(connectPromise).resolves.toBeUndefined();
      expect(manager.isOpen).toBe(true);
      expect(manager.isClosed).toBe(false);
    });

    test("should handle connection timeout", async () => {
      jest.useFakeTimers();

      const manager = new WebSocketManager({
        url: "ws://test.example.com",
        connectTimeout: 5000,
      });

      const connectPromise = manager.connect();

      // Fast-forward past timeout
      jest.advanceTimersByTime(5001);

      await expect(connectPromise).rejects.toThrow("WebSocket connection timeout after 5000ms");
      expect(manager.isClosed).toBe(true);

      jest.useRealTimers();
    });

    test("should handle connection error", async () => {
      const manager = new WebSocketManager({
        url: "ws://test.example.com",
        connectTimeout: 1000, // Add timeout to ensure promise resolves
      });

      const connectPromise = manager.connect();

      // Simulate connection error
      mockWebSocketInstance.simulateError();

      await expect(connectPromise).rejects.toThrow("WebSocket connection failed");
      expect(manager.isClosed).toBe(false); // Not explicitly closed
    });

    test("should handle connection close during connect", async () => {
      const manager = new WebSocketManager({
        url: "ws://test.example.com",
        connectTimeout: 1000, // Add timeout to ensure promise resolves
      });

      const connectPromise = manager.connect();

      // Simulate close during connection
      mockWebSocketInstance.simulateClose(1006, "Connection lost");

      await expect(connectPromise).rejects.toThrow("WebSocket closed during connection: Connection lost");
      expect(manager.isClosed).toBe(true);
    });

    test("should reject connecting twice", async () => {
      const manager = new WebSocketManager({
        url: "ws://test.example.com",
      });

      const connectPromise1 = manager.connect();
      mockWebSocketInstance.simulateOpen();
      await connectPromise1;

      await expect(manager.connect()).rejects.toThrow("WebSocket already connected or connecting");
    });
  });

  describe("Event Handling", () => {
    test("should call event handlers", async () => {
      const onOpen = jest.fn();
      const onMessage = jest.fn();
      const onError = jest.fn();
      const onClose = jest.fn();

      const manager = new WebSocketManager({
        url: "ws://test.example.com",
      });

      manager.setEventHandlers({
        onOpen,
        onMessage,
        onError,
        onClose,
      });

      const connectPromise = manager.connect();
      mockWebSocketInstance.simulateOpen();
      await connectPromise;

      expect(onOpen).toHaveBeenCalled();

      // Test message event
      const testData = new Uint8Array([1, 2, 3]);
      mockWebSocketInstance.simulateMessage(testData);
      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({ data: testData })
      );

      // Test error event
      mockWebSocketInstance.simulateError();
      expect(onError).toHaveBeenCalled();

      // Test close event
      mockWebSocketInstance.simulateClose(1000, "Normal closure");
      expect(onClose).toHaveBeenCalledWith(
        expect.objectContaining({ code: 1000, reason: "Normal closure" })
      );
    });

    test("should allow updating event handlers", async () => {
      const firstHandler = jest.fn();
      const secondHandler = jest.fn();

      const manager = new WebSocketManager({
        url: "ws://test.example.com",
      });

      manager.setEventHandlers({ onMessage: firstHandler });

      const connectPromise = manager.connect();
      mockWebSocketInstance.simulateOpen();
      await connectPromise;

      mockWebSocketInstance.simulateMessage("test1");
      expect(firstHandler).toHaveBeenCalledTimes(1);

      // Update handler
      manager.setEventHandlers({ onMessage: secondHandler });

      mockWebSocketInstance.simulateMessage("test2");
      expect(firstHandler).toHaveBeenCalledTimes(1); // Not called again
      expect(secondHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe("Message Sending", () => {
    test("should send data when connected", async () => {
      const manager = new WebSocketManager({
        url: "ws://test.example.com",
      });

      const connectPromise = manager.connect();
      mockWebSocketInstance.simulateOpen();
      await connectPromise;

      const data = new Uint8Array([1, 2, 3]);
      manager.send(data);

      expect(mockWebSocketInstance.send).toHaveBeenCalledWith(data);
    });

    test("should throw when sending without connection", () => {
      const manager = new WebSocketManager({
        url: "ws://test.example.com",
      });

      expect(() => manager.send("test")).toThrow("WebSocket is not open");
    });

    test("should send ConnectMessage", async () => {
      const manager = new WebSocketManager({
        url: "ws://test.example.com",
      });

      const connectPromise = manager.connect();
      mockWebSocketInstance.simulateOpen();
      await connectPromise;

      const message = ConnectMessage.create({
        kind: GatewayMessageType.WORKER_HEARTBEAT,
        payload: new Uint8Array(),
      });

      manager.sendMessage(message);

      expect(mockWebSocketInstance.send).toHaveBeenCalled();
      const sendCalls = mockWebSocketInstance.send.mock.calls;
      expect(sendCalls.length).toBeGreaterThan(0);
      expect(sendCalls[0]![0]).toBeInstanceOf(Uint8Array);
    });
  });

  describe("Connection Closing", () => {
    test("should close connection gracefully", async () => {
      const manager = new WebSocketManager({
        url: "ws://test.example.com",
      });

      const connectPromise = manager.connect();
      mockWebSocketInstance.simulateOpen();
      await connectPromise;

      manager.close(1000, "Normal closure");

      expect(mockWebSocketInstance.close).toHaveBeenCalledWith(1000, "Normal closure");
      expect(manager.isClosed).toBe(true);
    });

    test("should force close connection", async () => {
      const manager = new WebSocketManager({
        url: "ws://test.example.com",
      });

      const connectPromise = manager.connect();
      mockWebSocketInstance.simulateOpen();
      await connectPromise;

      manager.forceClose();

      expect(manager.isClosed).toBe(true);
      // Force close doesn't call ws.close()
      expect(mockWebSocketInstance.close).not.toHaveBeenCalled();
    });

    test("should handle graceful close with pause message", async () => {
      const manager = new WebSocketManager({
        url: "ws://test.example.com",
      });

      const connectPromise = manager.connect();
      mockWebSocketInstance.simulateOpen();
      await connectPromise;

      manager.gracefulClose();

      // Should send pause message first
      expect(mockWebSocketInstance.send).toHaveBeenCalled();
      
      // Then close with proper code and reason
      expect(mockWebSocketInstance.close).toHaveBeenCalledWith(
        1000,
        expect.stringContaining("WORKER_SHUTDOWN")
      );
    });

    test("should handle multiple close calls", async () => {
      const manager = new WebSocketManager({
        url: "ws://test.example.com",
      });

      const connectPromise = manager.connect();
      mockWebSocketInstance.simulateOpen();
      await connectPromise;

      manager.close();
      manager.close(); // Second call should be ignored

      expect(mockWebSocketInstance.close).toHaveBeenCalledTimes(1);
    });
  });

  describe("Heartbeat Mechanism", () => {
    test("should send heartbeats at interval", async () => {
      jest.useFakeTimers();

      const manager = new WebSocketManager({
        url: "ws://test.example.com",
      });

      const connectPromise = manager.connect();
      mockWebSocketInstance.simulateOpen();
      await connectPromise;

      const onMissedHeartbeats = jest.fn();
      manager.startHeartbeat(10000, onMissedHeartbeats);

      // Fast-forward one interval
      jest.advanceTimersByTime(10000);

      expect(mockWebSocketInstance.send).toHaveBeenCalledTimes(1);
      expect(onMissedHeartbeats).not.toHaveBeenCalled();

      // Fast-forward another interval without reset
      jest.advanceTimersByTime(10000);

      expect(mockWebSocketInstance.send).toHaveBeenCalledTimes(2);
      expect(onMissedHeartbeats).not.toHaveBeenCalled();

      // Fast-forward third time - should trigger missed heartbeats
      jest.advanceTimersByTime(10000);

      expect(onMissedHeartbeats).toHaveBeenCalled();

      jest.useRealTimers();
    });

    test("should reset heartbeat counter", async () => {
      jest.useFakeTimers();

      const manager = new WebSocketManager({
        url: "ws://test.example.com",
      });

      const connectPromise = manager.connect();
      mockWebSocketInstance.simulateOpen();
      await connectPromise;

      const onMissedHeartbeats = jest.fn();
      manager.startHeartbeat(10000, onMissedHeartbeats);

      // Send two heartbeats
      jest.advanceTimersByTime(10000);
      jest.advanceTimersByTime(10000);

      // Reset counter
      manager.resetHeartbeat();

      // Send two more heartbeats - should not trigger missed
      jest.advanceTimersByTime(10000);
      jest.advanceTimersByTime(10000);

      expect(onMissedHeartbeats).not.toHaveBeenCalled();

      jest.useRealTimers();
    });

    test("should stop heartbeat", async () => {
      jest.useFakeTimers();

      const manager = new WebSocketManager({
        url: "ws://test.example.com",
      });

      const connectPromise = manager.connect();
      mockWebSocketInstance.simulateOpen();
      await connectPromise;

      const onMissedHeartbeats = jest.fn();
      manager.startHeartbeat(10000, onMissedHeartbeats);

      // Send one heartbeat
      jest.advanceTimersByTime(10000);
      expect(mockWebSocketInstance.send).toHaveBeenCalledTimes(1);

      // Stop heartbeat
      manager.stopHeartbeat();

      // Fast-forward - no more heartbeats should be sent
      jest.advanceTimersByTime(20000);
      expect(mockWebSocketInstance.send).toHaveBeenCalledTimes(1);

      jest.useRealTimers();
    });
  });

  describe("State Management", () => {
    test("should track ready state correctly", async () => {
      const manager = new WebSocketManager({
        url: "ws://test.example.com",
      });

      expect(manager.readyState).toBe(WebSocketState.CLOSED);
      expect(manager.isOpen).toBe(false);
      expect(manager.isClosed).toBe(true);

      const connectPromise = manager.connect();
      expect(manager.readyState).toBe(WebSocketState.CONNECTING);
      expect(manager.isOpen).toBe(false);
      expect(manager.isClosed).toBe(false);

      mockWebSocketInstance.simulateOpen();
      await connectPromise;

      expect(manager.readyState).toBe(WebSocketState.OPEN);
      expect(manager.isOpen).toBe(true);
      expect(manager.isClosed).toBe(false);

      manager.close();

      expect(manager.isClosed).toBe(true);
    });
  });

  describe("Error Handling", () => {
    test("should handle send errors gracefully during heartbeat", async () => {
      jest.useFakeTimers();

      const manager = new WebSocketManager({
        url: "ws://test.example.com",
      });

      const connectPromise = manager.connect();
      mockWebSocketInstance.simulateOpen();
      await connectPromise;

      // Make send throw an error
      mockWebSocketInstance.send.mockImplementation(() => {
        throw new Error("Send failed");
      });

      const onMissedHeartbeats = jest.fn();
      manager.startHeartbeat(10000, onMissedHeartbeats);

      // Should not throw when heartbeat fails
      expect(() => jest.advanceTimersByTime(10000)).not.toThrow();

      jest.useRealTimers();
    });

    test("should clean up on timeout", async () => {
      jest.useFakeTimers();

      const manager = new WebSocketManager({
        url: "ws://test.example.com",
        connectTimeout: 5000,
      });

      const connectPromise = manager.connect();

      // Start heartbeat before connection completes
      const onMissedHeartbeats = jest.fn();
      
      // Fast-forward to trigger timeout
      jest.advanceTimersByTime(5001);

      await expect(connectPromise).rejects.toThrow();

      // Verify cleanup happened
      expect(mockWebSocketInstance.onopen).toBeNull();
      expect(mockWebSocketInstance.onclose).toBeNull();
      expect(mockWebSocketInstance.onerror).toBeNull();
      expect(mockWebSocketInstance.onmessage).toBeNull();

      jest.useRealTimers();
    });
  });
});