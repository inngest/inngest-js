/**
 * Tests of starting and stopping processes: the env a child gets, and that
 * stopping takes the whole tree down.
 *
 * @module
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { freePorts, logTail, scrubbedEnv, startProcess } from "./processes.ts";

const dir = mkdtempSync(join(tmpdir(), "ci-proc-"));

afterEach(() => {
  vi.unstubAllEnvs();
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

describe("processes", () => {
  test("INNGEST_* is scrubbed from a child's env, the rest is kept", () => {
    vi.stubEnv("INNGEST_SIGNING_KEY", "secret");
    vi.stubEnv("KEEP_ME", "yes");

    const env = scrubbedEnv({ PORT: "1" });

    expect(env.INNGEST_SIGNING_KEY).toBeUndefined();
    expect(env.KEEP_ME).toBe("yes");
    expect(env.PORT).toBe("1");
  });

  test("freePorts gives distinct ports", async () => {
    const ports = await freePorts(5);

    expect(new Set(ports).size).toBe(5);
  });

  test("stop takes down the children the process started", async () => {
    const proc = startProcess({
      command: "sleep 60 & echo $! > child.pid; wait",
      cwd: dir,
      env: scrubbedEnv(),
      logPath: join(dir, "p.log"),
    });

    await vi.waitFor(() => {
      expect(
        Number(readFileSync(join(dir, "child.pid"), "utf8")),
      ).toBeGreaterThan(0);
    });

    const child = Number(readFileSync(join(dir, "child.pid"), "utf8"));

    expect(alive(child)).toBe(true);

    await proc.stop();

    await vi.waitFor(() => {
      expect(alive(child)).toBe(false);
    });

    expect(proc.hasExited()).toBe(true);
  });

  test("output goes to the log and its tail can be read", async () => {
    const proc = startProcess({
      command: "printf 'a\\nb\\nc\\n'",
      cwd: dir,
      env: scrubbedEnv(),
      logPath: join(dir, "out.log"),
    });

    await vi.waitFor(() => {
      expect(proc.hasExited()).toBe(true);
    });

    expect(logTail(proc.logPath, 2)).toBe("b\nc");
  });
});

afterEach(() => {
  rmSync(join(dir, "child.pid"), { force: true });
});
