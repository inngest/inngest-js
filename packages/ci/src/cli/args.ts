/**
 * Parsing `inngest-ci`'s command line. Options the CLI doesn't know are
 * matrix axes (`--os linux`), so they're split out before `parseArgs` sees
 * them: `parseArgs` would read the value of an unknown option as a positional.
 *
 * @module
 */

import { parseArgs } from "node:util";

import { errorMessage } from "../util.ts";
import { SetupError } from "./setupError.ts";

export const usage = `Usage: inngest-ci <pipeline|job> [options]

Run a pipeline or a job of your app locally, on Sandboxes.

Options:
  --pipeline <id>      Run this pipeline, when a job has the same name
  --job <id>           Run this job, when a pipeline has the same name
  --event <name>       The trigger to run a pipeline with, when it has several
  --data <json>        The event data for a manual or comment trigger
  --input <json>       The input of a job that takes one
  --<axis> <value>     One matrix axis; give every axis, or none to run all
  --no-interactive     Print plain lines, as when there is no terminal
  -h, --help           Show this help

Exit codes: 0 passed, 1 failed or cancelled, 2 setup error.`;

export interface CliArgs {
  /** The positional target: a pipeline or job ID. */
  name?: string;
  pipeline?: string;
  job?: string;
  event?: string;
  data?: string;
  input?: string;
  /** Matrix axis flags, by axis name. */
  combo: Record<string, string>;
  noInteractive: boolean;
  help: boolean;
}

const options = {
  pipeline: { type: "string" },
  job: { type: "string" },
  event: { type: "string" },
  data: { type: "string" },
  input: { type: "string" },
  "no-interactive": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

/** Parse `argv` (without the node and script paths). */
export const parseCliArgs = (argv: string[]): CliArgs => {
  const known: string[] = [];
  const combo: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    const flag = /^--([^=]+)(?:=(.*))?$/.exec(token);
    const axis = flag?.[1];

    if (!flag || !axis || axis in options) {
      known.push(token);

      continue;
    }

    const value = flag[2] ?? argv[++i];

    if (value === undefined) {
      throw new SetupError(`--${axis} needs a value.`, { fix: usage });
    }

    combo[axis] = value;
  }

  try {
    const { values, positionals } = parseArgs({
      args: known,
      options,
      allowPositionals: true,
    });

    if (positionals.length > 1) {
      throw new Error(`Unexpected argument "${positionals[1]}"`);
    }

    return {
      name: positionals[0],
      pipeline: values.pipeline,
      job: values.job,
      event: values.event,
      data: values.data,
      input: values.input,
      combo,
      noInteractive: values["no-interactive"] ?? false,
      help: values.help ?? false,
    };
  } catch (error) {
    throw new SetupError(errorMessage(error), { fix: usage });
  }
};
