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
 * ProxyLogger aims to provide a thin wrapper on user's provided logger.
 * It's expected to be turned on and off based on the function execution
 * context, so it doesn't result in duplicated logging.
 *
 * And also attempt to allow enough time for the logger to flush all logs.
 *
 * @public
 */
export class ProxyLogger implements Logger {
  readonly #logger: Logger;
  #enabled = false;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  info(...args: LogArg[]) {
    if (!this.#enabled) return;
    this.#logger.info(...args);
  }

  warn(...args: LogArg[]) {
    if (!this.#enabled) return;
    this.#logger.warn(...args);
  }

  error(...args: LogArg[]) {
    if (!this.#enabled) return;
    this.#logger.error(...args);
  }

  debug(...args: LogArg[]) {
    // there are loggers that don't implement "debug" by default
    if (!this.#enabled || !(typeof this.#logger.debug === "function")) return;
    this.#logger.debug(...args);
  }

  enable() {
    this.#enabled = true;
  }

  disable() {
    this.#enabled = false;
  }

  async flush() {
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
}
