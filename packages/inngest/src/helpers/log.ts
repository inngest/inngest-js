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
 * Structurally compatible with winston's `TransformableInfo` so the function
 * can be passed directly to `winston.format()` without casting.
 */
interface WinstonLogEntry {
  level: string;
  message: unknown;
  [key: string | symbol]: unknown;
}

/**
 * Winston format transform that enables pino-style object-first logging. Wrap
 * with `winston.format()` and add to your `format.combine()` pipeline before
 * `format.json()`. This is a workaround for the fact that by default, Winston
 * doesn't support Pino-style object-first logging (the object will be lost).
 *
 * @example
 * const logger = winston.createLogger({
 *   format: winston.format.combine(
 *     winston.format(winstonStructuredLog)(),
 *     winston.format.json()
 *   ),
 *   transports: [new winston.transports.Console()]
 * });
 *
 * logger.info({ requestId: "abc" }, "request received");
 * // => {"level":"info","message":"request received","requestId":"abc"}
 */
// @privateRemarks
// When called as `logger.info({ requestId: "abc" }, "request received")`,
// Winston stashes extra args in `Symbol.for("splat")` and places the object as
// `info.message`. This transform detects that pattern, spreads the object onto
// the log info, and replaces `message` with the string argument.
export function winstonStructuredLog(info: WinstonLogEntry): WinstonLogEntry {
  const splat = info[Symbol.for("splat")];

  if (
    isRecord(info.message) &&
    Array.isArray(splat) &&
    splat.length > 0 &&
    typeof splat[0] === "string"
  ) {
    // Destructure out winston's own keys so the user's object can't
    // accidentally overwrite them (e.g. a stray `level` field).
    const {
      level: _l,
      message: _m,
      ...fields
    } = info.message as Record<string, unknown>;

    const message: unknown = splat.shift();
    if (typeof message !== "string") {
      return info;
    }

    Object.assign(info, fields);
    info.message = message;
  }

  return info;
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
