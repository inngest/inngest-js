/**
 * Unit tests for ConnectionStateMachine
 */

import { ConnectionStateMachine, type StateChangeListener } from "./state-machine.js";
import { ConnectionState } from "./types.js";

describe("ConnectionStateMachine", () => {
  let stateMachine: ConnectionStateMachine;

  beforeEach(() => {
    stateMachine = new ConnectionStateMachine();
  });

  describe("Initialization", () => {
    test("should initialize with CONNECTING state by default", () => {
      expect(stateMachine.state).toBe(ConnectionState.CONNECTING);
      expect(stateMachine.internalState).toBe(ConnectionState.CONNECTING);
      expect(stateMachine.isConnecting).toBe(true);
      expect(stateMachine.isActive).toBe(false);
      expect(stateMachine.isReconnecting).toBe(false);
      expect(stateMachine.isClosing).toBe(false);
      expect(stateMachine.isTerminal).toBe(false);
      expect(stateMachine.isDraining).toBe(false);
    });

    test("should initialize with custom state", () => {
      const customStateMachine = new ConnectionStateMachine(ConnectionState.ACTIVE);
      expect(customStateMachine.state).toBe(ConnectionState.ACTIVE);
      expect(customStateMachine.internalState).toBe(ConnectionState.ACTIVE);
      expect(customStateMachine.isActive).toBe(true);
    });
  });

  describe("Basic State Transitions", () => {
    test("should transition from CONNECTING to ACTIVE on GATEWAY_READY", () => {
      expect(stateMachine.state).toBe(ConnectionState.CONNECTING);
      
      const success = stateMachine.transition('GATEWAY_READY');
      expect(success).toBe(true);
      expect(stateMachine.state).toBe(ConnectionState.ACTIVE);
      expect(stateMachine.internalState).toBe(ConnectionState.ACTIVE);
      expect(stateMachine.isActive).toBe(true);
    });

    test("should transition from CONNECTING to RECONNECTING on ERROR_OCCURRED", () => {
      expect(stateMachine.state).toBe(ConnectionState.CONNECTING);
      
      const success = stateMachine.transition('ERROR_OCCURRED');
      expect(success).toBe(true);
      expect(stateMachine.state).toBe(ConnectionState.RECONNECTING);
      expect(stateMachine.internalState).toBe(ConnectionState.RECONNECTING);
      expect(stateMachine.isReconnecting).toBe(true);
    });

    test("should transition from ACTIVE to CLOSING on SHUTDOWN_REQUESTED", () => {
      // First get to ACTIVE state
      stateMachine.transition('GATEWAY_READY');
      expect(stateMachine.state).toBe(ConnectionState.ACTIVE);
      
      const success = stateMachine.transition('SHUTDOWN_REQUESTED');
      expect(success).toBe(true);
      expect(stateMachine.state).toBe(ConnectionState.CLOSING);
      expect(stateMachine.isClosing).toBe(true);
    });

    test("should transition from RECONNECTING to CONNECTING on CONNECT_REQUESTED", () => {
      // First get to RECONNECTING state
      stateMachine.transition('ERROR_OCCURRED');
      expect(stateMachine.state).toBe(ConnectionState.RECONNECTING);
      
      const success = stateMachine.transition('CONNECT_REQUESTED');
      expect(success).toBe(true);
      expect(stateMachine.state).toBe(ConnectionState.CONNECTING);
      expect(stateMachine.isConnecting).toBe(true);
    });
  });

  describe("Invalid Transitions", () => {
    test("should reject invalid transitions", () => {
      expect(stateMachine.state).toBe(ConnectionState.CONNECTING);
      
      // Try invalid transition
      const success = stateMachine.transition('DRAINING_REQUESTED');
      expect(success).toBe(false);
      expect(stateMachine.state).toBe(ConnectionState.CONNECTING); // Should remain unchanged
    });

    test("should reject transitions from terminal state", () => {
      // Force to terminal state
      stateMachine.setState(ConnectionState.CLOSED);
      expect(stateMachine.isTerminal).toBe(true);
      
      // Try any transition - should fail
      const success = stateMachine.transition('CONNECT_REQUESTED');
      expect(success).toBe(false);
      expect(stateMachine.state).toBe(ConnectionState.CLOSED);
    });
  });

  describe("Draining Behavior", () => {
    test("should handle draining correctly - external state remains ACTIVE", () => {
      // Get to ACTIVE state first
      stateMachine.transition('GATEWAY_READY');
      expect(stateMachine.state).toBe(ConnectionState.ACTIVE);
      expect(stateMachine.isActive).toBe(true);
      expect(stateMachine.isDraining).toBe(false);
      
      // Start draining
      const success = stateMachine.transition('DRAINING_REQUESTED');
      expect(success).toBe(true);
      
      // External state should remain ACTIVE (critical requirement!)
      expect(stateMachine.state).toBe(ConnectionState.ACTIVE);
      expect(stateMachine.isActive).toBe(true);
      
      // Internal state should be DRAINING_RECONNECTING
      expect(stateMachine.internalState).toBe(ConnectionState.DRAINING_RECONNECTING);
      expect(stateMachine.isDraining).toBe(true);
    });

    test("should complete draining when new connection is ready", () => {
      // Set up draining state
      stateMachine.transition('GATEWAY_READY');
      stateMachine.transition('DRAINING_REQUESTED');
      expect(stateMachine.isDraining).toBe(true);
      expect(stateMachine.internalState).toBe(ConnectionState.DRAINING_RECONNECTING);
      
      // Complete draining with new connection
      const success = stateMachine.transition('NEW_CONNECTION_READY');
      expect(success).toBe(true);
      
      // Both internal and external states should be ACTIVE now
      expect(stateMachine.state).toBe(ConnectionState.ACTIVE);
      expect(stateMachine.internalState).toBe(ConnectionState.ACTIVE);
      expect(stateMachine.isDraining).toBe(false);
      expect(stateMachine.isActive).toBe(true);
    });

    test("should handle shutdown request during draining", () => {
      // Set up draining state
      stateMachine.transition('GATEWAY_READY');
      stateMachine.transition('DRAINING_REQUESTED');
      expect(stateMachine.isDraining).toBe(true);
      
      // Request shutdown during draining
      const success = stateMachine.transition('SHUTDOWN_REQUESTED');
      expect(success).toBe(true);
      
      expect(stateMachine.state).toBe(ConnectionState.CLOSING);
      expect(stateMachine.isClosing).toBe(true);
      expect(stateMachine.isDraining).toBe(false);
    });
  });

  describe("State Change Listeners", () => {
    test("should notify listeners on state changes", () => {
      const listener = jest.fn<void, Parameters<StateChangeListener>>();
      stateMachine.onStateChange(listener);
      
      stateMachine.transition('GATEWAY_READY');
      
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({
        from: ConnectionState.CONNECTING,
        to: ConnectionState.ACTIVE,
        event: 'GATEWAY_READY',
        timestamp: expect.any(Number),
      });
    });

    test("should handle listener errors gracefully", () => {
      const errorListener = jest.fn<void, Parameters<StateChangeListener>>(() => {
        throw new Error("Listener error");
      });
      
      const goodListener = jest.fn<void, Parameters<StateChangeListener>>();
      
      stateMachine.onStateChange(errorListener);
      stateMachine.onStateChange(goodListener);
      
      // Should not throw, both listeners should be called
      expect(() => stateMachine.transition('GATEWAY_READY')).not.toThrow();
      
      expect(errorListener).toHaveBeenCalled();
      expect(goodListener).toHaveBeenCalled();
    });

    test("should remove listeners", () => {
      const listener = jest.fn<void, Parameters<StateChangeListener>>();
      stateMachine.onStateChange(listener);
      
      stateMachine.transition('GATEWAY_READY');
      expect(listener).toHaveBeenCalledTimes(1);
      
      stateMachine.removeStateChangeListener(listener);
      
      // Force back to connecting and transition again
      stateMachine.setState(ConnectionState.CONNECTING);
      stateMachine.transition('GATEWAY_READY');
      
      // Listener should not be called again
      expect(listener).toHaveBeenCalledTimes(1); // Still only 1 call
    });
  });

  describe("State History", () => {
    test("should track state history", () => {
      stateMachine.transition('GATEWAY_READY');
      stateMachine.transition('ERROR_OCCURRED');
      
      const history = stateMachine.getStateHistory();
      
      expect(history).toHaveLength(3); // Initial + 2 transitions
      expect(history[0]).toMatchObject({
        state: ConnectionState.CONNECTING,
        event: 'CONNECT_REQUESTED',
        timestamp: expect.any(Number),
      });
      expect(history[1]).toMatchObject({
        state: ConnectionState.ACTIVE,
        event: 'GATEWAY_READY',
        timestamp: expect.any(Number),
      });
      expect(history[2]).toMatchObject({
        state: ConnectionState.RECONNECTING,
        event: 'ERROR_OCCURRED',
        timestamp: expect.any(Number),
      });
    });

    test("should clear history", () => {
      stateMachine.transition('GATEWAY_READY');
      expect(stateMachine.getStateHistory()).toHaveLength(2);
      
      stateMachine.clearHistory();
      expect(stateMachine.getStateHistory()).toHaveLength(0);
    });

    test("should limit history size to prevent memory leaks", () => {
      // Create 55 state changes (more than the 50 limit)
      for (let i = 0; i < 55; i++) {
        stateMachine.setState(ConnectionState.CONNECTING, 'ERROR_OCCURRED');
      }
      
      const history = stateMachine.getStateHistory();
      expect(history).toHaveLength(50); // Should be limited to 50
    });
  });

  describe("Helper Methods", () => {
    test("isTerminal should work correctly", () => {
      expect(stateMachine.isTerminal).toBe(false);
      
      stateMachine.setState(ConnectionState.CLOSED);
      expect(stateMachine.isTerminal).toBe(true);
    });

    test("isActive should work correctly", () => {
      expect(stateMachine.isActive).toBe(false);
      
      stateMachine.transition('GATEWAY_READY');
      expect(stateMachine.isActive).toBe(true);
      
      // When transitioning from ACTIVE to RECONNECTING due to error
      stateMachine.transition('ERROR_OCCURRED');
      expect(stateMachine.isActive).toBe(false);
      expect(stateMachine.state).toBe(ConnectionState.RECONNECTING);
    });

    test("isConnecting should work correctly", () => {
      expect(stateMachine.isConnecting).toBe(true);
      
      stateMachine.transition('GATEWAY_READY');
      expect(stateMachine.isConnecting).toBe(false);
    });

    test("isReconnecting should work correctly", () => {
      expect(stateMachine.isReconnecting).toBe(false);
      
      stateMachine.transition('ERROR_OCCURRED');
      expect(stateMachine.isReconnecting).toBe(true);
    });

    test("isClosing should work correctly", () => {
      stateMachine.transition('GATEWAY_READY');
      expect(stateMachine.isClosing).toBe(false);
      
      stateMachine.transition('SHUTDOWN_REQUESTED');
      expect(stateMachine.isClosing).toBe(true);
      
      stateMachine.setState(ConnectionState.CLOSED);
      expect(stateMachine.isClosing).toBe(true);
    });
  });

  describe("Complex Scenarios", () => {
    test("should handle complete connection lifecycle", () => {
      const listener = jest.fn<void, Parameters<StateChangeListener>>();
      stateMachine.onStateChange(listener);
      
      // Initial connection
      expect(stateMachine.state).toBe(ConnectionState.CONNECTING);
      
      // WebSocket opens
      stateMachine.transition('WEBSOCKET_OPEN');
      expect(stateMachine.state).toBe(ConnectionState.CONNECTING); // Still connecting
      
      // Auth succeeds
      stateMachine.transition('AUTH_SUCCESS');
      expect(stateMachine.state).toBe(ConnectionState.CONNECTING); // Still connecting
      
      // Gateway ready
      stateMachine.transition('GATEWAY_READY');
      expect(stateMachine.state).toBe(ConnectionState.ACTIVE);
      
      // Gateway starts draining
      stateMachine.transition('DRAINING_REQUESTED');
      expect(stateMachine.state).toBe(ConnectionState.ACTIVE); // External state stays active
      expect(stateMachine.isDraining).toBe(true);
      
      // New connection ready
      stateMachine.transition('NEW_CONNECTION_READY');
      expect(stateMachine.state).toBe(ConnectionState.ACTIVE);
      expect(stateMachine.isDraining).toBe(false);
      
      // Normal shutdown
      stateMachine.transition('SHUTDOWN_REQUESTED');
      expect(stateMachine.state).toBe(ConnectionState.CLOSING);
      
      // Verify all transitions were recorded
      expect(listener).toHaveBeenCalledTimes(6); // All successful transitions
    });

    test("should handle error during connection", () => {
      expect(stateMachine.state).toBe(ConnectionState.CONNECTING);
      
      // Connection fails
      stateMachine.transition('ERROR_OCCURRED');
      expect(stateMachine.state).toBe(ConnectionState.RECONNECTING);
      
      // Retry connection
      stateMachine.transition('CONNECT_REQUESTED');
      expect(stateMachine.state).toBe(ConnectionState.CONNECTING);
      
      // This time succeeds
      stateMachine.transition('GATEWAY_READY');
      expect(stateMachine.state).toBe(ConnectionState.ACTIVE);
    });

    test("should handle reconnection from active state", () => {
      // Get to active state
      stateMachine.transition('GATEWAY_READY');
      expect(stateMachine.state).toBe(ConnectionState.ACTIVE);
      
      // Connection lost - normal error handling (not draining)
      stateMachine.transition('CONNECTION_LOST');
      expect(stateMachine.state).toBe(ConnectionState.RECONNECTING);
      
      // Direct new connection ready (skip intermediate states)
      stateMachine.transition('NEW_CONNECTION_READY');
      expect(stateMachine.state).toBe(ConnectionState.ACTIVE);
    });
  });
});