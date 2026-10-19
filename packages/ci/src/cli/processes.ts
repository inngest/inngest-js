/**
 * Running the Dev Server and the app as child processes with their output in a
 * log file, and stopping the whole tree they start.
 *
 * @module
 */

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import freePort from "get-port";
import treeKill from "tree-kill";

const kill = (pid: number, signal: NodeJS.Signals): Promise<void> => {
  return new Promise((resolve) => {
    treeKill(pid, signal, () => {
      resolve();
    });
  });
};

/** How long a process may take to stop before it is killed. */
const graceMs = 5000;

export interface ManagedProcess {
  readonly logPath: string;

  /** Whether the process has exited. */
  hasExited(): boolean;

  /** `SIGTERM` the process and its children, then `SIGKILL` what is left. */
  stop(): Promise<void>;
}

/**
 * The environment a child runs in: ours without `INNGEST_*`, so a key from the
 * user's shell can't leak into the local Dev Server, plus `extra`.
 */
export const scrubbedEnv = (
  extra: Record<string, string> = {},
): Record<string, string> => {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("INNGEST_")) {
      env[key] = value;
    }
  }

  return { ...env, ...extra };
};

/** `count` distinct free ports on loopback. */
export const freePorts = async (count: number): Promise<number[]> => {
  const ports: number[] = [];

  for (let i = 0; i < count; i++) {
    ports.push(await freePort({ host: "127.0.0.1", exclude: ports }));
  }

  return ports;
};

/**
 * Start `command`, through a shell when `args` is left out, with stdout and
 * stderr going to `logPath`. It leads its own process group, so a Ctrl-C in
 * the terminal doesn't reach it before the CLI has cleaned up.
 */
export const startProcess = (opts: {
  command: string;
  args?: string[];
  cwd: string;
  env: Record<string, string>;
  logPath: string;
}): ManagedProcess => {
  mkdirSync(dirname(opts.logPath), { recursive: true });

  const log = openSync(opts.logPath, "w");

  const child = spawn(opts.command, opts.args ?? [], {
    cwd: opts.cwd,
    env: opts.env,
    shell: !opts.args,
    detached: process.platform !== "win32",
    stdio: ["ignore", log, log],
  });

  closeSync(log);

  let exited = false;

  const done = new Promise<void>((resolve) => {
    child.once("exit", () => {
      exited = true;

      resolve();
    });

    child.once("error", () => {
      exited = true;

      resolve();
    });
  });

  return {
    logPath: opts.logPath,
    hasExited: () => {
      return exited;
    },
    stop: async () => {
      if (exited || !child.pid) {
        return;
      }

      await kill(child.pid, "SIGTERM");

      const timeout = new Promise<void>((resolve) => {
        setTimeout(resolve, graceMs).unref();
      });

      await Promise.race([done, timeout]);

      if (!exited) {
        await kill(child.pid, "SIGKILL");
      }
    },
  };
};

/** The last `lines` lines of a log, or an empty string if it can't be read. */
export const logTail = (path: string, lines = 20): string => {
  try {
    return readFileSync(path, "utf8")
      .trimEnd()
      .split("\n")
      .slice(-lines)
      .join("\n");
  } catch {
    return "";
  }
};
