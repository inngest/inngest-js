import debug, { type Debugger } from "debug";
import {
  type ConnectionEvents,
  type ConnectEventListener,
  type ConnectEventHooks,
} from "./types.js";

/**
 * Simple event manager for connection events.
 */
export class ConnectEventManager {
  private debug: Debugger;
  private listeners: Map<keyof ConnectionEvents, Set<ConnectEventListener<any>>> = new Map();
  private hooks: ConnectEventHooks;

  constructor(hooks: ConnectEventHooks = {}) {
    this.debug = debug("inngest:connect:events");
    this.hooks = hooks;
  }

  /**
   * Add an event listener
   */
  public addEventListener<T extends keyof ConnectionEvents>(
    event: T,
    listener: ConnectEventListener<T>
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }

    this.listeners.get(event)!.add(listener);

    // Return cleanup function
    return () => {
      this.removeEventListener(event, listener);
    };
  }

  /**
   * Remove an event listener
   */
  public removeEventListener<T extends keyof ConnectionEvents>(
    event: T,
    listener: ConnectEventListener<T>
  ): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      eventListeners.delete(listener);
      if (eventListeners.size === 0) {
        this.listeners.delete(event);
      }
    }
  }

  /**
   * Emit an event to all registered listeners and hooks
   */
  public emit<T extends keyof ConnectionEvents>(
    event: T,
    data: ConnectionEvents[T]
  ): void {
    this.debug(`Emitting ${event} event`);

    // Call registered listeners
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      for (const listener of eventListeners) {
        try {
          listener(data);
        } catch (error) {
          this.debug(`Error in ${event} event listener:`, error);
        }
      }
    }

    // Call hook if configured (now type-safe!)
    const hook = this.hooks[event];
    if (hook) {
      try {
        hook(data);
      } catch (error) {
        this.debug(`Error in ${event} event hook:`, error);
      }
    }
  }

  /**
   * Remove all listeners
   */
  public removeAllListeners(): void {
    this.listeners.clear();
  }
}