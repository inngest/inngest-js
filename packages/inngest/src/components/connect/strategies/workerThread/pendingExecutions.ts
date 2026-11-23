import type { Logger } from "../../../../middleware/logger.ts";

/**
 * A single executor request to process for up to 2 hours. Use the same upper
 * bound while the worker thread waits for the main thread to return an
 * execution response, so an unresolved promise cannot hold worker and process
 * resources indefinitely.
 */
const defaultTimeoutMs = 2 * 60 * 60 * 1000;

export class ConnectExecutionTimeoutError extends Error {
  constructor(requestId: string, timeoutMs: number) {
    super(
      `Connect execution request timed out after ${timeoutMs}ms: ${requestId}`,
    );
    this.name = "ConnectExecutionTimeoutError";
  }
}

interface PendingExecution {
  resolve: (response: Uint8Array) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface PendingExecutionsOptions {
  logger: Logger;
  timeoutMs?: number;
}

/**
 * Tracks execution requests sent from the worker thread to the main thread.
 * Each request must receive an execution response or error before the connect
 * request timeout, otherwise the worker releases its pending waiter.
 *
 * Future improvement: add main-thread-to-worker heartbeats so the worker can
 * detect a lost execution request sooner than the 2 hour request timeout.  The
 * heartbeat interval must be generous, e.g. 5 minutes, because user code can
 * legitimately block the main thread's event loop for extended periods.
 */
export class PendingExecutions {
  private readonly logger: Logger;
  private readonly pending = new Map<string, PendingExecution>();
  private readonly timeoutMs: number;

  constructor(opts: PendingExecutionsOptions) {
    this.logger = opts.logger;
    this.timeoutMs = opts.timeoutMs ?? defaultTimeoutMs;
  }

  /**
   * Wait for the execution request to complete.
   * Call before posting EXECUTION_REQUEST so a fast response cannot be missed.
   * There must be at most one waiter per request ID.
   */
  wait(requestId: string): Promise<Uint8Array> {
    if (this.pending.has(requestId)) {
      throw new Error(`Pending execution already exists: ${requestId}`);
    }

    return new Promise<Uint8Array>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pending.get(requestId);
        if (!pending) {
          return;
        }

        this.logger.warn(
          {
            requestId,
            timeoutMs: this.timeoutMs,
          },
          "Execution request timed out waiting for main thread response",
        );

        pending.reject(
          new ConnectExecutionTimeoutError(requestId, this.timeoutMs),
        );
        this.pending.delete(requestId);
      }, this.timeoutMs);

      this.pending.set(requestId, { reject, resolve, timeout });
    });
  }

  /**
   * Complete a pending request with the encoded SDK response returned by the
   * main thread.
   */
  resolve(requestId: string, response: Uint8Array): void {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    pending.resolve(response);
    this.pending.delete(requestId);
  }

  /**
   * Fail a pending request when the main thread reports an execution error.
   */
  reject(requestId: string, error: Error): void {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    pending.reject(error);
    this.pending.delete(requestId);
  }

  /**
   * Exposed for tests and debug assertions.
   */
  get size(): number {
    return this.pending.size;
  }
}
