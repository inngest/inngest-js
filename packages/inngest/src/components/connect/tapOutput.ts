/**
 * How Live Tap and Pull report: one choice of output mode and one reporter, so
 * both read the same.
 *
 * @module
 */

import { envKeys } from "../../helpers/consts.ts";

/**
 * `human` lines, `json` lines for programs, or `agent` for coding agents
 * (human lines plus guidance on what to do next).
 */
export type TapOutput = "human" | "json" | "agent";

export const isOn = (value: string | undefined): boolean => {
  return value === "1" || value === "true";
};

/**
 * `INNGEST_TAP_OUTPUT` wins, then a coding agent (`CLAUDECODE`,
 * `INNGEST_AGENT=1`), then whether stderr is a terminal.
 */
export const detectOutput = (
  env: Record<string, string | undefined>,
): TapOutput => {
  const given = env[envKeys.InngestTapOutput];
  if (given === "json" || given === "human" || given === "agent") {
    return given;
  }

  if (env[envKeys.ClaudeCode] || isOn(env[envKeys.InngestAgent])) {
    return "agent";
  }

  return process.stderr.isTTY ? "human" : "json";
};

const GUIDE = [
  "tap: this connects your code to real Inngest runs. Flow: pull a failing run, write a failing test, fix it, see it pass, tap it (shadow and once first), then ship.",
  "tap: every line is one request or step. Open its link to see the run. Shadow mode runs your code for real, side effects included.",
];

export const createReporter = (
  output: TapOutput,
  write: (line: string) => void = (line) => {
    process.stderr.write(`${line}\n`);
  },
) => {
  return {
    emit(
      event: string,
      human: string,
      fields: Record<string, unknown> = {},
    ): void {
      write(output === "json" ? JSON.stringify({ event, ...fields }) : human);
    },

    guide(): void {
      if (output === "agent") {
        for (const line of GUIDE) {
          write(line);
        }
      }
    },
  };
};
