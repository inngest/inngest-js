/**
 * Running the Dev Server and the app as process groups: spawning one with its
 * output going to a log file, stopping the whole group, reaping groups a
 * killed CLI left behind, and reading a log's tail for error messages.
 *
 * @module
 */

import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { errorMessage } from "../util.ts";

/** A process that leads its own group, so stopping it stops its children. */
export interface GroupProcess {
  /** The group's ID: the leader's PID. */
  readonly pid: number;
  readonly logPath: string;
  /** Whether the leader has exited. */
  hasExited(): boolean;
}

/**
 * The environment a child runs in: ours without `INNGEST_*`, so a key from the
 * user's shell can't leak into the local Dev Server, plus `extra`.
 */
export const scrubbedEnv = (
  extra: Record<string, string> = {},
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> => {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !key.startsWith("INNGEST_")) {
      env[key] = value;
    }
  }

  return { ...env, ...extra };
};

/** A group a CLI started, as written to the pids file. */
interface RecordedGroup {
  pid: number;
  /** The leader's start time, so a reused PID isn't mistaken for it. */
  startedAt: string;
  /** The CLI that started it. While that is alive, the group isn't stale. */
  owner: number;
}

/** When a process started, or `undefined` if there is no such process. */
const startTime = (pid: number): string | undefined => {
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
};

const readRecorded = (pidsPath: string): RecordedGroup[] => {
  try {
    return JSON.parse(readFileSync(pidsPath, "utf8")) as RecordedGroup[];
  } catch {
    return [];
  }
};

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Stop the groups an earlier CLI left running because it was killed before it
 * could clean up. Groups of a CLI that's still running are left alone.
 */
export const reapStaleGroups = async (pidsPath: string): Promise<void> => {
  const kept: RecordedGroup[] = [];

  for (const group of readRecorded(pidsPath)) {
    if (group.owner !== process.pid && processAlive(group.owner)) {
      kept.push(group);
    } else if (startTime(group.pid) === group.startedAt) {
      await stopGroup(group);
    }
  }

  if (kept.length > 0) {
    writeFileSync(pidsPath, JSON.stringify(kept));
  } else {
    rmSync(pidsPath, { force: true });
  }
};

/**
 * Start `file` as the leader of a new process group, with stdout and stderr
 * going to `logPath`.
 */
export const spawnGroup = (opts: {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  logPath: string;
  /** Where to record the group, for {@link reapStaleGroups}. */
  pidsPath: string;
}): GroupProcess => {
  mkdirSync(dirname(opts.logPath), { recursive: true });

  const log = openSync(opts.logPath, "w");

  const child = spawn(opts.file, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    detached: true,
    stdio: ["ignore", log, log],
  });

  closeSync(log);

  const startedAt = child.pid ? startTime(child.pid) : undefined;

  if (child.pid && startedAt) {
    writeFileSync(
      opts.pidsPath,
      JSON.stringify([
        ...readRecorded(opts.pidsPath),
        { pid: child.pid, startedAt, owner: process.pid },
      ]),
    );
  }

  let exited = false;

  child.once("error", (error) => {
    exited = true;

    appendFileSync(opts.logPath, `${errorMessage(error)}\n`);
  });

  child.once("exit", () => {
    exited = true;
  });

  return {
    pid: child.pid ?? 0,
    logPath: opts.logPath,
    hasExited: () => {
      return exited;
    },
  };
};

const groupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
};

/**
 * Stop a group: `SIGTERM`, then `SIGKILL` for whatever is left after `graceMs`.
 * Resolves once no process in the group is alive.
 */
export const stopGroup = async (
  proc: Pick<GroupProcess, "pid">,
  graceMs = 5000,
): Promise<void> => {
  if (!proc.pid) {
    return;
  }

  signalGroup(proc.pid, "SIGTERM");

  const deadline = Date.now() + graceMs;

  while (groupAlive(proc.pid) && Date.now() < deadline) {
    await sleep(50);
  }

  if (groupAlive(proc.pid)) {
    signalGroup(proc.pid, "SIGKILL");

    while (groupAlive(proc.pid)) {
      await sleep(50);
    }
  }
};

/** How much of the end of a log is read to find its last lines. */
const logTailBytes = 64 * 1024;

/** The last `lines` lines of a log, or an empty string if it can't be read. */
export const logTail = async (path: string, lines = 20): Promise<string> => {
  try {
    const file = await open(path);

    try {
      const { size } = await file.stat();
      const length = Math.min(size, logTailBytes);
      const buffer = Buffer.alloc(length);

      await file.read(buffer, 0, length, size - length);

      return buffer
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .slice(-lines)
        .join("\n");
    } finally {
      await file.close();
    }
  } catch {
    return "";
  }
};
