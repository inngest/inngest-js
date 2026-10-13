/**
 * Finding the project and reading its `ci` config from `inngest.json`, with
 * the `ci/server.ts` convention as the fallback.
 *
 * @module
 */

import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { errorMessage, git } from "../util.ts";
import { SetupError } from "./setupError.ts";

/** The `ci` key of `inngest.json`, validated and with its defaults applied. */
export interface CiConfig {
  /** The project root: where `inngest.json` is, and where `start` runs. */
  root: string;
  /** The shell command that serves the app. It must listen on `PORT`. */
  start: string;
  /** Where the app serves Inngest, like `/api/inngest`. */
  path: string;
  /** Absolute directory for logs and the Dev Server's database. */
  dir: string;
  /** A Dev Server binary to use instead of the `inngest-cli` package or a global install. */
  devServerBin?: string;
}

/** The files the convention looks for, and the command that starts each. */
const conventionServers = [
  { file: "ci/server.ts", start: "tsx ci/server.ts" },
  { file: "ci/server.mts", start: "tsx ci/server.mts" },
  { file: "ci/server.js", start: "node ci/server.js" },
  { file: "ci/server.mjs", start: "node ci/server.mjs" },
];

const startFix = (start: string): string => {
  return `Add this to inngest.json:\n\n${JSON.stringify({ ci: { start } }, null, 2)}`;
};

/**
 * Nothing says how to start the app: no `ci.start` and no `ci/server.*`.
 * Guided setup, or the error that stands in for it, answers this.
 */
export class NoConfigError extends SetupError {
  constructor() {
    super("No command to start your app.", { fix: startFix("tsx server.ts") });

    this.name = "NoConfigError";
  }
}

/**
 * `from` and each directory above it, nearest first, up to and including
 * `to`, or the filesystem root if `to` isn't above.
 */
export const ancestors = (from: string, to: string): string[] => {
  const dirs: string[] = [];

  for (let dir = from; ; dir = dirname(dir)) {
    dirs.push(dir);

    if (dir === to || dirname(dir) === dir) {
      return dirs;
    }
  }
};

/**
 * The git repository's root, which is what a run uploads to its Sandboxes.
 */
export const findGitRoot = async (cwd: string): Promise<string> => {
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
export const findProjectRoot = async (cwd: string): Promise<string> => {
  const gitRoot = await findGitRoot(cwd);
  const start = realpathSync(cwd);
  let dir = start;

  while (true) {
    if (existsSync(join(dir, "inngest.json"))) {
      return dir;
    }

    if (dir === gitRoot || dirname(dir) === dir) {
      return start;
    }

    dir = dirname(dir);
  }
};

const readCiSection = async (
  root: string,
): Promise<Record<string, unknown>> => {
  const file = join(root, "inngest.json");

  if (!existsSync(file)) {
    return {};
  }

  let json: unknown;

  try {
    json = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new SetupError(`Could not read ${file}: ${errorMessage(error)}`);
  }

  const ci = (json as { ci?: unknown } | null)?.ci;

  if (ci === undefined) {
    return {};
  }

  if (typeof ci !== "object" || ci === null || Array.isArray(ci)) {
    throw new SetupError('"ci" in inngest.json must be an object.');
  }

  return ci as Record<string, unknown>;
};

const optionalString = (value: unknown, name: string): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string" || value === "") {
    throw new SetupError(
      `"${name}" in inngest.json must be a non-empty string.`,
    );
  }

  return value;
};

/**
 * Read and validate the `ci` config for the project at `root`. Unknown keys
 * are allowed.
 */
export const loadConfig = async (root: string): Promise<CiConfig> => {
  const ci = await readCiSection(root);
  const devServer = ci.devServer;

  if (
    devServer !== undefined &&
    (typeof devServer !== "object" || devServer === null)
  ) {
    throw new SetupError('"ci.devServer" in inngest.json must be an object.');
  }

  const path = optionalString(ci.path, "ci.path") ?? "/api/inngest";

  if (!path.startsWith("/")) {
    throw new SetupError('"ci.path" in inngest.json must start with "/".');
  }

  const start =
    optionalString(ci.start, "ci.start") ??
    conventionServers.find((server) => {
      return existsSync(join(root, server.file));
    })?.start;

  if (!start) {
    throw new NoConfigError();
  }

  return {
    root,
    start,
    path,
    dir: resolve(root, optionalString(ci.dir, "ci.dir") ?? ".inngest/ci"),
    devServerBin: optionalString(
      (devServer as Record<string, unknown> | undefined)?.bin,
      "ci.devServer.bin",
    ),
  };
};
