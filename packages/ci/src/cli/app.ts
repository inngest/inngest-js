/**
 * The user's app: starting it with the env the CLI sets, and waiting until the
 * Dev Server has synced it and it has reported its manifest.
 *
 * @module
 */

import { delimiter, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { LocalManifest } from "../local/protocol.ts";
import { localEnv, runJobFunctionId } from "../local/protocol.ts";
import { errorMessage } from "../util.ts";
import type { CiConfig } from "./config.ts";
import { listFunctionIds } from "./devServer.ts";
import type { ManagedProcess } from "./processes.ts";
import { logTail, scrubbedEnv, startProcess } from "./processes.ts";
import { SetupError } from "./setupError.ts";

const syncTimeoutMs = 30_000;

/**
 * The `node_modules/.bin` of `root` and of every directory above it up to
 * `stopAt`, nearest first, as npm scripts get them.
 */
const binDirs = (root: string, stopAt: string): string[] => {
  const dirs: string[] = [];

  for (let dir = root; ; dir = dirname(dir)) {
    dirs.push(join(dir, "node_modules", ".bin"));

    if (dir === stopAt || dirname(dir) === dir) {
      return dirs;
    }
  }
};

/**
 * Start the app with its `start` command, listening on `port`. Its `PATH` has
 * the project's `node_modules/.bin` first, so `start` can name a local tool
 * like `tsx` however `inngest-ci` was run.
 */
export const startApp = (opts: {
  config: CiConfig;
  port: number;
  devServerUrl: string;
  reporterUrl: string;
  logPath: string;
}): ManagedProcess => {
  const { config } = opts;

  return startProcess({
    command: config.start,
    cwd: config.root,
    env: scrubbedEnv({
      PATH: [
        ...binDirs(config.root, config.gitRoot),
        process.env.PATH ?? "",
      ].join(delimiter),
      PORT: String(opts.port),
      INNGEST_DEV: "1",
      INNGEST_BASE_URL: opts.devServerUrl,
      [localEnv.local]: "1",
      [localEnv.reporterUrl]: opts.reporterUrl,
    }),
    logPath: opts.logPath,
  });
};

/**
 * Whether the Dev Server has synced the app. Throws if it has synced
 * functions but not the run-job function, because the app then isn't serving
 * `ci.functions()`.
 */
const hasSynced = async (devServerUrl: string): Promise<boolean> => {
  const ids = await listFunctionIds(devServerUrl);

  if (ids.length === 0) {
    return false;
  }

  if (
    !ids.some((id) => {
      return id.endsWith(`-${runJobFunctionId}`);
    })
  ) {
    throw new SetupError(
      "The app synced, but doesn't serve `ci.functions()`.",
      {
        fix: "Serve them with `serve({ client, functions: ci.functions() })`.",
      },
    );
  }

  return true;
};

/**
 * Wait until the Dev Server has synced the app's run-job function and the app
 * has reported its manifest. Fails if the app exits or the wait times out.
 */
export const waitForSync = async (opts: {
  devServerUrl: string;
  app: ManagedProcess;
  manifest: Promise<LocalManifest>;
}): Promise<LocalManifest> => {
  const deadline = Date.now() + syncTimeoutMs;
  let manifest: LocalManifest | undefined;
  let synced = false;
  let lastError = "";

  void opts.manifest.then((value) => {
    manifest = value;
  });

  while (!(synced && manifest)) {
    if (opts.app.hasExited()) {
      throw new SetupError("The app exited before it was ready.", {
        logTail: logTail(opts.app.logPath),
      });
    }

    if (Date.now() > deadline) {
      throw new SetupError(
        `The app was not ready after 30s${lastError ? ` (last error: ${lastError})` : ""}.`,
        {
          fix: "Check that `start` listens on PORT and serves the Inngest endpoint at `path`.",
          logTail: logTail(opts.app.logPath),
        },
      );
    }

    if (!synced) {
      try {
        synced = await hasSynced(opts.devServerUrl);
      } catch (error) {
        if (error instanceof SetupError) {
          throw error;
        }

        lastError = errorMessage(error);
      }
    }

    await sleep(100);
  }

  return manifest;
};
