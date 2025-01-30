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

export function expBackoff(attempt: number) {
  const backoffTimes = [
    1000, 2000, 5000, 10_000, 20_000, 30_000, 60_000, 120_000, 300_000,
  ];
  // If attempt exceeds array length, use the last (maximum) value
  return backoffTimes[Math.min(attempt, backoffTimes.length - 1)];
}
