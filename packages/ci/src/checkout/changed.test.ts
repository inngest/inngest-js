/**
 * Tests for reading what changed: local git output with awkward paths, the
 * limits of GitHub's compare, and runs with no repository.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { hashLocalFiles } from "../cache/localCache.ts";
import { CiUsageError } from "../errors.ts";
import { consoleReporter } from "../github/auth.ts";
import { createCi } from "../pipeline/createCi.ts";
import { createCiTestClient } from "../testing/client.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import { changed, collectComparedFiles, localChangedFiles } from "./changed.ts";
import { parsePorcelainPaths } from "./porcelain.ts";

describe("parsePorcelainPaths", () => {
  test("keeps the new path of a rename and drops the old one", () => {
    expect(
      parsePorcelainPaths("R  new name.txt\0old name.txt\0 M other.txt\0"),
    ).toEqual(["new name.txt", "other.txt"]);
  });
});

describe("collectComparedFiles", () => {
  const page = (count: number, from = 0): string[] => {
    return Array.from({ length: count }, (_, i) => {
      return `f${from + i}`;
    });
  };

  test("joins pages until a short one", async () => {
    const pages = [page(100, 0), page(100, 100), page(5, 200)];

    const files = await collectComparedFiles(async (n) => {
      return pages[n - 1] ?? [];
    });

    expect(files).toHaveLength(205);
  });

  test("is unknown when the compare reaches GitHub's file limit", async () => {
    await expect(
      collectComparedFiles(async (n) => {
        return page(100, (n - 1) * 100);
      }),
    ).rejects.toBeInstanceOf(CiUsageError);
  });
});

describe("local git", () => {
  let root: string;

  const git = (...args: string[]) => {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ci-changed-"));

    git("init", "-q", "-b", "main");
    git("config", "user.email", "ci@example.com");
    git("config", "user.name", "ci");

    writeFileSync(join(root, "base.txt"), "base");

    git("add", ".");
    git("commit", "-q", "-m", "base");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("changed files with spaces and quotes come through unquoted", async () => {
    mkdirSync(join(root, "new dir"));
    writeFileSync(join(root, "new dir", 'it "is".txt'), "x");
    writeFileSync(join(root, "my file.txt"), "y");

    expect((await localChangedFiles(root, "main")).sort()).toEqual([
      "my file.txt",
      'new dir/it "is".txt',
    ]);
  });

  test("cache keys see awkward paths and untracked directories", async () => {
    mkdirSync(join(root, "dir"));
    writeFileSync(join(root, "dir", "a b.txt"), "one");

    const first = await hashLocalFiles(root, ["dir/**"]);

    writeFileSync(join(root, "dir", "a b.txt"), "two");

    expect(await hashLocalFiles(root, ["dir/**"])).not.toBe(first);
  });

  test("cache keys tell apart files that aren't valid UTF-8", async () => {
    writeFileSync(join(root, "bin.dat"), Buffer.from([0xff, 0xfe]));

    const first = await hashLocalFiles(root, ["bin.dat"]);

    writeFileSync(join(root, "bin.dat"), Buffer.from([0xfd, 0xfc]));

    expect(await hashLocalFiles(root, ["bin.dat"])).not.toBe(first);
  });
});

describe("changed()", () => {
  test("a run with no repository is unknown, not unchanged", async () => {
    const ci = createCi(createCiTestClient(createFakeSandboxApi()), {
      github: consoleReporter(),
    });

    const pipeline = ci.pipeline(
      { id: "nightly", on: { cron: "0 3 * * *" } },
      async () => {
        return changed("src/**");
      },
    );

    const result = await runFunction(pipeline, {
      event: { name: "inngest/scheduled.timer", data: {} },
    });

    expect(result.data).toBe(true);
  });
});
