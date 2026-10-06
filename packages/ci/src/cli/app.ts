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
import { listFunctionSlugs } from "./devServerApi.ts";
import {
  type GroupProcess,
  logTail,
  scrubbedEnv,
  spawnGroup,
} from "./process.ts";
import { SetupError } from "./setupError.ts";

const syncTimeoutMs = 30_000;

/**
 * The `node_modules/.bin` of `root` and of every directory above it up to
 * `stopAt`, nearest first, as npm scripts get them.
 */
export const binDirs = (root: string, stopAt: string): string[] => {
  const dirs: string[] = [];

  for (let dir = root; ; dir = dirname(dir)) {
    dirs.push(join(dir, "node_modules", ".bin"));

    if (dir === stopAt || dirname(dir) === dir) {
      return dirs;
    }
  }
};

/**
 * Start the app with `sh -c <start>`, listening on `port`. Its `PATH` has the
 * project's `node_modules/.bin` first, so `start` can name a local tool like
 * `tsx` however `inngest-ci` was run.
 */
export const startApp = (opts: {
  config: CiConfig;
  /** The git root, where the search for `node_modules/.bin` stops. */
  gitRoot: string;
  port: number;
  devServerUrl: string;
  reporterUrl: string;
}): GroupProcess => {
  return spawnGroup({
    file: "sh",
    args: ["-c", opts.config.start],
    cwd: opts.config.root,
    env: scrubbedEnv({
      PATH: [
        ...binDirs(opts.config.root, opts.gitRoot),
        process.env.PATH ?? "",
      ].join(delimiter),
      PORT: String(opts.port),
      INNGEST_DEV: "1",
      INNGEST_BASE_URL: opts.devServerUrl,
      [localEnv.local]: "1",
      [localEnv.reporterUrl]: opts.reporterUrl,
    }),
    logPath: join(opts.config.dir, "logs", "app.log"),
    pidsPath: join(opts.config.dir, "pids.json"),
  });
};

/**
 * Whether the Dev Server has synced the app. Throws if it has synced
 * functions but not the run-job function, because the app then isn't serving
 * `ci.functions()`.
 */
const hasSynced = async (devServerUrl: string): Promise<boolean> => {
  const slugs = await listFunctionSlugs(devServerUrl);

  if (slugs.length === 0) {
    return false;
  }

  if (
    !slugs.some((slug) => {
      return slug.endsWith(`-${runJobFunctionId}`);
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
  app: GroupProcess;
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
        logTail: await logTail(opts.app.logPath),
      });
    }

    if (Date.now() > deadline) {
      throw new SetupError(
        `The app was not ready after 30s${lastError ? ` (last error: ${lastError})` : ""}.`,
        {
          fix: "Check that `start` listens on PORT and serves the Inngest endpoint at `path`.",
          logTail: await logTail(opts.app.logPath),
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
