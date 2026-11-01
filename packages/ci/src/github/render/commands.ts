/**
 * The commands table: one row for each command that has started or finished.
 * A command that has not started has no row, so there is never a step count.
 *
 * @module
 */

import { formatDuration } from "../../util.ts";

/** What a listed command is doing. A command that has not started is never listed. */
export type CommandRowState = "done" | "running" | "failed" | "stopped";

export interface CommandRow {
  state: CommandRowState;
  /** The command as it reads, such as `pnpm test`. */
  command: string;
  /** How long it ran, when known. */
  ms?: number;
}

const icons: Record<CommandRowState, string> = {
  done: "✅",
  failed: "❌",
  running: "🔄",
  stopped: "🛑",
};

const squares: Record<CommandRowState, string> = {
  done: "🟩",
  failed: "🟥",
  running: "🟦",
  stopped: "🟨",
};

/** A bar `width` squares wide with `fraction` of it coloured. */
export const colorBar = (
  fraction: number,
  color: string,
  width: number,
): string => {
  const filled = Math.min(width, Math.max(1, Math.round(fraction * width)));

  return color.repeat(filled) + "⬜".repeat(width - filled);
};

const timeOf = (row: CommandRow): string => {
  if (row.ms === undefined) {
    return "";
  }

  const time = formatDuration(row.ms);

  if (row.state === "running") {
    return `${time} so far`;
  }

  return row.state === "stopped" ? `${time} when stopped` : time;
};

/** A command as one table cell: one line, with no pipes to split the row. */
const cell = (command: string): string => {
  return command
    .replaceAll("`", "'")
    .replace(/\s*\r?\n\s*/g, " ")
    .replaceAll("|", "\\|");
};

/** The table, or an empty string when no command has started. */
export const commandsTable = (rows: CommandRow[]): string => {
  if (rows.length === 0) {
    return "";
  }

  const longest = Math.max(0, ...rows.map((row) => row.ms ?? 0));

  const lines = rows.map((row) => {
    const bar =
      row.ms === undefined
        ? ""
        : colorBar(longest > 0 ? row.ms / longest : 1, squares[row.state], 8);

    return `| ${icons[row.state]} | \`${cell(row.command)}\` | ${timeOf(row)} | ${bar} |`;
  });

  return ["| | Command | Time | |", "| --- | --- | --- | --- |", ...lines].join(
    "\n",
  );
};
