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
export class LogBuffer {
  readonly level: keyof Logger;
  readonly args: LogArg[];

  constructor(level: keyof Logger, ...args: LogArg[]) {
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
  readonly #logger: Logger;
  #buffer: LogBuffer[] = [];

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  info(...args: LogArg[]) {
    this.#buffer.push(new LogBuffer("info", ...args));
  }

  warn(...args: LogArg[]) {
    this.#buffer.push(new LogBuffer("warn", ...args));
  }

  error(...args: LogArg[]) {
    this.#buffer.push(new LogBuffer("error", ...args));
  }

  debug(...args: LogArg[]) {
    this.#buffer.push(new LogBuffer("debug", ...args));
  }

  reset() {
    this.#buffer = [];
  }

  async flush() {
    if (this.bufSize() === 0) return;

    // eslint-disable-next-line @typescript-eslint/require-await
    const deliveries = this.#buffer.map(async (log) => {
      const args = log.args;
      const level = log["level"];
      return this.#logger[level](...args);
    });
    // NOTE: timestamp will likely not be linear as expected.
    await Promise.allSettled(deliveries);
    this.reset();

    // Allow 1s for the provided logger to handle flushing since the ones that do
    // flushing usually has some kind of timeout of up to 1s.
    //
    // TODO:
    // This should only happen when using a serverless environment because it's very
    // costly from the compute perspective.
    // server runtimes should just let the logger do their thing since most of them
    // should have already figured what to do in those environments, be it threading or
    // something else.
    if (this.#logger.constructor.name !== DefaultLogger.name) {
      await new Promise((resolve) => {
        setTimeout(() => resolve(null), 1000);
      });
    }
  }

  /**
   * Helper function for tests to check current buffer size
   */
  bufSize(): number {
    return this.#buffer.length;
  }
}
