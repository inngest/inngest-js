/**
 * What a job returns, and what the jobs that start from it are given: its data
 * as `from.output` and its commands as `from.$`.
 *
 * @module
 */

import { CiUsageError } from "../errors.ts";
import type {
  CiJobScope,
  StoredOutput,
  StoredOutputs,
} from "../pipeline/scope.ts";
import type { Ancestor, AncestorContext, Command } from "../types.ts";
import {
  type CommandState,
  commandFromJson,
  isCommand,
  stateOfCommand,
} from "./command.ts";

/**
 * Where a job's output is kept: its place in the chain, which is how many jobs
 * are above it, and its ID. The place keeps two jobs with the same ID apart, as
 * when one app's `build` starts from another app's `build`.
 */
const outputKey = (id: string, above: Ancestor[]): string => {
  return `${above.length}:${id}`;
};

/**
 * What a job returned, as it is stored: its data as JSON, and each command as
 * its state. What the job returned is kept for the jobs that start from it,
 * unless it returned nothing.
 *
 * Returns the data, which is what the job gives to a caller.
 */
export const storeOutput = (
  scope: CiJobScope,
  /** The ID of the job that returned it. */
  id: string,
  /** The jobs above it, nearest first. */
  above: Ancestor[],
  /** What the handler returned. */
  returned: unknown,
): Record<string, unknown> | undefined => {
  if (!returned) {
    return undefined;
  }

  const data: Record<string, unknown> = {};
  const commands: Record<string, CommandState> = {};

  for (const [name, value] of Object.entries(returned)) {
    if (!isCommand(value)) {
      data[name] = value;

      continue;
    }

    const state = stateOfCommand(value);

    if (state.onTimeout) {
      throw new CiUsageError(
        `The command returned as "${name}" has an \`onTimeout\` callback, which can't be kept for the jobs that start from this one. Remove it, or run the command in the job.`,
      );
    }

    commands[name] = state;
  }

  const stored: StoredOutput = {
    data: JSON.parse(JSON.stringify(data)),
    commands,
  };

  if (
    Object.keys(stored.data).length > 0 ||
    Object.keys(stored.commands).length > 0
  ) {
    scope.outputs[outputKey(id, above)] = stored;
  }

  return stored.data;
};

/** The commands of an output, each made again on every read. */
const commandsIn = (
  getScope: () => CiJobScope,
  commands: Record<string, CommandState>,
): Record<string, Command> => {
  const made: Record<string, Command> = {};

  for (const [name, state] of Object.entries(commands)) {
    Object.defineProperty(made, name, {
      enumerable: true,
      get: () => {
        return commandFromJson(getScope, state);
      },
    });
  }

  return made;
};

/**
 * What a handler is given of what its ancestors returned. A name that two of
 * them returned has the nearest one's value, whether it is data or a command.
 * Each use of a command in `$` is a command of its own, so one that is given
 * `.env()` doesn't change another.
 */
export const outputsFrom = (
  getScope: () => CiJobScope,
  /** The parent and the jobs above it, nearest first. */
  ancestry: Ancestor[],
  stored: StoredOutputs,
): {
  output: Record<string, unknown>;
  $: Record<string, Command>;
  ancestry: AncestorContext[];
} => {
  const storedFor = (index: number): StoredOutput => {
    return (
      stored[outputKey(ancestry[index]!.id, ancestry.slice(index + 1))] ?? {
        data: {},
        commands: {},
      }
    );
  };

  const data: Record<string, unknown> = {};
  const commands: Record<string, CommandState> = {};

  // Farthest first, so a shared name takes its nearest value.
  for (let index = ancestry.length - 1; index >= 0; index--) {
    const above = storedFor(index);

    for (const name of [
      ...Object.keys(above.data),
      ...Object.keys(above.commands),
    ]) {
      delete data[name];

      delete commands[name];
    }

    Object.assign(data, above.data);

    Object.assign(commands, above.commands);
  }

  return {
    output: data,
    $: commandsIn(getScope, commands),
    ancestry: ancestry.map((above, index) => {
      return {
        ...above,
        output: storedFor(index).data,
        $: commandsIn(getScope, storedFor(index).commands),
      };
    }),
  };
};
