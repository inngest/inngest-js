import debug, { type Debugger } from "debug";
import { ConnectionState } from "./types.js";

/**
 * Events that can trigger state transitions in the connection state machine
 */
export type ConnectionEvent = 
  | 'CONNECT_REQUESTED'     // Client initiates connection attempt or retry
  | 'WEBSOCKET_OPEN'        // WebSocket connection successfully opened
  | 'AUTH_SUCCESS'          // Authentication with Inngest API succeeded
  | 'AUTH_FAILED'           // Authentication with Inngest API failed
  | 'GATEWAY_READY'         // Gateway sent connection ready message, can now handle requests
  | 'DRAINING_REQUESTED'    // Gateway sends draining message (preparing to close connection gracefully)
  | 'NEW_CONNECTION_READY'  // New connection established during draining or after reconnect
  | 'ERROR_OCCURRED'        // Network error, WebSocket error, or other recoverable error
  | 'SHUTDOWN_REQUESTED'    // Client requests graceful shutdown (user calls close() or shutdown signal)
  | 'CONNECTION_LOST'       // WebSocket connection was lost unexpectedly
  | 'RECONNECT_STARTED';    // Beginning reconnection process after error

/**
 * State transition definition
 */
interface StateTransition {
  from: ConnectionState;
  event: ConnectionEvent;
  to: ConnectionState;
  condition?: () => boolean;
}

/**
 * Event listener for state changes
 */
export interface StateChangeListener {
  (event: {
    from: ConnectionState;
    to: ConnectionState;
    event: ConnectionEvent;
    timestamp: number;
  }): void;
}

/**
 * Connection state machine that manages state transitions and provides
 * the external state view (especially important during draining)
 */
export class ConnectionStateMachine {
  private debug: Debugger;
  private _internalState: ConnectionState;
  private listeners: Set<StateChangeListener> = new Set();
  private stateHistory: Array<{
    state: ConnectionState;
    event: ConnectionEvent;
    timestamp: number;
  }> = [];

  /**
   * Valid state transitions with detailed explanations of when each occurs
   */
  private readonly transitions: StateTransition[] = [
    // === INITIAL CONNECTION FLOW ===
    // When initially connecting or after a reconnect attempt
    
    { from: ConnectionState.CONNECTING, event: 'WEBSOCKET_OPEN', to: ConnectionState.CONNECTING },
    // ↳ WebSocket connected but still need to authenticate and get gateway ready signal
    
    { from: ConnectionState.CONNECTING, event: 'AUTH_SUCCESS', to: ConnectionState.CONNECTING },
    // ↳ Authenticated successfully but still waiting for gateway to confirm connection is ready
    
    { from: ConnectionState.CONNECTING, event: 'GATEWAY_READY', to: ConnectionState.ACTIVE },
    // ↳ Gateway confirmed connection ready - can now receive and execute function requests
    
    // === ERROR HANDLING DURING CONNECTION SETUP ===
    
    { from: ConnectionState.CONNECTING, event: 'ERROR_OCCURRED', to: ConnectionState.RECONNECTING },
    // ↳ Network error, WebSocket error, or other issue during connection setup
    
    { from: ConnectionState.CONNECTING, event: 'AUTH_FAILED', to: ConnectionState.RECONNECTING },
    // ↳ Authentication failed (invalid signing key, etc.) - will retry with backoff
    
    { from: ConnectionState.CONNECTING, event: 'CONNECTION_LOST', to: ConnectionState.RECONNECTING },
    // ↳ WebSocket connection dropped during setup phase
    
    // === NORMAL OPERATION (ACTIVE STATE) ===
    
    { from: ConnectionState.ACTIVE, event: 'DRAINING_REQUESTED', to: ConnectionState.DRAINING_RECONNECTING },
    // ↳ Gateway is preparing to close connection gracefully - establish new connection while keeping current one
    
    { from: ConnectionState.ACTIVE, event: 'ERROR_OCCURRED', to: ConnectionState.RECONNECTING },
    // ↳ Unexpected error occurred while active - will reconnect and stop processing requests temporarily
    
    { from: ConnectionState.ACTIVE, event: 'CONNECTION_LOST', to: ConnectionState.RECONNECTING },
    // ↳ WebSocket connection dropped while active - will reconnect
    
    { from: ConnectionState.ACTIVE, event: 'SHUTDOWN_REQUESTED', to: ConnectionState.CLOSING },
    // ↳ User called close() or shutdown signal received - graceful shutdown, no reconnect
    
    // === RECONNECTION FLOW ===
    
    { from: ConnectionState.RECONNECTING, event: 'CONNECT_REQUESTED', to: ConnectionState.CONNECTING },
    // ↳ Starting new connection attempt after backoff delay
    
    { from: ConnectionState.RECONNECTING, event: 'NEW_CONNECTION_READY', to: ConnectionState.ACTIVE },
    // ↳ Successfully reconnected and ready to handle requests (skips intermediate connecting state)
    
    { from: ConnectionState.RECONNECTING, event: 'SHUTDOWN_REQUESTED', to: ConnectionState.CLOSING },
    // ↳ User requested shutdown while trying to reconnect - stop reconnection attempts
    
    { from: ConnectionState.RECONNECTING, event: 'ERROR_OCCURRED', to: ConnectionState.RECONNECTING },
    // ↳ Reconnection attempt failed - stay in reconnecting state and try again with backoff
    
    // === DRAINING RECONNECTION FLOW ===
    // Special state when gateway is draining - external state shows ACTIVE but internally reconnecting
    
    { from: ConnectionState.DRAINING_RECONNECTING, event: 'NEW_CONNECTION_READY', to: ConnectionState.ACTIVE },
    // ↳ New connection established during draining - can close old connection and resume normal operation
    
    { from: ConnectionState.DRAINING_RECONNECTING, event: 'SHUTDOWN_REQUESTED', to: ConnectionState.CLOSING },
    // ↳ User requested shutdown during draining - cancel draining and shut down gracefully
    
    { from: ConnectionState.DRAINING_RECONNECTING, event: 'ERROR_OCCURRED', to: ConnectionState.DRAINING_RECONNECTING },
    // ↳ Error during draining reconnection - keep trying to establish new connection
    
    // === GRACEFUL SHUTDOWN FLOW ===
    
    { from: ConnectionState.CLOSING, event: 'CONNECTION_LOST', to: ConnectionState.CLOSING },
    // ↳ Connection lost while shutting down - not an error, continue shutdown process
    
    { from: ConnectionState.CLOSING, event: 'ERROR_OCCURRED', to: ConnectionState.CLOSING },
    // ↳ Error occurred while shutting down - ignore and continue shutdown process
    
    // === TERMINAL STATE ===
    // CLOSED is terminal - no transitions out (connection object should be discarded)
  ];

