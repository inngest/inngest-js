/**
 * All kinds of arguments can come through
 *
 * Examples seen are
 * - string
 * - object / hash
 * - values used for string interpolation, basically anything
 *
 * See https://linear.app/inngest/issue/INN-1342/flush-logs-on-function-exitreturns for more details
 */
type LogArg = unknown;

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

export class DefaultLogger implements Logger {
  info(...args: LogArg[]) {
    console.info(...args);
  }

  warn(...args: LogArg[]) {
    console.warn(...args);
  }

  error(...args: LogArg[]) {
    console.error(...args);
  }

  debug(...args: LogArg[]) {
    console.debug(...args);
  }
}

/**
 * LogBuffer hold the args that will be passed on to the actual
 * logger when attempting to flush.
 */
class LogBuffer {
  public readonly level: string;
  public readonly args: LogArg[];

  constructor(level: string, ...args: LogArg[]) {
    this.level = level;
    this.args = args;
  }
}

/**
 * ProxyLogger attempts to temporarily hold user's logs
 * during the function run, and attempt to flush it through
 * the provided logger when the function returns.
 *
 * The expected usage of this class is,
 * 1. store the log attempt with its arguments and level
 * 2. if function hits a step that has been memorized, clear the _buffer
 * 3. on function return, flush all buffers
 *
 * And it should be invisible to the user as much as possible.
 */
export class ProxyLogger implements Logger {
  private readonly _logger: Logger;
  private _buffer: LogBuffer[] = [];

  constructor(logger: Logger) {
    this._logger = logger;
  }

  info(...args: LogArg[]) {
    this._buffer.push(new LogBuffer("info", ...args));
  }

  warn(...args: LogArg[]) {
    this._buffer.push(new LogBuffer("warn", ...args));
  }

  error(...args: LogArg[]) {
    this._buffer.push(new LogBuffer("error", ...args));
  }

  debug(...args: LogArg[]) {
    this._buffer.push(new LogBuffer("debug", ...args));
  }

  reset() {
    this._buffer = [];
  }

  flush() {
    throw new Error("TO BE IMPLEMENTED");
  }
}
