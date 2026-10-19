/**
 * What a job returns, and what the jobs that start from it are given: its data
 * as `from.output` and its commands as `$from`.
 *
 * @module
 */

import type { CiJobScope, StoredOutputs } from "../pipeline/scope.ts";
import type { Ancestor, AncestorContext, Command } from "../types.ts";
import { type CommandState, commandFromJson } from "./command.ts";

type StoredCommand = { $cmd: CommandState };

const isStoredCommand = (value: unknown): value is StoredCommand => {
  return typeof value === "object" && value !== null && "$cmd" in value;
};

/**
 * What a job returned, as it is stored: JSON, with each command as its state.
 * What the job returned is kept for the jobs that start from it, unless it
 * returned nothing.
 */
export const storeOutput = (
  scope: CiJobScope,
  /** The ID of the job that returned it. */
  id: string,
  /** What the handler returned. */
  returned: unknown,
): Record<string, unknown> | undefined => {
  if (!returned) {
    return undefined;
  }

  const stored = JSON.parse(JSON.stringify(returned)) as Record<
    string,
    unknown
  >;

  if (Object.keys(stored).length > 0) {
    scope.outputs[id] = stored;
  }

  return stored;
};

/** The entries of an output that are data: everything but commands. */
export const dataOf = (
  stored: Record<string, unknown> | undefined,
): Record<string, unknown> => {
  return Object.fromEntries(
    Object.entries(stored ?? {}).filter(([, value]) => {
      return !isStoredCommand(value);
    }),
  );
};

/**
 * What a handler is given of what its ancestors returned. A name that two of
 * them returned has the nearest one's value, whether it is data or a command.
 * Each use of a command in `$from` is a command of its own, so one that is
 * given `.env()` doesn't change another.
 */
export const outputsFrom = (
  getScope: () => CiJobScope,
  /** The parent and the jobs above it, nearest first. */
  ancestry: Ancestor[],
  stored: StoredOutputs,
): {
  output: Record<string, unknown>;
  $from: Record<string, Command>;
  ancestry: AncestorContext[];
} => {
  // Nearest last, so a shared name takes its nearest value.
  const merged = Object.assign(
    {},
    ...[...ancestry].reverse().map((above) => {
      return stored[above.id];
    }),
  ) as Record<string, unknown>;

  const $from: Record<string, Command> = {};

  for (const [name, value] of Object.entries(merged)) {
    if (isStoredCommand(value)) {
      Object.defineProperty($from, name, {
        enumerable: true,
        get: () => {
          return commandFromJson(getScope, value.$cmd);
        },
      });
    }
  }

  return {
    output: dataOf(merged),
    $from,
    ancestry: ancestry.map((above) => {
      return { ...above, output: dataOf(stored[above.id]) };
    }),
  };
};
