/**
 * Reading `eslint -f json`: one entry per file with its messages.
 *
 * @module
 */

import { type Found, isRecord } from "./found.ts";

/** The problems in eslint's JSON. Anything else gives nothing. */
export const parseEslint = (json: unknown): Found[] => {
  if (!Array.isArray(json)) {
    return [];
  }

  const found: Found[] = [];

  for (const file of json) {
    if (!isRecord(file) || typeof file.filePath !== "string") {
      continue;
    }

    for (const message of Array.isArray(file.messages) ? file.messages : []) {
      if (!isRecord(message) || typeof message.message !== "string") {
        continue;
      }

      const rule = typeof message.ruleId === "string" ? message.ruleId : "";
      const endLine = Number(message.endLine);

      found.push({
        tool: "eslint",
        file: file.filePath,
        line: Number(message.line) || 1,
        ...(Number.isFinite(endLine) && endLine > 0 ? { endLine } : {}),
        level: message.severity === 2 ? "failure" : "warning",
        ...(rule ? { rule } : {}),
        title: rule ? `eslint ${rule}` : "eslint",
        message: message.message,
        ...(rule && !rule.includes("/")
          ? { details: `https://eslint.org/docs/latest/rules/${rule}` }
          : {}),
      });
    }
  }

  return found;
};
