/**
 * @module
 * Tests for `repo()` against real git: a first checkout, and bringing an
 * existing checkout (a restored or recycled sandbox) to a ref.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { DurableSandbox } from "../sandbox/types.ts";
import { repo } from "./repo.ts";

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

const git = (cwd: string, ...args: string[]): string => {
  return execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();
};

describe("repo checkout and sync", () => {
  let root: string;
  let origin: string;
  let seed: string;
  let work: string;

  // A sandbox whose commands really run, in this machine's shell.
  const sandbox = {
    commands: {
      run: async (
        _id: unknown,
        argv: string[],
        options: { environment?: Record<string, string> },
      ) => {
        const result = spawnSync(argv[0] as string, argv.slice(1), {
          encoding: "utf8",
          env: { ...env, ...options.environment },
        });

        return {
          exitCode: result.status ?? 1,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      },
    },
    tools: { code: () => ({}) },
  } as unknown as Pick<DurableSandbox, "commands" | "tools">;

  const checkout = (
    options: { ref?: string; sync?: "reset" | "keep" } = {},
  ) => {
    return repo(sandbox, { repo: origin, path: work, ...options });
  };

  // A new commit on the remote's main, made from the seed clone.
  const upstream = (file: string, text: string) => {
    writeFileSync(join(seed, file), text);
    git(seed, "add", ".");
    git(seed, "commit", "--quiet", "-m", `edit ${file}`);
    git(seed, "push", "--quiet", "origin", "main");

    return git(seed, "rev-parse", "HEAD");
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "repo-sync-"));
    origin = join(root, "origin.git");
    seed = join(root, "seed");
    work = join(root, "work");
    git(root, "init", "--quiet", "--bare", "-b", "main", origin);
    git(root, "clone", "--quiet", origin, seed);
    git(seed, "checkout", "--quiet", "-b", "main");
    upstream("a.txt", "one\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("clones into an empty path", async () => {
    const result = await checkout();

    expect(result.action).toBe("cloned");
    expect(result.sha).toBe(git(seed, "rev-parse", "HEAD"));
    expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("one\n");
  });

  test("reset brings an existing checkout to the remote, discarding local work", async () => {
    await checkout();
    writeFileSync(join(work, "a.txt"), "dirty\n");
    writeFileSync(join(work, "scratch.txt"), "untracked\n");
    git(work, "add", "a.txt");
    git(work, "commit", "--quiet", "-m", "local commit");
    const tip = upstream("b.txt", "two\n");

    const result = await checkout();

    expect(result).toMatchObject({ action: "synced", sha: tip });
    expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("one\n");
    expect(readFileSync(join(work, "b.txt"), "utf8")).toBe("two\n");
    expect(existsSync(join(work, "scratch.txt"))).toBe(false);
  });

  test("keep fast-forwards a clean branch and carries uncommitted changes", async () => {
    await checkout();
    writeFileSync(join(work, "notes.txt"), "mine\n");
    const tip = upstream("b.txt", "two\n");

    const result = await checkout({ sync: "keep" });

    expect(result).toMatchObject({ action: "synced", sha: tip });
    expect(readFileSync(join(work, "notes.txt"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(work, "b.txt"), "utf8")).toBe("two\n");
  });

  test("keep leaves a branch with local commits where it is", async () => {
    await checkout();
    writeFileSync(join(work, "c.txt"), "local\n");
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "local work");
    const local = git(work, "rev-parse", "HEAD");
    upstream("b.txt", "two\n");

    const result = await checkout({ sync: "keep" });

    expect(result.sha).toBe(local);
    expect(readFileSync(join(work, "c.txt"), "utf8")).toBe("local\n");
  });

  test("checks out a tag and a branch other than the default", async () => {
    const first = git(seed, "rev-parse", "HEAD");
    git(seed, "tag", "v1");
    git(seed, "push", "--quiet", "origin", "v1");
    git(seed, "checkout", "--quiet", "-b", "dev");
    writeFileSync(join(seed, "dev.txt"), "dev\n");
    git(seed, "add", ".");
    git(seed, "commit", "--quiet", "-m", "dev");
    git(seed, "push", "--quiet", "origin", "dev");
    const dev = git(seed, "rev-parse", "HEAD");

    await checkout();

    expect((await checkout({ ref: "dev" })).sha).toBe(dev);
    expect((await checkout({ ref: "v1" })).sha).toBe(first);
    expect((await checkout({ ref: "main" })).sha).toBe(first);
  });
});
