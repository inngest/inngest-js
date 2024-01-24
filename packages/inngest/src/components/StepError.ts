import { z } from "zod";

/**
 * An error that represents a step exhausting all retries and failing. This is
 * thrown by an Inngest step if it fails.
 *
 * It's synonymous with an `Error`, with the addition of the `stepId` that
 * failed.
 *
 * @public
 */
export class StepError extends Error {
  constructor(
    /**
     * The ID of the step that failed.
     */
    public readonly stepId: string,
    err: unknown
  ) {
    const parsedErr = z
      .object({
        name: z.string(),
        message: z.string(),
        stack: z.string().optional(),
      })
      .catch({
        name: "Error",
        message: "An unknown error occurred; could not parse error",
      })
      .parse(err);

    super(parsedErr.message);
    this.name = parsedErr.name;
    this.stepId = stepId;

    // Don't show the internal stack trace if we don't have one.
    this.stack = parsedErr.stack ?? undefined;
  }
}
