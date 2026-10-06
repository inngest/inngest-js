/**
 * Writing what setup decided: the `ci` key of `inngest.json`, which keeps
 * everything else in the file, and `.inngest/` in `.gitignore`.
 *
 * @module
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { git } from "../../util.ts";

const ignored = ".inngest/";

/**
 * `inngest.json`'s text with `ci.start` and `ci.path` set. Every other key,
 * and the other keys of `ci`, stay where they were, and so does the file's
 * indentation (2 spaces for a new file).
 */
export const mergeCiConfig = (
  text: string | undefined,
  ci: { start: string; path: string },
): string => {
  const json = text ? JSON.parse(text) : {};
  const indent = /^([ \t]+)"/m.exec(text ?? "")?.[1] ?? 2;

  return `${JSON.stringify({ ...json, ci: { ...json.ci, ...ci } }, null, indent)}\n`;
};

/** `.gitignore`'s text with `.inngest/` added on a line of its own. */
export const addIgnore = (text: string): string => {
  if (text === "" || text.endsWith("\n")) {
    return `${text}${ignored}\n`;
  }

  return `${text}\n${ignored}\n`;
};

/** Write `ci` into `root`'s `inngest.json`, creating the file if it's missing. */
export const writeCiConfig = async (
  root: string,
  ci: { start: string; path: string },
): Promise<void> => {
  const file = join(root, "inngest.json");
  const text = existsSync(file) ? await readFile(file, "utf8") : undefined;

  await writeFile(file, mergeCiConfig(text, ci));
};

/** Whether git already ignores `.inngest/`, wherever the rule comes from. */
export const isInngestIgnored = async (root: string): Promise<boolean> => {
  try {
    await git(root, ["check-ignore", "--quiet", `${ignored}x`]);

    return true;
  } catch {
    return false;
  }
};

/** Add `.inngest/` to `root`'s `.gitignore`, creating the file if it's missing. */
export const ignoreInngest = async (root: string): Promise<void> => {
  const file = join(root, ".gitignore");
  const text = existsSync(file) ? await readFile(file, "utf8") : "";

  await writeFile(file, addIgnore(text));
};
