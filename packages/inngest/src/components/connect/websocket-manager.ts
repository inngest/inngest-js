import debug, { type Debugger } from "debug";
import {
  ConnectMessage,
  GatewayMessageType,
  WorkerDisconnectReason,
  workerDisconnectReasonToJSON,
} from "../../proto/src/components/connect/protobuf/connect.js";

/**
 * WebSocket connection states
 */
export enum WebSocketState {
  CONNECTING = 0,
  OPEN = 1,
  CLOSING = 2,
  CLOSED = 3,
}

/**
 * WebSocket events
 */
export interface WebSocketEvents {
  onOpen?: (event: Event) => void;
  onMessage?: (event: MessageEvent) => void;
  onError?: (event: Event) => void;
  onClose?: (event: CloseEvent) => void;
}

/**
 * Configuration for WebSocket connection
 */
export interface WebSocketConfig {
  url: string;
  protocol?: string | string[];
  binaryType?: BinaryType;
  connectTimeout?: number;
}

/**
 * Manages low-level WebSocket connection lifecycle, message sending, and event handling
 */
export class WebSocketManager {
  private debug: Debugger;
  private ws: WebSocket | null = null;
  private config: WebSocketConfig;
  private events: WebSocketEvents = {};
  private connectTimeoutId?: NodeJS.Timeout;
  private heartbeatInterval?: NodeJS.Timeout;
  private pendingHeartbeats = 0;
  private closed = false;

  constructor(config: WebSocketConfig) {
    this.debug = debug("inngest:connect:websocket-manager");
    this.config = config;
  }

  /**
   * Connect to WebSocket server
   */
  public async connect(): Promise<void> {
    if (this.ws) {
      throw new Error("WebSocket already connected or connecting");
    }

    this.closed = false;
    this.pendingHeartbeats = 0;

    return new Promise((resolve, reject) => {
      try {
        this.debug("Connecting to WebSocket", { url: this.config.url });
        
        this.ws = new WebSocket(this.config.url, this.config.protocol);
        
        if (this.config.binaryType) {
          this.ws.binaryType = this.config.binaryType;
        }

        // Set up connect timeout
        if (this.config.connectTimeout) {
          this.connectTimeoutId = setTimeout(() => {
            this.debug("Connection timeout");
            const error = new Error(`WebSocket connection timeout after ${this.config.connectTimeout}ms`);
            this.cleanup();
            reject(error);
          }, this.config.connectTimeout);
        }

        // Handle connection events
        this.ws.onopen = (event) => {
          this.debug("WebSocket connected");
          if (this.connectTimeoutId) {
            clearTimeout(this.connectTimeoutId);
            this.connectTimeoutId = undefined;
          }
          if (this.events.onOpen) {
            this.events.onOpen(event);
          }
          resolve();
        };

        this.ws.onerror = (event) => {
          this.debug("WebSocket error", event);
          if (this.connectTimeoutId) {
            clearTimeout(this.connectTimeoutId);
            this.connectTimeoutId = undefined;
            reject(new Error("WebSocket connection failed"));
          }
          if (this.events.onError) {
            this.events.onError(event);
          }
        };

        this.ws.onclose = (event) => {
          this.debug("WebSocket closed", { code: event.code, reason: event.reason });
          this.closed = true;
          if (this.connectTimeoutId) {
            clearTimeout(this.connectTimeoutId);
            this.connectTimeoutId = undefined;
            reject(new Error(`WebSocket closed during connection: ${event.reason}`));
          }
          if (this.events.onClose) {
            this.events.onClose(event);
          }
        };

        this.ws.onmessage = (event) => {
          if (this.events.onMessage) {
            this.events.onMessage(event);
          }
        };

      } catch (error) {
        this.debug("Failed to create WebSocket", error);
        reject(error);
      }
    });
  }

  /**
   * Send data through WebSocket
   */
  public send(data: string | ArrayBuffer | Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocketState.OPEN) {
      throw new Error("WebSocket is not open");
    }

