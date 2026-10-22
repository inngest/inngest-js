/**
 * @module
 * The errors of a command run by `sandbox.$`: one for an exit the command was
 * not allowed to make, one for a timeout, and `getCommandError()` to read
 * either from whatever a handler caught. A step's failure reaches the handler
 * as a `StepError` that carries these as its `cause`, so `instanceof` on the
 * classes would never match; the guard reads the payload instead.
 */

import { z } from "zod/v3";

import { NonRetriableError } from "../NonRetriableError.ts";
import { findInCauses } from "./protocol.ts";
import type { SandboxCommand, SandboxExitCodes } from "./types.ts";

/**
 * How much of each output stream an error keeps. An error is stored in step
 * state, so it must stay small.
 */
export const commandErrorTailBytes = 8 * 1024;

const baseSchema = z.object({
  message: z.string(),
  command: z.string(),
  stdoutTail: z.string(),
  stderrTail: z.string(),
});

const failedSchema = baseSchema.extend({
  type: z.literal("sandbox_command_failed"),
  exitCode: z.number().int(),
});

const timeoutSchema = baseSchema.extend({
  type: z.literal("sandbox_command_timeout"),
});

const payloadSchema = z.union([failedSchema, timeoutSchema]);

type FailedPayload = z.infer<typeof failedSchema>;
type TimeoutPayload = z.infer<typeof timeoutSchema>;

/**
 * A command exited with a code its `exitCodes` did not allow.
 */
export class CommandFailedError extends Error {
  public readonly command: string;
  public readonly exitCode: number;
  /**
   * The end of what the command wrote to stdout, at most 8 KiB.
   */
  public readonly stdoutTail: string;
  /**
   * The end of what the command wrote to stderr, at most 8 KiB.
   */
  public readonly stderrTail: string;
  public override readonly cause?: unknown;

  constructor(payload: FailedPayload, cause?: unknown) {
    super(payload.message);
    this.name = "CommandFailedError";
    this.command = payload.command;
    this.exitCode = payload.exitCode;
    this.stdoutTail = payload.stdoutTail;
    this.stderrTail = payload.stderrTail;
    this.cause = cause;
  }
}

/**
 * A command ran past its `timeout` and was stopped.
 */
export class CommandTimeoutError extends Error {
  public readonly command: string;
  public readonly stdoutTail: string;
  public readonly stderrTail: string;
  public override readonly cause?: unknown;

  constructor(payload: TimeoutPayload, cause?: unknown) {
    super(payload.message);
    this.name = "CommandTimeoutError";
    this.command = payload.command;
    this.stdoutTail = payload.stdoutTail;
    this.stderrTail = payload.stderrTail;
    this.cause = cause;
  }
}

export type CommandError = CommandFailedError | CommandTimeoutError;

/**
 * The last `maxBytes` bytes of `text`, without a character cut in half.
 */
const tail = (text: string, maxBytes: number): string => {
  const bytes = new TextEncoder().encode(text);

  if (bytes.byteLength <= maxBytes) {
    return text;
  }

  return new TextDecoder()
    .decode(bytes.subarray(bytes.byteLength - maxBytes))
    .replace(/^�+/, "");
};

/**
 * The non-retriable error a step throws for a failed command. Its `cause` is
 * the payload that `getCommandError()` reads back.
 */
export const commandFailure = (
  failure: {
    command: string;
    stdout: string;
    stderr: string;
  } & ({ exitCode: number } | { timeout: string }),
): NonRetriableError => {
  const { command, stdout, stderr } = failure;
  const payload: FailedPayload | TimeoutPayload =
    "timeout" in failure
      ? {
          type: "sandbox_command_timeout",
          message: `Command timed out after ${failure.timeout}: ${command}`,
          command,
          stdoutTail: tail(stdout, commandErrorTailBytes),
          stderrTail: tail(stderr, commandErrorTailBytes),
        }
      : {
          type: "sandbox_command_failed",
          message: `Command failed with exit code ${failure.exitCode}: ${command}`,
          command,
          exitCode: failure.exitCode,
          stdoutTail: tail(stdout, commandErrorTailBytes),
          stderrTail: tail(stderr, commandErrorTailBytes),
        };

  return new NonRetriableError(payload.message, { cause: payload });
};

/**
 * A command as an error shows it: the script, or the argv joined.
 */
export const commandText = (command: SandboxCommand): string => {
  return typeof command === "string" ? command : command.join(" ");
};

/**
 * Throws the failure of a command that ended with an exit code that
 * `exitCodes` does not allow.
 */
export const checkExit = (
  exitCodes: SandboxExitCodes,
  result: { command: string; exitCode: number; stdout: string; stderr: string },
): void => {
  if (exitCodes !== "any" && !exitCodes.includes(result.exitCode)) {
    throw commandFailure(result);
  }
};

/**
 * A timeout as an error message names it, such as `5m` or `90s`.
 */
export const formatTimeout = (milliseconds: number): string => {
  if (milliseconds % 60_000 === 0) {
    return `${milliseconds / 60_000}m`;
  }

  return milliseconds % 1_000 === 0
    ? `${milliseconds / 1_000}s`
    : `${milliseconds}ms`;
};

/**
 * Returns the command failure carried by `error`, or `undefined` if it isn't
 * one. A failed `sandbox.$` command rejects with a `StepError`, like any other
 * step, so use this to read its command, exit code and output. Check `name` to
 * tell a failed exit from a timeout.
 */
export const getCommandError = (error: unknown): CommandError | undefined => {
  if (
    error instanceof CommandFailedError ||
    error instanceof CommandTimeoutError
  ) {
    return error;
  }

  const payload = findInCauses(error, payloadSchema);

  if (!payload) {
    return undefined;
  }

  return payload.type === "sandbox_command_failed"
    ? new CommandFailedError(payload, error)
    : new CommandTimeoutError(payload, error);
};
