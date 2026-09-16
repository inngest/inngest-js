/**
 * Errors thrown by `inngest/ci`.
 *
 * Messages are written to say what happened and how to fix it, because CI
 * failures are usually read by someone who didn't write the pipeline.
 */

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
 * Thrown when a typed API exists but the platform doesn't support it yet. See
 * `unsupported.ts` for the full list.
 */
export class CiNotSupportedError extends Error {
  public readonly feature: string;

  constructor(feature: string, message: string) {
    super(message);
    this.name = "CiNotSupportedError";
    this.feature = feature;
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

  constructor(options: {
    command: string[];
    exitCode: number;
    stdoutTail: string;
    stderrTail: string;
    jobPath: string;
  }) {
    super(
      `\`${options.command.join(" ")}\` exited with ${options.exitCode}${
        options.stderrTail ? `\n${options.stderrTail}` : ""
      }`,
    );
    this.name = "CommandFailedError";
    this.command = options.command;
    this.exitCode = options.exitCode;
    this.stdoutTail = options.stdoutTail;
    this.stderrTail = options.stderrTail;
    this.jobPath = options.jobPath;
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

  constructor(options: {
    command: string[];
    timeout: string;
    jobPath: string;
  }) {
    super(
      `\`${options.command.join(" ")}\` timed out after ${options.timeout}`,
    );
    this.name = "CommandTimeoutError";
    this.command = options.command;
    this.timeout = options.timeout;
    this.jobPath = options.jobPath;
  }
}
