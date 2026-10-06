/**
 * Tests for resolving the state directory and pruning old session files.
 *
 * @module
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { findSession, pruneSessions, resolveStateDir } from "./stateDir.ts";

describe("resolveStateDir", () => {
  const home = "/home/me";

  test.each([
    [
      "the explicit variable wins",
      { INNGEST_CI_STATE_DIR: "/x", XDG_STATE_HOME: "/xdg" },
      "linux",
      "/x",
    ],
    ["XDG next", { XDG_STATE_HOME: "/xdg" }, "darwin", "/xdg/inngest-ci"],
    ["macOS", {}, "darwin", "/home/me/Library/Application Support/inngest-ci"],
    ["Windows", { LOCALAPPDATA: "/local" }, "win32", "/local/inngest-ci"],
    ["Linux", {}, "linux", "/home/me/.local/state/inngest-ci"],
    [
      "Windows without LOCALAPPDATA",
      {},
      "win32",
      "/home/me/.local/state/inngest-ci",
    ],
  ] as const)("%s", (_, env, platform, expected) => {
    expect(resolveStateDir({ env, platform, home })).toBe(expected);
  });
});

describe("pruneSessions", () => {
  const now = 1_000_000_000;
  const minute = 60_000;

  test("removes dead finished and day-old sessions, keeps the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-state-"));
    const sessions = join(dir, "sessions");
    const put = (name: string, state: object) => {
      writeFileSync(join(sessions, `${name}.json`), JSON.stringify(state));
    };

    mkdirSync(sessions);
    put("finished-long-ago", {
      pid: 1,
      startedAt: now - 20 * minute,
      endedAt: now - 11 * minute,
    });
    put("finished-just-now", {
      pid: 2,
      startedAt: now - 20 * minute,
      endedAt: now - 5 * minute,
    });
    put("running", { pid: 3, startedAt: now - 5 * minute });
    put("crashed-yesterday", { pid: 4, startedAt: now - 25 * 60 * minute });
    put("live-but-ancient", { pid: 5, startedAt: now - 25 * 60 * minute });
    put("live-and-ended", {
      pid: 5,
      startedAt: now - 90 * minute,
      endedAt: now - 80 * minute,
    });
    writeFileSync(join(sessions, "broken.json"), "{");

    pruneSessions({
      dir,
      now,
      isAlive: (pid) => {
        return pid === 5;
      },
    });

    const kept = (name: string) => {
      return existsSync(join(sessions, `${name}.json`));
    };

    expect(kept("finished-long-ago")).toBe(false);
    expect(kept("crashed-yesterday")).toBe(false);
    expect(kept("finished-just-now")).toBe(true);
    expect(kept("running")).toBe(true);
    expect(kept("live-but-ancient")).toBe(true);
    expect(kept("live-and-ended")).toBe(true);
    expect(kept("broken")).toBe(true);
  });

  test("does nothing when the directory doesn't exist", () => {
    expect(() => {
      pruneSessions({ dir: "/nonexistent-ci-state", now });
    }).not.toThrow();
  });
});

/** A state dir with session files, and the Dev Server folders they name. */
const stateWith = (sessions: Record<string, object>) => {
  const dir = mkdtempSync(join(tmpdir(), "ci-state-"));
  const root = mkdtempSync(join(tmpdir(), "ci-project-"));

  mkdirSync(join(dir, "sessions"));

  for (const [name, state] of Object.entries(sessions)) {
    const devServerDir = join(root, "dev-server", name);

    mkdirSync(devServerDir, { recursive: true });
    writeFileSync(
      join(dir, "sessions", `${name}.json`),
      JSON.stringify({ devServerDir, ...state }),
    );
  }

  return { dir, root };
};

describe("pruneSessions with Dev Server databases", () => {
  test("removes a pruned session's database, and no other", () => {
    const { dir, root } = stateWith({
      old: { pid: 1, startedAt: 0, endedAt: 1 },
      live: { pid: 2, startedAt: 0, endedAt: 1 },
    });

    pruneSessions({
      dir,
      now: 1_000_000_000,
      isAlive: (pid) => {
        return pid === 2;
      },
    });

    expect(existsSync(join(root, "dev-server", "old"))).toBe(false);
    expect(existsSync(join(root, "dev-server", "live"))).toBe(true);
  });

  test("never removes the dev-server folder itself", () => {
    const { dir, root } = stateWith({
      old: { pid: 1, startedAt: 0, endedAt: 1 },
    });
    const file = join(dir, "sessions", "old.json");
    const state = JSON.parse(readFileSync(file, "utf8"));

    writeFileSync(
      file,
      JSON.stringify({ ...state, devServerDir: join(root, "dev-server") }),
    );

    pruneSessions({ dir, now: 1_000_000_000, isAlive: () => false });

    expect(existsSync(join(root, "dev-server"))).toBe(true);
  });
});

describe("findSession", () => {
  const project = (root: string) => {
    return { root, name: "p" };
  };

  test("finds the session that ran a run, in this project only", () => {
    const { dir, root } = stateWith({
      a: { startedAt: 1, project: project("/p"), runs: [{ runId: "r1" }] },
      b: { startedAt: 2, project: project("/p"), runs: [{ runId: "r2" }] },
      c: { startedAt: 3, project: project("/other"), runs: [{ runId: "r1" }] },
    });

    expect(findSession({ dir, projectRoot: "/p", runId: "r1" })).toEqual({
      devServerDir: join(root, "dev-server", "a"),
    });
    expect(
      findSession({ dir, projectRoot: "/p", runId: "r9" }),
    ).toBeUndefined();
  });

  test("with no run, finds the most recent session of the project", () => {
    const { dir, root } = stateWith({
      a: { startedAt: 1, project: project("/p") },
      b: { startedAt: 2, project: project("/p") },
    });

    expect(findSession({ dir, projectRoot: "/p" })?.devServerDir).toBe(
      join(root, "dev-server", "b"),
    );
  });

  test("skips a session whose database is gone", () => {
    const { dir, root } = stateWith({
      a: { startedAt: 1, project: project("/p") },
      b: { startedAt: 2, project: project("/p") },
    });

    rmSync(join(root, "dev-server", "b"), { recursive: true });

    expect(findSession({ dir, projectRoot: "/p" })?.devServerDir).toBe(
      join(root, "dev-server", "a"),
    );
  });

  test("gives the URL of a session that is still running", () => {
    const { dir } = stateWith({
      a: {
        pid: 7,
        startedAt: 1,
        devServerUrl: "http://127.0.0.1:9",
        project: project("/p"),
      },
    });

    expect(
      findSession({ dir, projectRoot: "/p", isAlive: () => true })?.liveUrl,
    ).toBe("http://127.0.0.1:9");
    expect(
      findSession({ dir, projectRoot: "/p", isAlive: () => false })?.liveUrl,
    ).toBeUndefined();
  });

  test("is undefined with no sessions at all", () => {
    expect(
      findSession({ dir: "/nonexistent", projectRoot: "/p" }),
    ).toBeUndefined();
  });
});
