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

export function expBackoff(attempt: number) {
  const backoffTimes = [
    1000, 2000, 5000, 10000, 20000, 30000, 60000, 120000, 300000,
  ];
  // If attempt exceeds array length, use the last (maximum) value
  return backoffTimes[Math.min(attempt, backoffTimes.length - 1)];
}
