import { z } from "zod";

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
  public readonly cause?: unknown;

  constructor(
    message: string,
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

    this.name = "NonRetriableError";

    /**
     * If the cause we received is an error we can identify, assume all
     * properties of that error.
     */
    if (options?.cause) {
      this.cause = options.cause;

      const causeError = z
        .object({
          name: z.string(),
          message: z.string(),
          stack: z.string().optional(),
        })
        .safeParse(options.cause);

      if (causeError.success) {
        this.name = causeError.data.name;
        this.message = causeError.data.message;
        this.stack = causeError.data.stack;
      }
    }
  }
}
