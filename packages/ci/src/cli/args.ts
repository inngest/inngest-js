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

export const usage = `Usage: inngest-ci [pipeline|job] [options]
       inngest-ci open [runId]

Run a pipeline or a job of your app locally, on Sandboxes. Without a target, a
terminal shows a picker.

\`open\` shows a run of an earlier session in the Dev Server's UI: the latest
one, or the given one.

Options:
  --pipeline <id>      Run this pipeline, when a job has the same name
  --job <id>           Run this job, when a pipeline has the same name
  --event <name>       The trigger to run a pipeline with, when it has several
  --data <json>        The event data for a manual or comment trigger
  --input <json>       The input of a job that takes one
  --fixture <name>     Use the data saved under this name, from an earlier run
  --<axis> <value>     One matrix axis; give every axis, or none to run all
  --no-interactive     Print plain lines, as when there is no terminal
  -h, --help           Show this help

Exit codes: 0 passed, 1 failed or cancelled, 2 setup error.`;

export interface CliArgs {
  /** `open` shows a run; anything else runs a target. */
  command: "run" | "open";
  /** For `open`: the run to show, or the latest. */
  runId?: string;
  /** The positional target: a pipeline or job ID. */
  name?: string;
  pipeline?: string;
  job?: string;
  event?: string;
  data?: string;
  input?: string;
  fixture?: string;
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
  fixture: { type: "string" },
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

    const open = positionals[0] === "open";
    const extra = positionals[open ? 2 : 1];

    if (extra) {
      throw new Error(`Unexpected argument "${extra}"`);
    }

    return {
      command: open ? "open" : "run",
      runId: open ? positionals[1] : undefined,
      name: open ? undefined : positionals[0],
      pipeline: values.pipeline,
      job: values.job,
      event: values.event,
      data: values.data,
      input: values.input,
      fixture: values.fixture,
      combo,
      noInteractive: values["no-interactive"] ?? false,
      help: values.help ?? false,
    };
  } catch (error) {
    throw new SetupError(errorMessage(error), { fix: usage });
  }
};
