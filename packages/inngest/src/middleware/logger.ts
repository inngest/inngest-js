import { resolveNextTick } from "../helpers/promises.ts";
import type { LogLevel } from "../types.ts";

/**
 * All kinds of arguments can come through
 *
 * Examples seen are
 * - string
 * - object / hash
 * - values used for string interpolation, basically anything
 *
 * See https://linear.app/inngest/issue/INN-1342/flush-logs-on-function-exitreturns for more details
 *
 * @public
 */
export type LogArg = unknown;

/**
 * Based on https://datatracker.ietf.org/doc/html/rfc5424#autoid-11
 * it's pretty reasonable to expect a logger to have the following interfaces
 * available.
 */
export interface Logger {
  info(...args: LogArg[]): void;
  warn(...args: LogArg[]): void;
  error(...args: LogArg[]): void;
  debug(...args: LogArg[]): void;
}

/**
 * Numeric ranking for log levels. Higher = more severe.
 * Used to determine if a message should be logged based on configured level.
 */
const LOG_LEVEL_RANK = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
} as const;

type CallableLogLevel = keyof typeof LOG_LEVEL_RANK;

/**
 * Console-based logger. Not for production use.
 */
export class ConsoleLogger implements Logger {
  private readonly level: LogLevel;

  constructor(level: LogLevel = "info") {
    this.level = level;
  }

  info(...args: LogArg[]) {
    if (this.shouldLog("info")) {
      console.info(...args);
    }
  }

  warn(...args: LogArg[]) {
    if (this.shouldLog("warn")) {
      console.warn(...args);
    }
  }

  error(...args: LogArg[]) {
    if (this.shouldLog("error")) {
      console.error(...args);
    }
  }

  debug(...args: LogArg[]) {
    if (this.shouldLog("debug")) {
      console.debug(...args);
    }
  }

  private shouldLog(level: CallableLogLevel): boolean {
    if (this.level === "silent") {
      return false;
    }

    // Map configured level to a callable level (fatal -> error)
    let effectiveLevel: CallableLogLevel = "info";
    if (this.level === "fatal") {
      effectiveLevel = "error";
    } else if (this.level in LOG_LEVEL_RANK) {
      effectiveLevel = this.level as CallableLogLevel;
    }

    return LOG_LEVEL_RANK[level] >= LOG_LEVEL_RANK[effectiveLevel];
  }
}

/**
 * ProxyLogger aims to provide a thin wrapper on user's provided logger.
 * It's expected to be turned on and off based on the function execution
 * context, so it doesn't result in duplicated logging.
 *
 * And also attempt to allow enough time for the logger to flush all logs.
 *
 * @public
 */
export class ProxyLogger implements Logger {
  private readonly logger: Logger;
  private enabled = false;

  constructor(logger: Logger) {
    this.logger = logger;

    // Return a Proxy to forward arbitrary property access to the underlying
    // logger. For example, if the user provides a logger that has a `foo`
    // method, they can call `foo` on the ProxyLogger and it will call the
    // underlying logger's `foo` method.
    return new Proxy(this, {
      get(target, prop, receiver): unknown {
        // Handle ProxyLogger's own methods/properties.
        if (prop in target) {
          return Reflect.get(target, prop, receiver);
        }

        // Forward property access to the underlying logger.
        return Reflect.get(target.logger, prop, receiver);
      },
    }) as ProxyLogger;
  }

  info(...args: LogArg[]) {
    if (!this.enabled) {
      return;
    }
    this.logger.info(...args);
  }

  warn(...args: LogArg[]) {
    if (!this.enabled) {
      return;
    }
    this.logger.warn(...args);
  }

  error(...args: LogArg[]) {
    if (!this.enabled) {
      return;
    }
    this.logger.error(...args);
  }

  debug(...args: LogArg[]) {
    if (!this.enabled || !(typeof this.logger.debug === "function")) {
      return;
    }
    this.logger.debug(...args);
  }

  enable() {
    this.enabled = true;
  }

  disable() {
    this.enabled = false;
  }

  async flush() {
    // If DefaultLogger, nothing to wait for
    if (this.logger.constructor.name == ConsoleLogger.name) {
      return;
    }

    const logger = this.logger as Logger & {
      flush?: () => Promise<void> | void;
    };

    // If the logger has its own flush, defer to it
    if (typeof logger.flush === "function") {
      await logger.flush();
      return;
    }

    // Otherwise yield one event-loop tick (non-blocking hint for buffered loggers)
    await resolveNextTick();
  }
}
