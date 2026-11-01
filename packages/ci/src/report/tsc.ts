/**
 * Reading `tsc --pretty false` output: one line to a problem, with indented
 * lines below it that continue the message.
 *
 * @module
 */

import { stripAnsi } from "../util.ts";
import type { Found } from "./found.ts";

const diagnostic = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;

/** The problems in tsc's output. Output with none gives nothing. */
export const parseTsc = (text: string): Found[] => {
  const found: Found[] = [];

  for (const line of stripAnsi(text).split("\n")) {
    const match = diagnostic.exec(line);

    if (match) {
      found.push({
        tool: "tsc",
        file: match[1] ?? "",
        line: Number(match[2]),
        level: match[4] === "warning" ? "warning" : "failure",
        rule: match[5] ?? "",
        title: `tsc ${match[5]}`,
        message: match[6] ?? "",
      });

      continue;
    }

    const last = found.at(-1);

    if (last && /^\s{2,}\S/.test(line)) {
      last.message = `${last.message}\n${line.trim()}`;
    }
  }

  return found;
};
