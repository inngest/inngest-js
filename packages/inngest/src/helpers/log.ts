import { getAsyncCtxSync } from "../components/execution/als.ts";
import {
  DefaultLogger,
  type LogArg,
  type Logger,
} from "../middleware/logger.ts";
import type { LogLevel } from "../types.ts";

const defaultLogger = new DefaultLogger("info");

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
  if (loggedKeys.has(key)) return;
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

export function setDefaultLoggerLevel(logLevel: LogLevel): void {
  defaultLogger.setLogLevel(logLevel);
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

export function getLogger(): Logger {
  const ctx = getAsyncCtxSync();
  // `logger` is added to the context by the built-in logger middleware at
  // runtime, so it's not part of the static Context type.
  const fnCtx = ctx?.execution?.ctx as { logger?: Logger } | undefined;

  if (fnCtx?.logger) {
    return fnCtx.logger;
  }

  // Client's logger set by CommHandler/engine ALS scope
  if (ctx?.logger) {
    return ctx.logger;
  }

  return defaultLogger;
}
