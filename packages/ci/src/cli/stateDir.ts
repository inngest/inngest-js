/**
 * Where `inngest-ci` publishes its live session files, and how old ones are
 * cleaned up. Editor integrations read the same directory, so the rules here
 * are a contract. Everything takes its environment as arguments.
 *
 * @module
 */

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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
 * minutes ago, or that started more than 24 hours ago, along with the Dev
 * Server database each recorded. A live pid's files are never touched. Best
 * effort: files it can't read or remove are left alone.
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
        devServerDir?: string;
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

        // Only a session's own folder, never the `dev-server` folder itself.
        if (
          state.devServerDir &&
          basename(dirname(state.devServerDir)) === "dev-server"
        ) {
          rmSync(state.devServerDir, { recursive: true, force: true });
        }
      }
    } catch {
      // Unreadable or half-written; leave it.
    }
  }
};

/** A session of a project whose Dev Server database is still on disk. */
export interface FoundSession {
  devServerDir: string;
  /** Where its Dev Server is, when the session is still running. */
  liveUrl?: string;
}

/**
 * The session of the project at `projectRoot` that ran `runId`, or the most
 * recent one that left a database when there is no `runId`. A session whose
 * process is still running has its own Dev Server up, which holds the
 * database, so it comes back with that server's URL instead.
 */
export const findSession = (opts: {
  /** The directory from `resolveStateDir()`. */
  dir: string;
  projectRoot: string;
  runId?: string;
  isAlive?: (pid: number) => boolean;
}): FoundSession | undefined => {
  const { isAlive = isPidAlive } = opts;
  const sessions = join(opts.dir, "sessions");
  let names: string[];

  try {
    names = readdirSync(sessions);
  } catch {
    return undefined;
  }

  const found = names
    .filter((name) => {
      return name.endsWith(".json");
    })
    .flatMap((name) => {
      try {
        const state = JSON.parse(
          readFileSync(join(sessions, name), "utf8"),
        ) as {
          pid?: number;
          startedAt?: number;
          closedAt?: number;
          devServerUrl?: string;
          devServerDir?: string;
          project?: { root?: string };
          runs?: { runId: string }[];
        };
        const hasRun =
          !opts.runId ||
          state.runs?.some((run) => {
            return run.runId === opts.runId;
          });

        return state.project?.root === opts.projectRoot &&
          state.devServerDir &&
          existsSync(state.devServerDir) &&
          hasRun
          ? [{ state, devServerDir: state.devServerDir }]
          : [];
      } catch {
        // Unreadable or half-written; skip it.
        return [];
      }
    })
    .sort((a, b) => {
      return (b.state.startedAt ?? 0) - (a.state.startedAt ?? 0);
    })[0];

  if (!found) {
    return undefined;
  }

  const { state, devServerDir } = found;
  const live =
    typeof state.pid === "number" && !state.closedAt && isAlive(state.pid);

  return { devServerDir, liveUrl: live ? state.devServerUrl : undefined };
};
