/**
 * Tests of reading the `ci` config from `inngest.json`.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadConfig, NoConfigError } from "./config.ts";

const dirs: string[] = [];

/** A git repository with `files` (path to content) written into it. */
const repo = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "ci-config-"));

  dirs.push(dir);

  execFileSync("git", ["init", "-q"], { cwd: dir });

  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });

    writeFileSync(join(dir, path), content);
  }

  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadConfig", () => {
  test("reads start and path, with /api/inngest as the default path", async () => {
    const dir = repo({
      "inngest.json": JSON.stringify({ ci: { start: "node s.js" } }),
    });

    expect(await loadConfig(dir)).toMatchObject({
      start: "node s.js",
      path: "/api/inngest",
    });
  });

  test("falls back to ci/server.ts", async () => {
    const dir = repo({ "ci/server.ts": "" });

    expect(await loadConfig(dir)).toMatchObject({ start: "tsx ci/server.ts" });
  });

  test("nothing to start the app with is a NoConfigError", async () => {
    await expect(loadConfig(repo({}))).rejects.toBeInstanceOf(NoConfigError);
  });

  test.each([
    [{ ci: { start: "" } }, /ci.start/],
    [{ ci: { start: "x", path: "api" } }, /must start with "\/"/],
    [{ ci: [] }, /must be an object/],
  ])("rejects %j", async (json, message) => {
    const dir = repo({ "inngest.json": JSON.stringify(json) });

    await expect(loadConfig(dir)).rejects.toThrow(message);
  });

  test("outside a git repository is an error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-nogit-"));

    dirs.push(dir);

    await expect(loadConfig(dir)).rejects.toThrow(
      /Not inside a git repository/,
    );
  });
});
