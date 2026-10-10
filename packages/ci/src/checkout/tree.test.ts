/**
 * Tests for the working tree's git tree ID and the diff between two of them,
 * on throwaway git repositories.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { buildTarball } from "./tarball.ts";
import { treeDelta, workingTreeId } from "./tree.ts";

const run = (cwd: string, cmd: string, ...args: string[]): string => {
  return execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();
};

describe("workingTreeId and treeDelta", () => {
  let root: string;
  let repo: string;

  const write = (path: string, contents: string) => {
    mkdirSync(join(repo, path, ".."), { recursive: true });

    writeFileSync(join(repo, path), contents);
  };

  const idOf = async (cwd = repo): Promise<string> => {
    return (await workingTreeId(cwd)) as string;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ci-tree-"));
    repo = join(root, "repo");

    mkdirSync(repo);

    run(repo, "git", "init", "-q", "-b", "main");
    run(repo, "git", "config", "user.email", "ci@example.com");
    run(repo, "git", "config", "user.name", "ci");

    write(".gitignore", "ignored.txt\nnode_modules/\n");
    write("edit.txt", "before");
    write("gone.txt", "gone");
    write("dir/nested.txt", "nested");

    run(repo, "git", "add", ".");
    run(repo, "git", "commit", "-q", "-m", "init");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("hashing leaves the real index and repository alone, and includes untracked files", async () => {
    write("edit.txt", "edited but not staged");
    write("untracked.txt", "new");

    const index = readFileSync(join(repo, ".git", "index"));
    const status = run(repo, "git", "status", "--porcelain=v1");

    const id = await idOf();

    expect(id).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(join(repo, ".git", "index"))).toEqual(index);
    expect(run(repo, "git", "status", "--porcelain=v1")).toBe(status);
    expect(run(repo, "git", "ls-tree", "--name-only", id)).toContain(
      "untracked.txt",
    );
  });

  test.each([
    ["the same files", () => {}, true],
    ["an edit", () => write("edit.txt", "after"), false],
    ["ignored files", () => write("node_modules/pkg/index.js", "x"), true],
  ])("%s: same ID is %s", async (_label, change, same) => {
    const before = await idOf();

    change();

    expect((await idOf()) === before).toBe(same);
  });

  test("a directory inside a repository, or no repository, has no ID", async () => {
    expect(await workingTreeId(join(repo, "dir"))).toBeUndefined();
    expect(await workingTreeId(root)).toBeUndefined();
  });

  test("the diff rebuilds the new tree on a machine holding the old one", async () => {
    const before = await idOf();
    const machine = join(root, "machine");

    mkdirSync(machine);

    // What a machine holding `before` has on disk.
    run(repo, "sh", "-c", `git archive ${before} | tar -x -C ${machine}`);

    write("edit.txt", "after");
    write("added.txt", "added");
    write("dir/deeper/added.txt", "deep");
    rmSync(join(repo, "gone.txt"));

    const delta = await treeDelta(repo, before, await idOf());

    expect(delta?.changed.sort()).toEqual([
      "added.txt",
      "dir/deeper/added.txt",
      "edit.txt",
    ]);
    expect(delta?.deleted).toEqual(["gone.txt"]);

    // Applying it is what `checkout()` does on the machine.
    execFileSync("tar", ["-x", "-C", machine], {
      input: await buildTarball(repo, delta?.changed ?? []),
    });

    rmSync(join(machine, "gone.txt"));

    // `diff -r` throws on any difference.
    run(root, "diff", "-r", "--exclude=.git", machine, repo);
  });

  test("the same tree has an empty diff; a tree git doesn't have can't be diffed", async () => {
    const id = await idOf();

    expect(await treeDelta(repo, id, id)).toEqual({ changed: [], deleted: [] });
    expect(await treeDelta(repo, "0".repeat(40), id)).toBeUndefined();
    expect(await treeDelta(repo, "not a tree", id)).toBeUndefined();
  });
});
