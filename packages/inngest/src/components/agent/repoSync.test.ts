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

  test("a moved tag does not break the next sync", async () => {
    git(seed, "tag", "latest");
    git(seed, "push", "--quiet", "origin", "latest");
    await checkout({ ref: "latest" });

    const tip = upstream("b.txt", "two\n");
    git(seed, "tag", "-f", "latest");
    git(seed, "push", "--quiet", "--force", "origin", "latest");

    expect(await checkout({ ref: "latest" })).toMatchObject({
      action: "synced",
      sha: tip,
    });
  });

  test("keep checks out a tag, and makes a branch the checkout lacks", async () => {
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

    expect((await checkout({ ref: "dev", sync: "keep" })).sha).toBe(dev);
    expect(git(work, "rev-parse", "--abbrev-ref", "HEAD")).toBe("dev");
    expect((await checkout({ ref: "v1", sync: "keep" })).sha).toBe(first);
  });

  test("keep carries a modified tracked file along", async () => {
    await checkout();
    writeFileSync(join(work, "a.txt"), "changed\n");
    const tip = upstream("b.txt", "two\n");

    expect(await checkout({ sync: "keep" })).toMatchObject({ sha: tip });
    expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("changed\n");
  });

  test("keep moves commits only a detached HEAD held onto a branch", async () => {
    await checkout();
    git(work, "checkout", "--quiet", "--detach");
    writeFileSync(join(work, "d.txt"), "detached\n");
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "detached work");
    const stranded = git(work, "rev-parse", "HEAD");

    await checkout({ sync: "keep" });

    const branches = git(work, "branch", "--contains", stranded);

    expect(branches).toContain("detached-");
  });

  test("keep refuses a checkout of another repository, reset repoints it", async () => {
    await checkout();
    const other = join(root, "other.git");
    git(root, "init", "--quiet", "--bare", "-b", "main", other);
    git(seed, "push", "--quiet", other, "main");

    await expect(
      repo(sandbox, { repo: other, path: work, sync: "keep" }),
    ).rejects.toThrow(/not .*other\.git/);

    const result = await repo(sandbox, { repo: other, path: work });

    expect(result.action).toBe("synced");
    expect(git(work, "remote", "get-url", "origin")).toBe(other);
  });

  test("rejects a sync mode or a ref it does not understand", async () => {
    await expect(
      repo(sandbox, { repo: origin, path: work, sync: "Keep" as "keep" }),
    ).rejects.toThrow(/reset" or "keep/);
    await expect(
      repo(sandbox, { repo: origin, path: work, ref: "--force" }),
    ).rejects.toThrow(/can't start with/);
  });

  test("a hook or an insteadOf rule planted in the checkout cannot reach the token", async () => {
    const { chmodSync } = await import("node:fs");
    await checkout();
    const stolen = join(root, "stolen.txt");

    for (const hook of [
      "post-checkout",
      "post-merge",
      "reference-transaction",
    ]) {
      const path = join(work, ".git", "hooks", hook);

      writeFileSync(path, `#!/bin/sh\nenv >> "${stolen}"\n`);
      chmodSync(path, 0o755);
    }
    git(work, "config", `url.http://127.0.0.1:1/.insteadOf`, origin);
    upstream("b.txt", "two\n");

    const result = await repo(sandbox, {
      repo: origin,
      path: work,
      token: "ghs_secret_token_value",
    });

    expect(result.action).toBe("synced");
    expect(existsSync(stolen)).toBe(false);
    expect(readFileSync(join(work, ".git", "config"), "utf8")).not.toContain(
      "insteadOf",
    );
    expect(readFileSync(join(work, ".git", "config"), "utf8")).not.toContain(
      "ghs_secret_token_value",
    );
  });

  test("a repo that starts with a dash is refused", async () => {
    await expect(
      repo(sandbox, { repo: "--upload-pack=x", path: work }),
    ).rejects.toThrow(/can't start with/);
  });
});
