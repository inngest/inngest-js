/**
 * @module
 * The failure of a command run by `sandbox.$`: the non-retriable error a step
 * throws for an exit the command was not allowed to make, a timeout or a
 * process that ended without an exit, and `getCommandError()` to read it from
 * whatever a handler caught. A failed step reaches the handler as a
 * `StepError` carrying these as its `cause` (a captured command's timeout, as
 * the error itself), so the guard reads the payload, not `instanceof`.
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

/**
 * How much of the command an error shows.
 */
export const commandErrorTextBytes = 1024;

const payloadSchema = z.object({
  type: z.enum(["failed", "timeout"]),
  message: z.string(),
  command: z.string(),
  exitCode: z.number().int().optional(),
  stdoutTail: z.string(),
  stderrTail: z.string(),
});

/**
 * What a failed command carries: its `type` (`"failed"` for an exit that was
 * not allowed or a process that ended without one, `"timeout"` for a command
 * stopped at its timeout), the command, its `exitCode` when it exited, and the
 * last 8 KiB of its stdout and stderr. A single-step command that times out
 * has empty tails, because the server returns no output for it.
 */
export type CommandError = z.infer<typeof payloadSchema>;

/**
 * `text` cut to `maxBytes` at one end, without a character cut in half.
 */
export const clip = (
  text: string,
  maxBytes: number,
  keep: "start" | "end",
): string => {
  const bytes = new TextEncoder().encode(text);

  if (bytes.byteLength <= maxBytes) {
    return text;
  }

  // A continuation byte (10xxxxxx) is the middle of a character
  const inside = (index: number): boolean => {
    return ((bytes[index] ?? 0) & 0xc0) === 0x80;
  };
  let from = keep === "end" ? bytes.byteLength - maxBytes : 0;
  let to = keep === "end" ? bytes.byteLength : maxBytes;

  while (inside(from)) {
    from++;
  }

  while (inside(to)) {
    to--;
  }

  const cut = new TextDecoder().decode(bytes.subarray(from, to));

  return keep === "end" ? cut : `${cut}…`;
};

/**
 * The non-retriable error a step throws for a failed command. `reason` ends
 * the message ("failed with exit code 2", "timed out after 5m"), and the
 * error's `cause` is the payload that `getCommandError()` reads back.
 */
export const commandFailure = (failure: {
  type: CommandError["type"];
  reason: string;
  command: string;
  exitCode?: number;
  stdout: string;
  stderr: string;
}): NonRetriableError => {
  const command = clip(failure.command, commandErrorTextBytes, "start");
  const payload: CommandError = {
    type: failure.type,
    message: `Command ${failure.reason}: ${command}`,
    command,
    ...(failure.exitCode !== undefined && { exitCode: failure.exitCode }),
    stdoutTail: clip(failure.stdout, commandErrorTailBytes, "end"),
    stderrTail: clip(failure.stderr, commandErrorTailBytes, "end"),
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
    throw commandFailure({
      ...result,
      type: "failed",
      reason: `failed with exit code ${result.exitCode}`,
    });
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
 * step (a captured command's timeout, with a `NonRetriableError`), so use this
 * to read its command, exit code and output.
 */
export const getCommandError = (error: unknown): CommandError | undefined => {
  return findInCauses(error, payloadSchema);
};
