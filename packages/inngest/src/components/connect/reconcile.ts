import { WaitGroup } from "@jpwilliams/waitgroup";
import { MessageBuffer } from "./buffer.ts";
import { ConnectionManager } from "./connection.ts";
import { type ConnectHandlerOptions, ConnectionState } from "./types.ts";
import {
  AuthError,
  ConnectionLimitError,
  expBackoff,
  ReconnectError,
} from "./util.ts";

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
    this.messageBuffer = new MessageBuffer(this.inngest, this.logger);

    this.closingPromise = new Promise((resolve) => {
      this.resolveClosingPromise = resolve;
    });
  }

  public async startReconciler() {
    // Create reconcile loop
    const scheduleReconcile = (waitFor: number) => {
      const reconcileTimeout = setTimeout(async () => {
        try {
          const res = await this.reconcile();

          if (res.done) {
            this.logger.debug("Stopping reconcile loop");
            return;
          }

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
      // Only run one reconcile at a time
      if (this.reconciling) {
        return { deduped: true };
      }
      this.reconciling = true;

      // If user requested to close connection, perform closing procedure
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
        const waitingFor = Object.keys(
          this.inProgressRequests.requestLeases,
        ).length;
        if (waitingFor > 0) {
          this.logger.debug("Still waiting for requests to finish", {
            num_requests: waitingFor,
          });
          // Requeue and wait until request completes
          return { waitFor: 1000 };
        }

        // Flush messages and retry until buffer is empty
        this.logger.debug("Flushing messages before closing");
        await this.messageBuffer.flush(this.hashedSigningKey);

        // Resolve closing promise
        this.resolveClosingPromise?.();

        return { done: true };
      }

      // User did not request close, so we need to ensure healthy connection

      if (!this.activeConnection) {
        try {
          const conn = await this.connect();
          this.activeConnection = conn;
        } catch (err) {
          this.logger.error("Failed to connect", err);

          if (!(err instanceof ReconnectError)) {
            throw err;
          }

          if (err instanceof AuthError) {
            const switchToFallback = !this.useFallbackKey;
            if (switchToFallback) {
              this.logger.warn("Switching to fallback signing key");
              this.useFallbackKey = true;
            }
          }

          if (err instanceof ConnectionLimitError) {
            console.error(
              "You have reached the maximum number of concurrent connections. Please disconnect other active workers to continue.",
            );
            // Continue reconnecting, do not throw.
          }

          const delay = expBackoff(this._reconcileAttempt);
          this.logger.info("Reconnecting in", delay, "ms");

          this._reconcileAttempt++;
          return { waitFor: delay };
        }
      }

      // We got here so a healthy connection exists

      // If there's a draining connection, clean it up

      const drainingConnection = this.drainingConnection;
      if (drainingConnection) {
        drainingConnection.ws.close();

        await drainingConnection.cleanup();
        this.drainingConnection = undefined;
      }

      // We got here which means there's only one active connection

      // Close all leftover connections
      for (const conn of this.connections) {
        // Discard non-active connections
        if (this.activeConnection.id === conn.id) {
          continue;
        }
        await conn.cleanup();
      }

      // Flush any pending messages
      await this.messageBuffer.flush(this.hashedSigningKey);

      return {};
    } catch (err) {
      this.logger.error("Reconcile error", err);
      return { waitFor: this.reconcileTick };
    } finally {
      this.reconciling = false;
    }
  }
}
