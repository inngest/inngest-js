/**
 * Identifying the working tree that was uploaded to a machine, and working out
 * what changed since: a git tree ID, and the diff between two of them.
 *
 * @module
 */

import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../util.ts";

/** What differs between two trees, as paths relative to the working tree. */
export interface TreeDelta {
  /** Added, modified or retyped paths, which are uploaded. */
  changed: string[];
  /** Paths that are gone, which are removed on the machine. */
  deleted: string[];
}

/**
 * The git tree ID of the working tree as `checkout()` uploads it: tracked
 * files plus untracked ones that aren't ignored, which is what the tarball
 * holds.
 *
 * It's built in a temporary index, seeded from the real one so unchanged files
 * aren't hashed again, and `git add -A` stays out of the user's own index.
 * Git keeps the tree's objects, so a later `treeDelta()` can diff against it.
 *
 * Returns `undefined` when there's nothing to identify the tree with: not a
 * git repository, or a directory inside one, whose index covers more than
 * the tarball does. Callers then upload everything.
 */
export const workingTreeId = async (
  cwd: string,
): Promise<string | undefined> => {
  let scratch: string | undefined;

  try {
    const prefix = (await git(cwd, ["rev-parse", "--show-prefix"])).trim();

    if (prefix !== "") {
      return undefined;
    }

    const realIndex = (
      await git(cwd, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "index",
      ])
    ).trim();

    scratch = await mkdtemp(join(tmpdir(), "inngest-ci-index-"));

    const index = join(scratch, "index");

    try {
      await copyFile(realIndex, index);
    } catch {
      // No index yet, so everything is hashed.
    }

    const env = { GIT_INDEX_FILE: index };

    await git(cwd, ["add", "-A"], env);

    return (await git(cwd, ["write-tree"], env)).trim();
  } catch {
    return undefined;
  } finally {
    if (scratch) {
      await rm(scratch, { recursive: true, force: true });
    }
  }
};

/**
 * What changed from tree `from` to tree `to`, or `undefined` when it can't be
 * said: `from` isn't an object here (another machine's cache, or one git has
 * pruned), or git failed.
 *
 * Renames and copies are reported as the delete and the add they amount to,
 * so each path is handled alone.
 */
export const treeDelta = async (
  cwd: string,
  from: string,
  to: string,
): Promise<TreeDelta | undefined> => {
  try {
    await git(cwd, ["cat-file", "-e", `${from}^{tree}`]);

    const output = await git(cwd, [
      "diff",
      "--name-status",
      "-z",
      "--no-renames",
      from,
      to,
    ]);

    const parts = output.split("\0");
    const delta: TreeDelta = { changed: [], deleted: [] };

    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i] as string;
      const path = parts[i + 1] as string;

      if (status === "D") {
        delta.deleted.push(path);
      } else if (status === "A" || status === "M" || status === "T") {
        delta.changed.push(path);
      } else {
        return undefined;
      }
    }

    return delta;
  } catch {
    return undefined;
  }
};
