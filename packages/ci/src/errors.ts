/**
 * Errors thrown by `inngest/ci`.
 *
 * Messages are written to say what happened and how to fix it, because CI
 * failures are usually read by someone who didn't write the pipeline.
 *
 * @module
 */

/**
 * What kind of failure a command had, which decides how its check reads and
 * which button comes first. Infrastructure classes are guesses from the output.
 */
export type ErrorClass =
  | "sandbox"
  | "timeout"
  | "oom"
  | "signal"
  | "test"
  | "code"
  | "infra"
  | "failure";

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Thrown when a CI API is used in a place it can't work, like calling `$`
 * outside a job.
 */
export class CiUsageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);

    this.name = "CiUsageError";
  }
}

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Thrown when a command exits with a non-zero code.
 */
export class CommandFailedError extends Error {
  public readonly command: string[];
  public readonly exitCode: number;
  public readonly stdoutTail: string;
  public readonly stderrTail: string;
  public readonly jobPath: string;
  /** What kind of failure it was, worked out from its exit code and output. */
  public readonly errorClass?: ErrorClass;
  /** The ID of the command's step, which is where it is in the trace. */
  public readonly stepId?: string;

  constructor(options: {
    command: string[];
    exitCode: number;
    stdoutTail: string;
    stderrTail: string;
    jobPath: string;
    errorClass?: ErrorClass;
    stepId?: string;
  }) {
    const detail = options.stderrTail || options.stdoutTail;

    super(
      `\`${options.command.join(" ")}\` exited with ${options.exitCode}${
        detail ? `\n${detail}` : ""
      }`,
    );

    this.name = "CommandFailedError";

    this.command = options.command;

    this.exitCode = options.exitCode;

    this.stdoutTail = options.stdoutTail;

    this.stderrTail = options.stderrTail;

    this.jobPath = options.jobPath;

    if (options.errorClass) {
      this.errorClass = options.errorClass;
    }

    if (options.stepId) {
      this.stepId = options.stepId;
    }
  }
}

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Thrown when a command passes the timeout given to `.timeout()`.
 */
export class CommandTimeoutError extends Error {
  public readonly command: string[];
  public readonly timeout: string;
  public readonly jobPath: string;
  public readonly errorClass: ErrorClass = "timeout";
  /** The ID of the command's step, which is where it is in the trace. */
  public readonly stepId?: string;

  constructor(options: {
    command: string[];
    timeout: string;
    jobPath: string;
    errorClass?: ErrorClass;
    stepId?: string;
  }) {
    super(
      `\`${options.command.join(" ")}\` timed out after ${options.timeout}`,
    );

    this.name = "CommandTimeoutError";

    this.command = options.command;

    this.timeout = options.timeout;

    this.jobPath = options.jobPath;

    if (options.stepId) {
      this.stepId = options.stepId;
    }
  }
}
