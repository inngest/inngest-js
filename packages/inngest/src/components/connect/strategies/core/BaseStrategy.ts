import type { Debugger } from "debug";
import { onShutdown } from "../../os.ts";
import { ConnectionState } from "../../types.ts";
import type { ConnectionStrategy } from "./types.ts";

/**
 * Base class for connection strategies providing common functionality
 * for state management, shutdown signal handling, and close lifecycle.
 */
export abstract class BaseStrategy implements ConnectionStrategy {
  protected _state: ConnectionState = ConnectionState.CONNECTING;
  protected closingPromise: Promise<void>;
  protected resolveClosingPromise:
    | ((value: void | PromiseLike<void>) => void)
    | undefined;
  protected cleanupShutdownSignal: (() => void) | undefined;

  protected abstract readonly debugLog: Debugger;

  constructor() {
    this.closingPromise = new Promise((resolve) => {
      this.resolveClosingPromise = resolve;
    });
  }

  get state(): ConnectionState {
    return this._state;
  }

  get closed(): Promise<void> {
    return this.closingPromise;
  }

  abstract get connectionId(): string | undefined;
  abstract connect(attempt?: number): Promise<void>;
  abstract close(): Promise<void>;

  /**
   * Set up shutdown signal handlers that will trigger close() on SIGINT/SIGTERM.
   */
  protected setupShutdownSignal(signals: string[]): void {
    if (this.cleanupShutdownSignal) {
      return;
    }

    this.debugLog(
      `Setting up shutdown signal handler for ${signals.join(", ")}`,
    );

    const cleanupShutdownHandlers = onShutdown(signals, () => {
      this.debugLog("Received shutdown signal, closing connection");
      void this.close();
    });

    this.cleanupShutdownSignal = () => {
      this.debugLog("Cleaning up shutdown signal handler");
      cleanupShutdownHandlers();
    };
  }

  /**
   * Clean up shutdown signal handlers. Call at the start of close().
   */
  protected cleanupShutdown(): void {
    if (this.cleanupShutdownSignal) {
      this.cleanupShutdownSignal();
      this.cleanupShutdownSignal = undefined;
    }
  }

  /**
   * Mark the connection as closing. Call after cleanupShutdown().
   */
  protected setClosing(): void {
    this._state = ConnectionState.CLOSING;
  }

  /**
   * Mark the connection as closed and resolve the closing promise.
   * Call at the end of close().
   */
  protected setClosed(): void {
    this._state = ConnectionState.CLOSED;
    this.resolveClosingPromise?.();
  }

  /**
   * Set up shutdown signals if configured in options.
   * Call at the start of connect().
   */
  protected setupShutdownSignalIfConfigured(
    handleShutdownSignals: string[] | undefined,
  ): void {
    if (handleShutdownSignals && handleShutdownSignals.length > 0) {
      this.setupShutdownSignal(handleShutdownSignals);
    }
  }

  /**
   * Throw if the connection is closing or closed.
   * Call at the start of connect().
   */
  protected throwIfClosingOrClosed(): void {
    if (
      this._state === ConnectionState.CLOSING ||
      this._state === ConnectionState.CLOSED
    ) {
      throw new Error("Connection already closed");
    }
  }
}
