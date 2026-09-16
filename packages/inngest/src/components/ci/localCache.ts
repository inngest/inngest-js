import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { filterPaths, hash } from "./util.ts";

const exec = promisify(execFile);

/**
 * Hash the files matching a set of patterns in a local checkout.
 *
 * Tracked files use the blob SHA git already has. Modified and untracked files
 * are hashed from disk, so uncommitted work changes the key the same way a
 * commit would.
 */
export const hashLocalFiles = async (
  cwd: string,
  patterns: string[],
): Promise<string> => {
  const { stdout: staged } = await exec("git", ["ls-files", "-s"], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });

  const tracked = new Map<string, string>();

  for (const line of staged.split("\n").filter(Boolean)) {
    // "<mode> <sha> <stage>\t<path>"
    const [meta, path] = line.split("\t");
    const sha = meta?.split(" ")[1];
    if (path && sha) {
      tracked.set(path, sha);
    }
  }

  const { stdout: dirty } = await exec("git", ["status", "--porcelain"], {
    cwd,
  });

  const changed = new Set(
    dirty
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .map((path) => path.split(" -> ").pop() as string),
  );

  const candidates = [...new Set([...tracked.keys(), ...changed])];
  const matched = filterPaths(candidates, { include: patterns }).sort();

  const parts: string[] = [];

  for (const path of matched) {
    if (changed.has(path)) {
      try {
        const contents = await readFile(join(cwd, path));
        parts.push(`${path}:${hash(contents.toString("utf8"))}`);
      } catch {
        parts.push(`${path}:deleted`);
      }
      continue;
    }

    parts.push(`${path}:${tracked.get(path) ?? ""}`);
  }

  return hash(parts.join("\n"));
};