    this.ws.send(data);
  }

  /**
   * Send a ConnectMessage
   */
  public sendMessage(message: ConnectMessage): void {
    const bytes = ConnectMessage.encode(message).finish();
    this.send(bytes);
  }

  /**
   * Close the WebSocket connection
   */
  public close(code?: number, reason?: string): void {
    if (this.closed || !this.ws) {
      return;
    }

    this.debug("Closing WebSocket", { code, reason });
    this.closed = true;
    
    // Save reference before cleanup
    const ws = this.ws;
    
    this.cleanup();

    if (ws.readyState === WebSocketState.OPEN || 
        ws.readyState === WebSocketState.CONNECTING) {
      ws.close(code, reason);
    }
  }

  /**
   * Force close without sending close frame
   */
  public forceClose(): void {
    if (this.closed) {
      return;
    }

    this.debug("Force closing WebSocket");
    this.closed = true;
    this.cleanup();
  }

  /**
   * Clean up resources
   */
  private cleanup(): void {
    if (this.connectTimeoutId) {
      clearTimeout(this.connectTimeoutId);
      this.connectTimeoutId = undefined;
    }

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }

    if (this.ws) {
      // Remove all event handlers to prevent memory leaks
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      this.ws = null;
    }
  }

  /**
   * Set event handlers
   */
  public setEventHandlers(events: WebSocketEvents): void {
    this.events = events;

    if (this.ws) {
      if (events.onOpen) {
        this.ws.onopen = events.onOpen;
      }
      if (events.onMessage) {
        this.ws.onmessage = events.onMessage;
      }
      if (events.onError) {
        this.ws.onerror = events.onError;
      }
      if (events.onClose) {
        this.ws.onclose = events.onClose;
      }
    }
  }

  /**
   * Get current WebSocket state
   */
  public get readyState(): WebSocketState {
    if (!this.ws) {
      return WebSocketState.CLOSED;
    }
    return this.ws.readyState;
  }

  /**
   * Check if WebSocket is open
   */
  public get isOpen(): boolean {
    return this.readyState === WebSocketState.OPEN;
  }

  /**
   * Check if WebSocket is closed
   */
  public get isClosed(): boolean {
    return this.closed || this.readyState === WebSocketState.CLOSED;
  }

  /**
   * Start heartbeat mechanism
   */
  public startHeartbeat(intervalMs: number, onMissedHeartbeats: () => void): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.pendingHeartbeats = 0;

    this.heartbeatInterval = setInterval(() => {
      // Check if we've missed 2 consecutive heartbeats
      if (this.pendingHeartbeats >= 2) {
        this.debug("Missed consecutive heartbeats");
        onMissedHeartbeats();
        return;
      }

      this.debug("Sending heartbeat");
      this.pendingHeartbeats++;
      
      try {
        this.sendMessage(
          ConnectMessage.create({
            kind: GatewayMessageType.WORKER_HEARTBEAT,
            payload: new Uint8Array(),
          })
        );
      } catch (error) {
        this.debug("Failed to send heartbeat", error);
      }
    }, intervalMs);
  }

  /**
   * Reset heartbeat counter (called when gateway heartbeat received)
   */
  public resetHeartbeat(): void {
    this.pendingHeartbeats = 0;
    this.debug("Heartbeat counter reset");
  }

  /**
   * Stop heartbeat mechanism
   */
  public stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
    this.pendingHeartbeats = 0;
  }

  /**
   * Send a pause message before closing
   */
  public sendPauseMessage(): void {
    if (!this.isOpen) {
      return;
    }

    try {
      this.debug("Sending pause message");
      this.sendMessage(
        ConnectMessage.create({
          kind: GatewayMessageType.WORKER_PAUSE,
          payload: new Uint8Array(),
        })
      );
    } catch (error) {
      this.debug("Failed to send pause message", error);
    }
  }

  /**
   * Gracefully close connection with worker shutdown reason
   */
  public gracefulClose(): void {
    this.sendPauseMessage();
    this.close(
      1000,
      workerDisconnectReasonToJSON(WorkerDisconnectReason.WORKER_SHUTDOWN)
    );
  }
}