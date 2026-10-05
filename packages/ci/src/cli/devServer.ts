/**
 * The Dev Server the CLI starts for a run: finding its binary, the flags that
 * isolate it, and waiting until it answers.
 *
 * @module
 */

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { CiConfig } from "./config.ts";
import { isHealthy } from "./devServerApi.ts";
import {
  type GroupProcess,
  logTail,
  scrubbedEnv,
  spawnGroup,
} from "./process.ts";
import { SetupError } from "./setupError.ts";

/**
 * The oldest `inngest-cli` that can run this. Sandboxes need a newer Dev
 * Server build than any release so far, so until one ships, use a local build
 * through `INNGEST_CI_DEV_SERVER_BIN`.
 */
export const MIN_DEV_SERVER_VERSION = "1.45.1";

const startTimeoutMs = 30_000;

/** The five ports a Dev Server listens on. */
export interface DevServerPorts {
  main: number;
  connectGateway: number;
  connectGatewayGrpc: number;
  connectExecutorGrpc: number;
  debugApi: number;
}

export interface DevServer {
  /** Where the Dev Server and its UI are, like `http://127.0.0.1:24288`. */
  url: string;
  process: GroupProcess;
}

const parseVersion = (version: string): number[] => {
  return version
    .split("-")[0]!
    .split(".")
    .map((part) => {
      return Number(part);
    });
};

/**
 * Whether `version` is at least the minimum. Dev builds report `dev-…` and
 * always pass, as they're built from source.
 */
export const isSupportedVersion = (
  version: string,
  minimum = MIN_DEV_SERVER_VERSION,
): boolean => {
  if (version.startsWith("dev-")) {
    return true;
  }

  const actual = parseVersion(version);
  const wanted = parseVersion(minimum);

  for (let i = 0; i < wanted.length; i++) {
    const difference = (actual[i] ?? 0) - (wanted[i] ?? 0);

    if (difference !== 0) {
      return difference > 0;
    }
  }

  return true;
};

const installFix =
  "Install it with `npm i -D inngest-cli`, or set INNGEST_CI_DEV_SERVER_BIN to a local Dev Server build.";

/**
 * The Dev Server binary: `INNGEST_CI_DEV_SERVER_BIN`, then `ci.devServer.bin`,
 * then the `inngest-cli` package installed in the project.
 */
export const resolveDevServerBin = (
  config: Pick<CiConfig, "root" | "devServerBin">,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const configured = env.INNGEST_CI_DEV_SERVER_BIN || config.devServerBin;

  if (configured) {
    return configured;
  }

  let packageJson: string;

  try {
    packageJson = createRequire(join(config.root, "package.json")).resolve(
      "inngest-cli/package.json",
    );
  } catch {
    throw new SetupError("Could not find a Dev Server.", {
      fix: installFix,
    });
  }

  const { version } = JSON.parse(readFileSync(packageJson, "utf8")) as {
    version: string;
  };

  if (!isSupportedVersion(version)) {
    throw new SetupError(
      `inngest-cli ${version} is too old. inngest-ci needs ${MIN_DEV_SERVER_VERSION} or newer.`,
      { fix: installFix },
    );
  }

  return join(dirname(packageJson), "bin", "inngest");
};

/** The arguments to `inngest dev` for an isolated Dev Server. */
export const devServerArgs = (opts: {
  ports: DevServerPorts;
  appUrl: string;
  sqliteDir: string;
}): string[] => {
  const { ports } = opts;

  return [
    "dev",
    "--no-discovery",
    "--host",
    "127.0.0.1",
    "--port",
    String(ports.main),
    "--connect-gateway-port",
    String(ports.connectGateway),
    "--connect-gateway-grpc-port",
    String(ports.connectGatewayGrpc),
    "--connect-executor-grpc-port",
    String(ports.connectExecutorGrpc),
    "--debug-api-port",
    String(ports.debugApi),
    "-u",
    opts.appUrl,
    "--persist",
    "--sqlite-dir",
    opts.sqliteDir,
  ];
};

/**
 * Start the Dev Server and wait until it's healthy. Fails fast if it exits.
 */
export const startDevServer = async (opts: {
  config: CiConfig;
  bin: string;
  ports: DevServerPorts;
  appPort: number;
}): Promise<DevServer> => {
  const { config, ports } = opts;
  const url = `http://127.0.0.1:${ports.main}`;
  const sqliteDir = join(config.dir, "dev-server");

  // Every run starts empty. Functions left by an earlier run's app would
  // satisfy the sync wait, and then run against a URL nothing serves.
  rmSync(sqliteDir, { recursive: true, force: true });
  mkdirSync(sqliteDir, { recursive: true });

  const proc = spawnGroup({
    file: opts.bin,
    args: devServerArgs({
      ports,
      appUrl: `http://127.0.0.1:${opts.appPort}${config.path}`,
      sqliteDir,
    }),
    cwd: config.root,
    env: scrubbedEnv(),
    logPath: join(config.dir, "logs", "dev-server.log"),
    pidsPath: join(config.dir, "pids.json"),
  });

  const deadline = Date.now() + startTimeoutMs;

  while (!(await isHealthy(url))) {
    if (proc.hasExited()) {
      throw new SetupError("The Dev Server exited before it was ready.", {
        logTail: await logTail(proc.logPath),
      });
    }

    if (Date.now() > deadline) {
      throw new SetupError("The Dev Server was not ready after 30s.", {
        logTail: await logTail(proc.logPath),
      });
    }

    await sleep(100);
  }

  return { url, process: proc };
};
