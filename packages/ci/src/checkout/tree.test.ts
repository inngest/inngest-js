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
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { buildTarball } from "./tarball.ts";
import { treeDelta, workingTreeId } from "./tree.ts";

const git = (cwd: string, ...args: string[]): string => {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
};

/** Every file under `dir`, relative, with its contents. */
const snapshotDir = (dir: string, prefix = ""): Record<string, string> => {
  const out: Record<string, string> = {};

  for (const name of readdirSync(join(dir, prefix))) {
    const relative = prefix ? `${prefix}/${name}` : name;

    if (relative === ".git") {
      continue;
    }

    if (statSync(join(dir, relative)).isDirectory()) {
      Object.assign(out, snapshotDir(dir, relative));
    } else {
      out[relative] = readFileSync(join(dir, relative), "utf8");
    }
  }

  return out;
};

describe("workingTreeId and treeDelta", () => {
  let root: string;
  let repo: string;

  const write = (path: string, contents: string) => {
    mkdirSync(join(repo, path, ".."), { recursive: true });

    writeFileSync(join(repo, path), contents);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ci-tree-"));
    repo = join(root, "repo");

    mkdirSync(repo);

    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "ci@example.com");
    git(repo, "config", "user.name", "ci");

    write(".gitignore", "ignored.txt\nnode_modules/\n");
    write("keep.txt", "keep");
    write("edit.txt", "before");
    write("gone.txt", "gone");
    write("dir/nested.txt", "nested");

    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("hashing the tree leaves the real index and the repository alone", async () => {
    write("edit.txt", "edited but not staged");
    write("untracked.txt", "new");

    const indexBefore = readFileSync(join(repo, ".git", "index"));
    const statusBefore = git(repo, "status", "--porcelain=v1");
    const headBefore = git(repo, "rev-parse", "HEAD");

    const id = await workingTreeId(repo);

    expect(id).toMatch(/^[0-9a-f]{40}$/);

    expect(readFileSync(join(repo, ".git", "index"))).toEqual(indexBefore);
    expect(git(repo, "status", "--porcelain=v1")).toBe(statusBefore);
    expect(git(repo, "rev-parse", "HEAD")).toBe(headBefore);

    // The untracked file is in the tree, though never staged for real.
    expect(git(repo, "ls-tree", "--name-only", id as string)).toContain(
      "untracked.txt",
    );
  });

  test("the same files give the same ID, and any change gives another", async () => {
    const first = await workingTreeId(repo);

    expect(await workingTreeId(repo)).toBe(first);

    write("edit.txt", "after");

    expect(await workingTreeId(repo)).not.toBe(first);
  });

  test("ignored files are left out, like the tarball leaves them out", async () => {
    const before = await workingTreeId(repo);

    write("ignored.txt", "ignored");
    write("node_modules/pkg/index.js", "module");

    expect(await workingTreeId(repo)).toBe(before);
  });

  test("a directory inside a repository, or no repository, has no ID", async () => {
    expect(await workingTreeId(join(repo, "dir"))).toBeUndefined();
    expect(await workingTreeId(root)).toBeUndefined();
  });

  test("the diff has adds, modifies and deletes that rebuild the new tree", async () => {
    const before = await workingTreeId(repo);

    // What a machine holding `before` has on disk.
    const machine = join(root, "machine");

    mkdirSync(machine);

    execFileSync("git", [
      "-C",
      repo,
      "archive",
      "--format=tar",
      before as string,
      "-o",
      join(root, "before.tar"),
    ]);
    execFileSync("tar", ["-xf", join(root, "before.tar"), "-C", machine]);

    write("edit.txt", "after");
    write("added.txt", "added");
    write("dir/deeper/added.txt", "deep");

    rmSync(join(repo, "gone.txt"));

    const after = await workingTreeId(repo);
    const delta = await treeDelta(repo, before as string, after as string);

    expect(delta).toBeDefined();
    expect([...(delta?.changed ?? [])].sort()).toEqual([
      "added.txt",
      "dir/deeper/added.txt",
      "edit.txt",
    ]);
    expect(delta?.deleted).toEqual(["gone.txt"]);

    // Applying it is what `checkout()` does on the machine.
    const tarball = await buildTarball(repo, delta?.changed ?? []);

    writeFileSync(join(root, "delta.tar"), tarball);
    execFileSync("tar", ["-xf", join(root, "delta.tar"), "-C", machine]);

    for (const path of delta?.deleted ?? []) {
      rmSync(join(machine, path));
    }

    expect(snapshotDir(machine)).toEqual(snapshotDir(repo));
  });

  test("the same tree has an empty diff", async () => {
    const id = (await workingTreeId(repo)) as string;

    expect(await treeDelta(repo, id, id)).toEqual({ changed: [], deleted: [] });
  });

  test("a tree git doesn't have can't be diffed", async () => {
    const id = (await workingTreeId(repo)) as string;

    expect(await treeDelta(repo, "0".repeat(40), id)).toBeUndefined();
    expect(await treeDelta(repo, "not a tree", id)).toBeUndefined();
  });
});
