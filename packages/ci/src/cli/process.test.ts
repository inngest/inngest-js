/**
 * Tests for process groups against a real `sh`, and for log tails.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  logTail,
  reapStaleGroups,
  scrubbedEnv,
  spawnGroup,
  stopGroup,
} from "./process.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ci-process-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

describe("scrubbedEnv", () => {
  test("drops INNGEST_* and adds extras", () => {
    expect(
      scrubbedEnv(
        { PORT: "1" },
        { INNGEST_EVENT_KEY: "secret", INNGEST_DEV: "0", HOME: "/h" },
      ),
    ).toEqual({ HOME: "/h", PORT: "1" });
  });
});

describe("spawnGroup and stopGroup", () => {
  test("logs output and stops the whole group, children included", async () => {
    const proc = spawnGroup({
      file: "sh",
      args: ["-c", "sleep 60 & echo started; wait"],
      cwd: dir,
      env: scrubbedEnv(),
      logPath: join(dir, "logs", "app.log"),
      pidsPath: join(dir, "pids.json"),
    });

    await sleep(300);

    expect(await logTail(proc.logPath)).toBe("started");

    const child = Number(
      execFileSync("pgrep", ["-g", String(proc.pid), "sleep"])
        .toString()
        .trim(),
    );

    expect(alive(child)).toBe(true);

    await stopGroup(proc);

    expect(proc.hasExited()).toBe(true);
    expect(alive(child)).toBe(false);
  });

  test("kills a group that ignores SIGTERM", async () => {
    const proc = spawnGroup({
      file: "sh",
      args: ["-c", "trap '' TERM; while true; do sleep 1; done"],
      cwd: dir,
      env: scrubbedEnv(),
      logPath: join(dir, "stubborn.log"),
      pidsPath: join(dir, "pids.json"),
    });

    await sleep(200);
    await stopGroup(proc, 300);

    expect(alive(proc.pid)).toBe(false);
  });

  test("records a spawn failure in the log", async () => {
    const proc = spawnGroup({
      file: "/nonexistent/bin",
      args: [],
      cwd: dir,
      env: {},
      logPath: join(dir, "missing.log"),
      pidsPath: join(dir, "pids.json"),
    });

    await sleep(100);

    expect(proc.hasExited()).toBe(true);
    expect(await logTail(proc.logPath)).toContain("ENOENT");
  });
});

describe("reapStaleGroups", () => {
  const start = () => {
    return spawnGroup({
      file: "sh",
      args: ["-c", "sleep 60"],
      cwd: dir,
      env: scrubbedEnv(),
      logPath: join(dir, "stale.log"),
      pidsPath: join(dir, "pids.json"),
    });
  };

  test("stops a group whose CLI is gone", async () => {
    const proc = start();
    const recorded = JSON.parse(readFileSync(join(dir, "pids.json"), "utf8"));

    // As if a CLI that is no longer running had started it.
    recorded[0].owner = 2 ** 22 + 1;
    writeFileSync(join(dir, "pids.json"), JSON.stringify(recorded));

    await reapStaleGroups(join(dir, "pids.json"));

    expect(alive(proc.pid)).toBe(false);
    expect(existsSync(join(dir, "pids.json"))).toBe(false);
  });

  test("leaves a group whose CLI is still running", async () => {
    const proc = start();
    const recorded = JSON.parse(readFileSync(join(dir, "pids.json"), "utf8"));

    // The parent test runner stands in for a second, live CLI.
    recorded[0].owner = process.ppid;
    writeFileSync(join(dir, "pids.json"), JSON.stringify(recorded));

    await reapStaleGroups(join(dir, "pids.json"));

    expect(alive(proc.pid)).toBe(true);

    await stopGroup(proc);
  });

  test("doesn't touch a process that reused a recorded PID", async () => {
    const proc = start();

    writeFileSync(
      join(dir, "pids.json"),
      JSON.stringify([
        { pid: proc.pid, startedAt: "long ago", owner: 2 ** 22 + 1 },
      ]),
    );

    await reapStaleGroups(join(dir, "pids.json"));

    expect(alive(proc.pid)).toBe(true);

    await stopGroup(proc);
  });
});

describe("logTail", () => {
  test("keeps the last lines, and is empty for a missing file", async () => {
    writeFileSync(join(dir, "x.log"), "a\nb\nc\n");

    expect(await logTail(join(dir, "x.log"), 2)).toBe("b\nc");
    expect(await logTail(join(dir, "none.log"))).toBe("");
  });
});
