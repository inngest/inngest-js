import { ConnectionState, type ConnectHandlerOptions } from "./types.ts";
import {
  AuthError,
  ConnectionLimitError,
  expBackoff,
  ReconnectError,
  waitWithCancel,
} from "./util.ts";
import { ConnectionManager } from "./connection.ts";
import { MessageBuffer } from "./buffer.ts";
import { WaitGroup } from "@jpwilliams/waitgroup";

interface ReconcileResult {
  deduped?: boolean;
  done?: boolean;
  waitFor?: number;
}

export class Reconciler extends ConnectionManager {
  private reconcileTick = 250; // attempt to reconcile every 250ms
  private reconciling = false;

  protected inProgressRequests: {
    /**
     * A wait group to track in-flight requests.
     */
    wg: WaitGroup;

    requestLeases: Record<string, string>;
  } = {
    wg: new WaitGroup(),
    requestLeases: {},
  };

  /**
   * The buffer of messages to be sent to the gateway.
   */
  protected messageBuffer: MessageBuffer;

  /**
   * A promise that resolves when the connection is closed on behalf of the
   * user by calling `close()` or when a shutdown signal is received.
   */
  private closingPromise: Promise<void> | undefined;
  protected resolveClosingPromise:
    | ((value: void | PromiseLike<void>) => void)
    | undefined;

  protected closeRequested: boolean = false;
  public override async close(): Promise<void> {
    this.closeRequested = true;

    return this.closed;
  }

  /**
   * A promise that resolves when the connection is closed on behalf of the
   * user by calling `close()` or when a shutdown signal is received.
   */
  get closed(): Promise<void> {
    if (!this.closingPromise) {
      throw new Error("No connection established");
    }
    return this.closingPromise;
  }

  constructor(options: ConnectHandlerOptions) {
    super(options);
    this.messageBuffer = new MessageBuffer(this.inngest);

    this.closingPromise = new Promise((resolve) => {
      this.resolveClosingPromise = resolve;
    });
  }

  public async start() {
    // Set up function configs, etc.
    await this.init();

    // Create reconcile loop
    const scheduleReconcile = (waitFor: number) => {
      const reconcileTimeout = setTimeout(async () => {
        try {
          const res = await this.reconcile();
          if (res.waitFor) {
            scheduleReconcile(res.waitFor);
            return;
          }

          scheduleReconcile(this.reconcileTick);
        } catch (err) {
          // TODO: Ensure this is properly surfaced
          clearTimeout(reconcileTimeout);
          throw err;
        }
      }, waitFor);
    };

    scheduleReconcile(this.reconcileTick);

    // Wait for connection to be established
    for (let attempt = 0; attempt < 10; attempt++) {
      const delay = expBackoff(attempt);
      const cancelled = await waitWithCancel(
        delay,
        () => this.activeConnection !== undefined
      );

      if (cancelled) {
        throw new Error("Connection canceled while establishing");
      }

      if (this.activeConnection) {
        break;
      }
    }
  }

  public get state(): ConnectionState {
    if (this.closeRequested) {
      if (this.connections.length === 0) {
        return ConnectionState.CLOSED;
      }

      return ConnectionState.CLOSING;
    }

    if (this.activeConnection) {
      return ConnectionState.ACTIVE;
    }

    if (this.connections.length > 0) {
      return ConnectionState.RECONNECTING;
    }

    return ConnectionState.CONNECTING;
  }

  private _reconcileAttempt = 0;

  public async reconcile(): Promise<ReconcileResult> {
    try {
      if (this.reconciling) {
        return { deduped: true };
      }
      this.reconciling = true;

      if (this.closeRequested) {
        // Remove the shutdown signal handler
        if (this.cleanupShutdownSignal) {
          this.cleanupShutdownSignal();
          this.cleanupShutdownSignal = undefined;
        }

        // Close and clean up remaining connections
        for (const conn of this.connections) {
          await conn.cleanup();
        }

        // Wait for remaining requests to finish
        this.debug("Waiting for in-flight requests to complete");
        await this.inProgressRequests.wg.wait();

        // Flush messages and retry until buffer is empty
        this.debug("Flushing messages before closing");
        await this.messageBuffer.flush(this.hashedSigningKey);

        // Resolve closing promise
        this.resolveClosingPromise?.();

        return { done: true };
      }

      // Clean up any previous connection state
      // Note: Never reset the message buffer, as there may be pending/unsent messages
      // Flush any pending messages
      await this.messageBuffer.flush(this.hashedSigningKey);

      if (!this.activeConnection) {
        try {
          const conn = await this.connect();
          this.activeConnection = conn;
        } catch (err) {
          this.debug("Failed to connect", err);

          if (!(err instanceof ReconnectError)) {
            throw err;
          }

          if (err instanceof AuthError) {
            const switchToFallback = !this.useFallbackKey;
            if (switchToFallback) {
              this.debug("Switching to fallback signing key");
              this.useFallbackKey = true;
            }
          }

          if (err instanceof ConnectionLimitError) {
            console.error(
              "You have reached the maximum number of concurrent connections. Please disconnect other active workers to continue."
            );
            // Continue reconnecting, do not throw.
          }

          const delay = expBackoff(this._reconcileAttempt);
          this.debug("Reconnecting in", delay, "ms");

          this._reconcileAttempt++;
          return { waitFor: delay };
        }
      }

      const drainingConnection = this.drainingConnection;
      if (drainingConnection) {
        await drainingConnection.cleanup();
        this.drainingConnection = undefined;
      }

      // In case there's only an active connection, close all leftover connections

      for (const conn of this.connections) {
        // Discard non-active connections
        if (this.activeConnection.id === conn.id) {
          continue;
        }
        await conn.cleanup();
      }

      return {};
    } catch (err) {
      this.debug("Reconcile error", err);
      return { waitFor: this.reconcileTick };
    } finally {
      this.reconciling = false;
    }
  }
}
