/**
 * An error that, when thrown, indicates to Inngest that the function should
 * cease all execution and not retry.
 *
 * A `message` must be provided, and an optional `cause` can be provided to
 * provide more context to the error.
 *
 * @public
 */
export class NonRetriableError extends Error {
  /**
   * The underlying cause of the error, if any.
   *
   * This will be serialized and sent to Inngest.
   */
  public readonly cause?: any;

  constructor(
    message: string,
    options?: {
      /**
       * The underlying cause of the error, if any.
       *
       * This will be serialized and sent to Inngest.
       */
      cause?: any;
    }
  ) {
    super(message);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    this.cause = options?.cause;
  }
}