  constructor(initialState: ConnectionState = ConnectionState.CONNECTING) {
    this.debug = debug("inngest:connect:state-machine");
    this._internalState = initialState;
    
    this.debug(`Initialized state machine in state: ${initialState}`);
    this.recordStateChange(initialState, 'CONNECT_REQUESTED');
  }

  /**
   * Get the current external state
   * DRAINING_RECONNECTING is reported as ACTIVE externally
   */
  get state(): ConnectionState {
    if (this._internalState === ConnectionState.DRAINING_RECONNECTING) {
      return ConnectionState.ACTIVE;
    }
    return this._internalState;
  }

  /**
   * Get the internal state (useful for debugging and advanced scenarios)
   */
  get internalState(): ConnectionState {
    return this._internalState;
  }

  /**
   * Check if the connection is in a terminal state
   */
  get isTerminal(): boolean {
    return this._internalState === ConnectionState.CLOSED;
  }

  /**
   * Check if the connection is actively handling requests
   * This includes DRAINING_RECONNECTING since it reports as ACTIVE externally
   */
  get isActive(): boolean {
    return this._internalState === ConnectionState.ACTIVE ||
           this._internalState === ConnectionState.DRAINING_RECONNECTING;
  }

  /**
   * Check if the connection is in a connecting state
   */
  get isConnecting(): boolean {
    return this._internalState === ConnectionState.CONNECTING;
  }

  /**
   * Check if the connection is reconnecting
   */
  get isReconnecting(): boolean {
    return this._internalState === ConnectionState.RECONNECTING;
  }

  /**
   * Check if the connection is closing
   */
  get isClosing(): boolean {
    return this._internalState === ConnectionState.CLOSING ||
           this._internalState === ConnectionState.CLOSED;
  }

  /**
   * Special method to check if we're in draining mode
   * This is when we're in the DRAINING_RECONNECTING state
   */
  get isDraining(): boolean {
    return this._internalState === ConnectionState.DRAINING_RECONNECTING;
  }

  /**
   * Trigger a state transition
   */
  public transition(event: ConnectionEvent): boolean {
    const from = this._internalState;
    
    // Find valid transition
    const validTransition = this.transitions.find(t => 
      t.from === from && 
      t.event === event &&
      (!t.condition || t.condition())
    );

    if (!validTransition) {
      this.debug(`Invalid transition: ${from} + ${event} (no valid transition found)`);
      return false;
    }

    const to = validTransition.to;
    
    // Update internal state
    this._internalState = to;

    this.debug(`State transition: ${from} -> ${to} (event: ${event})`);
    this.notifyListeners(from, to, event);
    this.recordStateChange(to, event);

    return true;
  }

  /**
   * Force set the state (use with caution - mainly for initialization)
   */
  public setState(state: ConnectionState, event: ConnectionEvent = 'ERROR_OCCURRED'): void {
    const from = this._internalState;
    this._internalState = state;
    
    this.debug(`Force state change: ${from} -> ${state}`);
    this.notifyListeners(from, state, event);
    this.recordStateChange(state, event);
  }

  /**
   * Add a listener for state changes
   */
  public onStateChange(listener: StateChangeListener): void {
    this.listeners.add(listener);
  }

  /**
   * Remove a listener for state changes
   */
  public removeStateChangeListener(listener: StateChangeListener): void {
    this.listeners.delete(listener);
  }

  /**
   * Get the state history for debugging
   */
  public getStateHistory(): ReadonlyArray<{
    state: ConnectionState;
    event: ConnectionEvent;
    timestamp: number;
  }> {
    return [...this.stateHistory];
  }

  /**
   * Clear the state history (useful for testing)
   */
  public clearHistory(): void {
    this.stateHistory = [];
  }

  private notifyListeners(from: ConnectionState, to: ConnectionState, event: ConnectionEvent): void {
    const timestamp = Date.now();
    for (const listener of this.listeners) {
      try {
        listener({ from, to, event, timestamp });
      } catch (err) {
        this.debug(`Error in state change listener:`, err);
      }
    }
  }

  private recordStateChange(state: ConnectionState, event: ConnectionEvent): void {
    this.stateHistory.push({
      state,
      event,
      timestamp: Date.now(),
    });

    // Keep only last 50 state changes to prevent memory leaks
    if (this.stateHistory.length > 50) {
      this.stateHistory.shift();
    }
  }
}