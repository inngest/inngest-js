import type { LogArg, Logger } from "../middleware/logger.ts";

const loggedKeys = new Set<string>();

/**
 * Log a message exactly once per process lifetime.
 * Subsequent calls with the same `key` are no-ops.
 */
export function logOnce(
  logger: Logger,
  level: "debug" | "info" | "warn" | "error",
  key: string,
  ...args: LogArg[]
): void {
  if (loggedKeys.has(key)) {
    return;
  }
  loggedKeys.add(key);
  logger[level](...args);
}

/**
 * Log a warning exactly once per process lifetime.
 * Subsequent calls with the same `key` are no-ops.
 */
export function warnOnce(logger: Logger, key: string, ...args: LogArg[]): void {
  logOnce(logger, "warn", key, ...args);
}

export interface StructuredLogMessage {
  message: string;
  code?: string;
  explanation?: string;
  action?: string;
  docs?: string;
}

export function formatLogMessage(opts: StructuredLogMessage): string {
  return [
    opts.message,
    opts.explanation,
    opts.action && `To fix: ${opts.action}`,
    opts.docs && `See: ${opts.docs}`,
    opts.code && `[${opts.code}]`,
  ]
    .filter(Boolean)
    .join(" ");
}
