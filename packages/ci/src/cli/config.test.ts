/**
 * Tests for finding the project and reading `inngest.json`.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { findProjectRoot, loadConfig } from "./config.ts";
import { SetupError } from "./setupError.ts";

let repo: string;

const write = (path: string, contents: string): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
};

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "ci-config-")));

  execFileSync("git", ["init", "-q"], { cwd: repo });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("loadConfig", () => {
  test("applies defaults", async () => {
    write(
      join(repo, "inngest.json"),
      JSON.stringify({ ci: { start: "node s.js" } }),
    );

    expect(await loadConfig(repo)).toEqual({
      root: repo,
      start: "node s.js",
      path: "/api/inngest",
      dir: join(repo, ".inngest/ci"),
      devServerBin: undefined,
    });
  });

  test("reads every key and allows unknown ones", async () => {
    write(
      join(repo, "inngest.json"),
      JSON.stringify({
        other: 1,
        ci: {
          start: "x",
          path: "/inngest",
          dir: "out",
          devServer: { bin: "/bin/inngest", extra: true },
          future: true,
        },
      }),
    );

    expect(await loadConfig(repo)).toMatchObject({
      path: "/inngest",
      dir: join(repo, "out"),
      devServerBin: "/bin/inngest",
    });
  });

  test.each([
    ["ts", "tsx ci/server.ts"],
    ["mts", "tsx ci/server.mts"],
    ["js", "node ci/server.js"],
    ["mjs", "node ci/server.mjs"],
  ])("falls back to ci/server.%s", async (extension, start) => {
    write(join(repo, `ci/server.${extension}`), "");

    expect((await loadConfig(repo)).start).toBe(start);
  });

  test("a ci key without start still uses the convention", async () => {
    write(join(repo, "inngest.json"), JSON.stringify({ ci: { dir: "out" } }));
    write(join(repo, "ci/server.ts"), "");

    expect((await loadConfig(repo)).start).toBe("tsx ci/server.ts");
  });

  test("with nothing to start, shows the config to add", async () => {
    await expect(loadConfig(repo)).rejects.toMatchObject({
      message: "No command to start your app.",
      fix: expect.stringContaining('"start"'),
    });
  });

  test.each([
    [{ ci: "x" }, '"ci" in inngest.json must be an object'],
    [{ ci: { start: 1 } }, "ci.start"],
    [{ ci: { start: "x", path: "api" } }, 'must start with "/"'],
    [{ ci: { start: "x", dir: "" } }, "ci.dir"],
    [{ ci: { start: "x", devServer: "x" } }, "ci.devServer"],
    [{ ci: { start: "x", devServer: { bin: 1 } } }, "ci.devServer.bin"],
  ])("rejects wrong types: %j", async (json, message) => {
    write(join(repo, "inngest.json"), JSON.stringify(json));

    await expect(loadConfig(repo)).rejects.toThrow(message);
    await expect(loadConfig(repo)).rejects.toBeInstanceOf(SetupError);
  });

  test("rejects invalid JSON", async () => {
    write(join(repo, "inngest.json"), "{");

    await expect(loadConfig(repo)).rejects.toThrow(/Could not read/);
  });
});

describe("findProjectRoot", () => {
  test("is the nearest directory with an inngest.json", async () => {
    write(join(repo, "inngest.json"), "{}");
    write(join(repo, "apps/web/inngest.json"), "{}");
    mkdirSync(join(repo, "apps/web/src"), { recursive: true });

    expect(await findProjectRoot(join(repo, "apps/web/src"))).toBe(
      join(repo, "apps/web"),
    );
  });

  test("never goes past the git root", async () => {
    mkdirSync(join(repo, "sub"));

    expect(await findProjectRoot(join(repo, "sub"))).toBe(join(repo, "sub"));
  });

  test("outside a git repository, is a setup error", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ci-nogit-"));

    try {
      await expect(findProjectRoot(outside)).rejects.toBeInstanceOf(SetupError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
