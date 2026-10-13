/**
 * The Dev Server the CLI starts for a run: finding its binary, the flags that
 * isolate it, and waiting until it answers.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  /** Where its database is. */
  dir: string;
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
  "Install it with `npm i -D inngest-cli` or globally with `npm i -g inngest-cli`, or set INNGEST_CI_DEV_SERVER_BIN to a Dev Server build.";

/**
 * The first executable called `name` on `PATH`, searched by hand so no `which`
 * is needed. On Windows each `PATHEXT` extension is tried too.
 */
export const findOnPath = (
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined => {
  const windows = platform === "win32";
  const dirs = (env.PATH ?? "").split(windows ? ";" : ":").filter(Boolean);
  const extensions = windows
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];

  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = join(dir, name + extension);

      try {
        accessSync(candidate, windows ? constants.F_OK : constants.X_OK);

        if (statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // Not here; keep looking.
      }
    }
  }

  return undefined;
};

/**
 * The `package.json` of `name` installed in the project: `node_modules/<name>`
 * in `root` or a folder above it. Looked up by hand rather than with
 * `require.resolve`, which also searches `NODE_PATH` and would find a copy
 * that package managers' bin shims put there from outside the project.
 */
const findProjectPackage = (root: string, name: string): string | undefined => {
  let dir = resolve(root);

  for (;;) {
    const candidate = join(dir, "node_modules", name, "package.json");

    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Not here; keep looking up.
    }

    const parent = dirname(dir);

    if (parent === dir) {
      return undefined;
    }

    dir = parent;
  }
};

/** What `<bin> --version` reports, like `1.45.1` or `dev-abc`, if it runs. */
const binaryVersion = (bin: string): string | undefined => {
  try {
    const output = execFileSync(bin, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
    });

    return output.match(/\b(dev-\S*|\d+\.\d+\.\d+\S*)/)?.[1];
  } catch {
    return undefined;
  }
};

/** What the resolution reads from the machine, injectable for tests. */
export interface ResolveDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** The version a binary reports, or undefined when it can't be told. */
  versionOf(bin: string): string | undefined;
}

/**
 * The Dev Server binary, from the first of these that exists:
 * `INNGEST_CI_DEV_SERVER_BIN`, `ci.devServer.bin`, the `inngest-cli` package
 * installed in the project, then `inngest-cli` and `inngest` on `PATH`. Every
 * source is held to the minimum version; dev builds always pass, and a binary
 * that won't say its version is trusted.
 */
export const resolveDevServerBin = (
  config: Pick<CiConfig, "root" | "devServerBin">,
  deps: Partial<ResolveDeps> = {},
): string => {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const versionOf = deps.versionOf ?? binaryVersion;
  let bin = env.INNGEST_CI_DEV_SERVER_BIN || config.devServerBin;
  let version: string | undefined;

  if (!bin) {
    const packageJson = findProjectPackage(config.root, "inngest-cli");

    if (packageJson) {
      try {
        version = (
          JSON.parse(readFileSync(packageJson, "utf8")) as { version: string }
        ).version;

        bin = join(dirname(packageJson), "bin", "inngest");
      } catch {
        // Unreadable; try the machine.
      }
    }
  }

  bin ??=
    findOnPath("inngest-cli", env, platform) ??
    findOnPath("inngest", env, platform);

  if (!bin) {
    throw new SetupError(
      "Could not find a Dev Server: none is configured, installed in the project or on PATH.",
      { fix: installFix },
    );
  }

  version ??= versionOf(bin);

  if (version && !isSupportedVersion(version)) {
    throw new SetupError(
      `inngest-cli ${version} is too old. inngest-ci needs ${MIN_DEV_SERVER_VERSION} or newer.`,
      { fix: installFix },
    );
  }

  return bin;
};

/** The arguments to `inngest dev` for an isolated Dev Server. */
export const devServerArgs = (opts: {
  ports: DevServerPorts;
  /** The app to sync, if there is one. */
  appUrl?: string;
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
    ...(opts.appUrl ? ["-u", opts.appUrl] : []),
    "--persist",
    "--sqlite-dir",
    opts.sqliteDir,
  ];
};

/**
 * Where a session keeps its Dev Server's database. Every session has its own,
 * because two Dev Servers can't share one, and a new one has no functions
 * left by an earlier run's app.
 */
export const devServerDir = (dir: string, sessionId: string): string => {
  return join(dir, "dev-server", sessionId);
};

/**
 * Start the Dev Server on the database in `sqliteDir` and wait until it's
 * healthy. Fails fast if it exits.
 */
export const startDevServer = async (opts: {
  config: CiConfig;
  bin: string;
  sqliteDir: string;
  ports: DevServerPorts;
  /** The port of the app to sync, if the Dev Server has one. */
  appPort?: number;
}): Promise<DevServer> => {
  const { config, ports, sqliteDir } = opts;
  const url = `http://127.0.0.1:${ports.main}`;

  mkdirSync(sqliteDir, { recursive: true });

  const proc = spawnGroup({
    file: opts.bin,
    args: devServerArgs({
      ports,
      appUrl: opts.appPort
        ? `http://127.0.0.1:${opts.appPort}${config.path}`
        : undefined,
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

  return { url, dir: sqliteDir, process: proc };
};
