/**
 * The `inngest-ci` bin: parses the command line, runs once and exits with its
 * code. tsdown adds the shebang when it bundles this file.
 *
 * @module
 */

import { defineCommand, runMain } from "citty";

import { runOnce } from "./run.ts";

/** Options that aren't matrix axes. Anything else given as `--<name>` is one. */
const knownFlags = new Set([
  "_",
  "event",
  "data",
  "input",
  "interactive",
  "help",
  "h",
]);

const command = defineCommand({
  meta: {
    name: "inngest-ci",
    description:
      "Run a pipeline, job or matrix of your app locally, on Sandboxes, with a Dev Server of its own.",
  },
  args: {
    target: {
      type: "positional",
      required: false,
      description:
        "The pipeline, job or matrix to run. Asked for at a terminal.",
    },
    event: {
      type: "string",
      description:
        "The trigger to run a pipeline with, like pull_request.opened.",
    },
    data: {
      type: "string",
      description: "JSON for the data of a manual or comment trigger.",
    },
    input: {
      type: "string",
      description: "JSON for the input of a job.",
    },
    interactive: {
      type: "boolean",
      default: true,
      description:
        "Ask for what is missing at a terminal. --no-interactive turns it off.",
    },
  },
  run: async ({ args, rawArgs }) => {
    const abort = new AbortController();

    const stop = (): void => {
      // A second Ctrl-C leaves without waiting for cleanup.
      if (abort.signal.aborted) {
        process.exit(130);
      }

      abort.abort();
    };

    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);

    const axes: Record<string, string[]> = {};

    for (const [name, value] of Object.entries(args)) {
      if (
        !knownFlags.has(name) &&
        name !== "target" &&
        rawArgs.includes(`--${name}`)
      ) {
        axes[name] = [value].flat().map(String);
      }
    }

    process.exitCode = await runOnce(
      {
        cwd: process.cwd(),
        target: args.target,
        event: args.event,
        data: args.data,
        input: args.input,
        axes,
        interactive: Boolean(process.stdout.isTTY) && args.interactive,
      },
      abort.signal,
    );
  },
});

await runMain(command);
