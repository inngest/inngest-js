/**
 * Saying what kind of failure a command had, from its exit code and output.
 * The first matching rule wins, and every wording about infrastructure is a
 * guess, so it is always "probably".
 *
 * @module
 */

import type { ErrorClass } from "../errors.ts";
import { stripAnsi } from "../util.ts";

/**
 * Output that says the problem was the platform, not the change. Adding a
 * signal is one entry here and one test.
 */
export const infraSignals: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /Dev Server startup timed out/i,
    reason: "the Dev Server never became ready",
  },
  { pattern: /\bECONNRESET\b/, reason: "a connection was reset" },
  { pattern: /\bETIMEDOUT\b/, reason: "a network request timed out" },
  { pattern: /\bENOTFOUND\b/, reason: "a host could not be found" },
  { pattern: /\bENOSPC\b/, reason: "the machine ran out of disk" },
  {
    pattern: /registry[^\n]*\b50[23]\b|\b50[23]\b[^\n]*registry/i,
    reason: "the package registry was unavailable",
  },
];

/** The first infrastructure signal in `output`, if any. */
export const infraSignal = (
  output: string,
): { pattern: RegExp; reason: string } | undefined => {
  return infraSignals.find((signal) => {
    return signal.pattern.test(output);
  });
};

/** `path(line,col): error TS1234: message`, as `tsc --pretty false` prints. */
export const tscDiagnostic =
  /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/gm;

/** What a test runner's summary says, when it printed one. */
export const testCounts = (
  output: string,
): { failed: number; passed: number } | undefined => {
  const line = stripAnsi(output).match(/^\s*Tests\s+(.+)$/m)?.[1];

  if (!line) {
    return undefined;
  }

  const failed = Number(line.match(/(\d+) failed/)?.[1] ?? 0);
  const passed = Number(line.match(/(\d+) passed/)?.[1] ?? 0);

  return { failed, passed };
};

/** Which class of failure a finished command was. */
export const classifyCommand = (command: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): ErrorClass => {
  const output = stripAnsi(`${command.stderr}\n${command.stdout}`);

  if (command.exitCode === 137) {
    return "oom";
  }

  if (command.exitCode === 124) {
    return "timeout";
  }

  if (command.exitCode === 143) {
    return "signal";
  }

  if ((testCounts(output)?.failed ?? 0) > 0) {
    return "test";
  }

  if (new RegExp(tscDiagnostic.source, "m").test(output)) {
    return "code";
  }

  return infraSignal(output) ? "infra" : "failure";
};
