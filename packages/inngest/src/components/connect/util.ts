export class ReconnectError extends Error {
  constructor(
    message: string,
    public attempt: number
  ) {
    super(message);
    this.name = "ReconnectError";
  }
}

export class AuthError extends ReconnectError {
  constructor(message: string, attempt: number) {
    super(message, attempt);
    this.name = "AuthError";
  }
}

export class ConnectionLimitError extends ReconnectError {
  constructor(attempt: number) {
    super("Connection limit exceeded", attempt);
    this.name = "ConnectionLimitError";
  }
}

export function expBackoff(attempt: number): number {
  const backoffTimes = [
    1000, 2000, 5000, 10_000, 20_000, 30_000, 60_000, 120_000, 300_000,
  ];

  // If attempt exceeds array length, use the last (maximum) value
  return backoffTimes[Math.min(attempt, backoffTimes.length - 1)] ?? 60_000;
}

/**
 * Wait for a given amount of time, but cancel if the given condition is true.
 *
 * Returns `true` if the condition was met, `false` if the timeout was reached.
 */
export function waitWithCancel(ms: number, cancelIf: () => boolean) {
  return new Promise<boolean>((resolve) => {
    const startTime = Date.now();
    const interval = setInterval(() => {
      if (cancelIf()) {
        clearInterval(interval);
        resolve(true);
        return;
      }

      if (Date.now() - startTime >= ms) {
        clearInterval(interval);
        resolve(false);
        return;
      }
    }, 100);
  });
}
