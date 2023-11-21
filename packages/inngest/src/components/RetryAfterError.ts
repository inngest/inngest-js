import ms from "ms";

/**
 * An error that, when thrown, indicates to Inngest that the function should be
 * retried after a given amount of time.
 *
 * A `message` must be provided, as well as a `retryAfter` parameter, which can
 * be a `number` of milliseconds, an `ms`-compatible time string, or a `Date`.
 *
 * An optional `cause` can be provided to provide more context to the error.
 *
 * @public
 */
export class RetryAfterError extends Error {
  /**
   * The underlying cause of the error, if any.
   *
   * This will be serialized and sent to Inngest.
   */
  public readonly cause?: unknown;

  /**
   * The time after which the function should be retried. Represents either a
   * number of seconds or a RFC3339 date.
   */
  public readonly retryAfter: string;

  constructor(
    message: string,

    /**
     * The time after which the function should be retried. Represents either a
     * number of seconds or a RFC3339 date.
     */
    retryAfter: number | string | Date,

    options?: {
      /**
       * The underlying cause of the error, if any.
       *
       * This will be serialized and sent to Inngest.
       */
      cause?: unknown;
    }
  ) {
    super(message);

    if (retryAfter instanceof Date) {
      this.retryAfter = retryAfter.toISOString();
    } else {
      const seconds = `${Math.ceil(
        (typeof retryAfter === "string" ? ms(retryAfter) : retryAfter) / 1000
      )}`;

      if (!isFinite(Number(seconds))) {
        throw new Error(
          "retryAfter must be a number of seconds, a ms-compatible string, or a Date"
        );
      }

      this.retryAfter = seconds;
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    this.cause = options?.cause;
  }
}
