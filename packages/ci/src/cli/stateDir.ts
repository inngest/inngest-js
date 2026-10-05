/**
 * Where `inngest-ci` publishes its live session files, and how old ones are
 * cleaned up. Editor integrations read the same directory, so the rules here
 * are a contract. Everything takes its environment as arguments.
 *
 * @module
 */

import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Sessions that ended longer ago than this, and whose process is gone. */
const endedRetentionMs = 10 * 60_000;

/** Sessions older than this are removed, ended or not, once their process is gone. */
const maxAgeMs = 24 * 60 * 60_000;

/**
 * The directory holding the state of `inngest-ci` sessions. The first match
 * wins: `INNGEST_CI_STATE_DIR`, `$XDG_STATE_HOME/inngest-ci`, the platform's
 * own place on macOS and Windows, then `~/.local/state/inngest-ci`.
 */
export const resolveStateDir = (opts: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
}): string => {
  const { env, platform, home } = opts;

  if (env.INNGEST_CI_STATE_DIR) {
    return env.INNGEST_CI_STATE_DIR;
  }

  if (env.XDG_STATE_HOME) {
    return join(env.XDG_STATE_HOME, "inngest-ci");
  }

  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "inngest-ci");
  }

  if (platform === "win32" && env.LOCALAPPDATA) {
    return join(env.LOCALAPPDATA, "inngest-ci");
  }

  return join(home, ".local", "state", "inngest-ci");
};

/** Whether a process with this pid exists. */
export const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    // No permission to signal it still means it exists.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Delete the session files whose process is dead and that ended more than 10
 * minutes ago, or that started more than 24 hours ago. A live pid's file is
 * never touched. Best effort: files it can't read or remove are left alone.
 */
export const pruneSessions = (opts: {
  /** The directory from `resolveStateDir()`. */
  dir: string;
  now: number;
  isAlive?: (pid: number) => boolean;
}): void => {
  const { now, isAlive = isPidAlive } = opts;
  const sessions = join(opts.dir, "sessions");
  let names: string[];

  try {
    names = readdirSync(sessions);
  } catch {
    return;
  }

  for (const name of names.filter((n) => {
    return n.endsWith(".json");
  })) {
    const file = join(sessions, name);

    try {
      const state = JSON.parse(readFileSync(file, "utf8")) as {
        pid?: number;
        startedAt?: number;
        endedAt?: number;
      };

      if (typeof state.pid === "number" && isAlive(state.pid)) {
        continue;
      }

      const ended =
        state.endedAt !== undefined && now - state.endedAt > endedRetentionMs;
      const old =
        state.startedAt !== undefined && now - state.startedAt > maxAgeMs;

      if (ended || old) {
        rmSync(file, { force: true });
      }
    } catch {
      // Unreadable or half-written; leave it.
    }
  }
};
