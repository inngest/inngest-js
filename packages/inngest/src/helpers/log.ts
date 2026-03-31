import type { LogArg, Logger } from "../middleware/logger.ts";
import { isRecord } from "./types.ts";

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

/**
 * Wraps a string-first logger (e.g. Winston) so it accepts Pino-style
 * object-first calls like `logger.info({ requestId: "abc" }, "message")`
 *
 * @example
 * const inngest = new Inngest({
 *   id: "my-app",
 *   logger: wrapStringFirstLogger(winstonLogger),
 * })
 */
export function wrapStringFirstLogger(logger: Logger): Logger {
  function wrap(method: keyof Logger): (...args: LogArg[]) => void {
    return (...args: LogArg[]) => {
      if (args.length > 1 && isRecord(args[0]) && typeof args[1] === "string") {
        // We got 2 args: 1st is a record and 2nd is a string
        const [fields, message, ...rest] = args;
        logger[method](message, fields, ...rest);
      } else {
        logger[method](...args);
      }
    };
  }

  return {
    info: wrap("info"),
    warn: wrap("warn"),
    error: wrap("error"),
    debug: wrap("debug"),
  };
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
