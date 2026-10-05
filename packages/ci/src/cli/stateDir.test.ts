/**
 * Tests for resolving the state directory and pruning old session files.
 *
 * @module
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { pruneSessions, resolveStateDir } from "./stateDir.ts";

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
