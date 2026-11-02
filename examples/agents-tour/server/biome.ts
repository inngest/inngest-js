/**
 * @module
 * Formats code with the repo's own Biome, so what the reader's editor writes
 * is what the repo's formatter would write, and lesson files committed to the
 * repo never change on Run.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const findBiome = (from: string) => {
  let dir = from;

  for (;;) {
    const candidate = join(dir, "node_modules", ".bin", "biome");

    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(dir);

    if (parent === dir) {
      throw new Error("Biome is not installed: run pnpm install in the repo");
    }

    dir = parent;
  }
};

export interface Formatted {
  content: string;
  // False when Biome could not format the code, such as a syntax error;
  // `content` is then the code as given.
  ok: boolean;
}

/**
 * Formats `content` as the file `name`, in the project at `root`.
 */
export const formatWithBiome = (
  root: string,
  name: string,
  content: string,
) => {
  return new Promise<Formatted>((resolve, reject) => {
    const child = spawn(
      findBiome(root),
      ["format", `--stdin-file-path=${name}`],
      { cwd: root, stdio: ["pipe", "pipe", "ignore"] },
    );
    const out: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => {
      out.push(chunk);
    });

    child.on("error", reject);

    child.on("close", (code) => {
      resolve(
        code === 0
          ? { content: Buffer.concat(out).toString("utf8"), ok: true }
          : { content, ok: false },
      );
    });

    child.stdin.end(content);
  });
};
