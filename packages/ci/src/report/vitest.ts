/**
 * Reading the JSON that vitest and jest write (`--reporter=json`, `--json`):
 * failed tests, snapshot mismatches and tests that passed only after a retry.
 *
 * @module
 */

import { stripAnsi } from "../util.ts";
import { type Found, isRecord } from "./found.ts";

const text = (value: unknown): string => {
  return typeof value === "string" ? value : "";
};

/** The first line in a stack that points into `file`, as `file:line`. */
const lineIn = (file: string, messages: string[]): number | undefined => {
  const base = file.split("/").at(-1) ?? file;
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}:(\\d+)(?::\\d+)?`).exec(
    stripAnsi(messages.join("\n")),
  );

  return match ? Number(match[1]) : undefined;
};

/** The problems in a test run's JSON. Anything else gives nothing. */
export const parseTestResults = (json: unknown): Found[] => {
  const files = isRecord(json) ? json.testResults : undefined;

  if (!Array.isArray(files)) {
    return [];
  }

  const found: Found[] = [];

  for (const result of files) {
    if (!isRecord(result)) {
      continue;
    }

    const file = text(result.name) || text(result.testFilePath);
    const tests = Array.isArray(result.assertionResults)
      ? result.assertionResults
      : [];

    if (result.status === "failed" && tests.length === 0 && file) {
      found.push({
        tool: "vitest",
        file,
        line: 1,
        level: "failure",
        title: "Test file failed to run",
        message: stripAnsi(text(result.message)).split("\n")[0] ?? "",
        details: stripAnsi(text(result.message)).slice(0, 2000),
      });
    }

    for (const test of tests) {
      if (!isRecord(test) || !file) {
        continue;
      }

      const title = text(test.fullName) || text(test.title);
      const messages = Array.isArray(test.failureMessages)
        ? test.failureMessages.map(text)
        : [];
      const where = isRecord(test.location) ? Number(test.location.line) : NaN;
      const line = Number.isFinite(where) ? where : lineIn(file, messages);
      const retries = Number(test.retryCount ?? 0);

      if (test.status === "failed") {
        const message = stripAnsi(messages[0] ?? "").trim();
        const snapshot = /snapshot/i.test(message);

        found.push({
          tool: "vitest",
          file,
          line: line ?? 1,
          level: "failure",
          title: snapshot ? `Snapshot mismatch: ${title}` : title,
          message: message.split("\n")[0] ?? "",
          details: message.slice(0, 2000),
        });
      } else if (test.status === "passed" && retries > 0) {
        found.push({
          tool: "vitest",
          file,
          line: line ?? 1,
          level: "warning",
          title: `Flaky: ${title}`,
          message: `Passed after ${retries} ${retries === 1 ? "retry" : "retries"}.`,
        });
      }
    }
  }

  return found;
};
