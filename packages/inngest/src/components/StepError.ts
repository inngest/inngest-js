import { deserializeError } from "../helpers/errors.ts";
import { jsonErrorSchema } from "../types.ts";

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
  public override cause?: unknown;

  constructor(
    /**
     * The ID of the step that failed.
     */
    public readonly stepId: string,
    err: unknown,
  ) {
    const parsedErr = jsonErrorSchema.parse(err);

    super(parsedErr.message);
    this.name = parsedErr.name;
    this.stepId = stepId;

    // Don't show the internal stack trace if we don't have one.
    this.stack = parsedErr.stack ?? undefined;

    // Try setting the cause if we have one
    this.cause = parsedErr.cause
      ? deserializeError(parsedErr.cause, true)
      : undefined;
  }
}
