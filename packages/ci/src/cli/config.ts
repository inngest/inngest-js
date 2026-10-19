/**
 * Finding the project and reading its `ci` config from `inngest.json`, with
 * the `ci/server.ts` convention as the fallback.
 *
 * @module
 */

import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { errorMessage, git } from "../util.ts";
import { SetupError } from "./setupError.ts";

/** The `ci` key of `inngest.json`, validated and with its defaults applied. */
export interface CiConfig {
  /** The project root: where `inngest.json` is, and where `start` runs. */
  root: string;

  /** The git root, which is what a run uploads to its Sandboxes. */
  gitRoot: string;

  /** The shell command that serves the app. It must listen on `PORT`. */
  start: string;

  /** Where the app serves Inngest, like `/api/inngest`. */
  path: string;
}

export const defaultPath = "/api/inngest";

/** The files the convention looks for, and the command that starts each. */
const conventionServers = [
  { file: "ci/server.ts", start: "tsx ci/server.ts" },
  { file: "ci/server.mts", start: "tsx ci/server.mts" },
  { file: "ci/server.js", start: "node ci/server.js" },
  { file: "ci/server.mjs", start: "node ci/server.mjs" },
];

/** The command that starts the app by convention, if its file exists. */
export const conventionStart = (root: string): string | undefined => {
  return conventionServers.find((server) => {
    return existsSync(join(root, server.file));
  })?.start;
};

/**
 * Nothing says how to start the app: no `ci.start` and no `ci/server.*`. A
 * terminal answers it with guided setup; anything else prints the fix.
 */
export class NoConfigError extends SetupError {
  constructor() {
    super("No command to start your app.", {
      fix: `Add this to inngest.json:\n\n${JSON.stringify({ ci: { start: "tsx server.ts" } }, null, 2)}`,
    });

    this.name = "NoConfigError";
  }
}

/** The git repository's root. */
const findGitRoot = async (cwd: string): Promise<string> => {
  try {
    return realpathSync(
      (await git(cwd, ["rev-parse", "--show-toplevel"])).trim(),
    );
  } catch {
    throw new SetupError("Not inside a git repository.", {
      fix: "Run inngest-ci from your repository.",
    });
  }
};

/**
 * The project root: the nearest directory from `cwd` up to the git root that
 * has an `inngest.json`, else `cwd`. A monorepo's app can sit below the git
 * root with its own `inngest.json`.
 */
const findProjectRoot = (cwd: string, gitRoot: string): string => {
  const start = realpathSync(cwd);

  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "inngest.json"))) {
      return dir;
    }

    if (dir === gitRoot || dirname(dir) === dir) {
      return start;
    }
  }
};

/** The `ci` object of the project's `inngest.json`, `{}` without one. */
export const readCiSection = async (
  root: string,
): Promise<Record<string, unknown>> => {
  const file = join(root, "inngest.json");

  if (!existsSync(file)) {
    return {};
  }

  let ci: unknown;

  try {
    ci = (JSON.parse(await readFile(file, "utf8")) as { ci?: unknown }).ci;
  } catch (error) {
    throw new SetupError(`Could not read ${file}: ${errorMessage(error)}`);
  }

  if (ci === undefined) {
    return {};
  }

  if (typeof ci !== "object" || ci === null || Array.isArray(ci)) {
    throw new SetupError('"ci" in inngest.json must be an object.');
  }

  return ci as Record<string, unknown>;
};

const optionalString = (value: unknown, name: string): string | undefined => {
  if (value !== undefined && (typeof value !== "string" || value === "")) {
    throw new SetupError(
      `"${name}" in inngest.json must be a non-empty string.`,
    );
  }

  return value;
};

/** Read and validate the `ci` config of the project `cwd` is in. */
export const loadConfig = async (cwd: string): Promise<CiConfig> => {
  const gitRoot = await findGitRoot(cwd);
  const root = findProjectRoot(cwd, gitRoot);
  const ci = await readCiSection(root);
  const path = optionalString(ci.path, "ci.path") ?? defaultPath;

  if (!path.startsWith("/")) {
    throw new SetupError('"ci.path" in inngest.json must start with "/".');
  }

  const start = optionalString(ci.start, "ci.start") ?? conventionStart(root);

  if (!start) {
    throw new NoConfigError();
  }

  return { root, gitRoot, start, path };
};
