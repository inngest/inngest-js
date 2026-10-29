/**
 * @module
 * Tests for `repo()` against real git: a first checkout, and bringing an
 * existing checkout (a restored or recycled sandbox) to a ref.
 */
import { execFile, execFileSync, spawnSync } from "node:child_process";
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
import {
  backendPath,
  startGitRemote,
} from "../sandbox/git-fixtures/test-helpers.ts";
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

  test("config and hooks planted in the checkout neither redirect the fetch nor run", async () => {
    const { chmodSync } = await import("node:fs");
    await checkout();
    const stolen = join(root, "stolen.txt");
    const evil = join(root, "evil.git");

    git(root, "init", "--quiet", "--bare", "-b", "main", evil);
    for (const hook of [
      "post-checkout",
      "post-merge",
      "reference-transaction",
    ]) {
      const path = join(work, ".git", "hooks", hook);

      writeFileSync(path, `#!/bin/sh\nenv >> "${stolen}"\n`);
      chmodSync(path, 0o755);
    }
    // A rewrite rule, a first URL that is not the real one, and an include.
    git(work, "config", `url.${evil}.insteadOf`, origin);
    git(work, "config", "--replace-all", "remote.origin.url", evil);
    git(work, "config", "--add", "remote.origin.url", origin);
    writeFileSync(
      join(root, "extra.config"),
      `[url "${evil}"]\n\tinsteadOf = ${origin}\n`,
    );
    git(work, "config", "include.path", join(root, "extra.config"));
    const tip = upstream("b.txt", "two\n");

    const result = await repo(sandbox, {
      repo: origin,
      path: work,
      token: "ghs_secret_token_value",
    });

    expect(result).toMatchObject({ action: "synced", sha: tip });
    expect(existsSync(stolen)).toBe(false);
    expect(readFileSync(join(work, ".git", "config"), "utf8")).not.toContain(
      "ghs_secret_token_value",
    );
  });

  test("a repo that starts with a dash is refused", async () => {
    await expect(
      repo(sandbox, { repo: "--upload-pack=x", path: work }),
    ).rejects.toThrow(/can't start with/);
  });

  test("a push goes to the repo's URL, whatever the checkout's config says", async () => {
    const checkoutOf = await checkout();
    const elsewhere = join(root, "elsewhere.git");
    git(root, "init", "--quiet", "--bare", "-b", "main", elsewhere);

    git(work, "checkout", "--quiet", "-b", "agent/fix");
    writeFileSync(join(work, "fix.txt"), "fix\n");
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "fix");
    // The model plants a push URL and a rewrite rule after the checkout.
    git(work, "config", "remote.origin.pushurl", elsewhere);
    git(work, "config", `url.${elsewhere}.pushInsteadOf`, origin);

    await checkoutOf.push("agent/fix");

    expect(git(origin, "rev-parse", "refs/heads/agent/fix")).toHaveLength(40);
    expect(
      spawnSync("git", ["-C", elsewhere, "rev-parse", "agent/fix"]).status,
    ).not.toBe(0);
  });

  test("keep fails rather than overwrite local changes", async () => {
    await checkout();
    writeFileSync(join(work, "a.txt"), "local edit\n");
    git(seed, "pull", "--quiet", "origin", "main");
    writeFileSync(join(seed, "a.txt"), "remote edit\n");
    git(seed, "commit", "--quiet", "-am", "edit a");
    git(seed, "push", "--quiet", "origin", "main");
    git(seed, "checkout", "--quiet", "-b", "other");
    writeFileSync(join(seed, "a.txt"), "other edit\n");
    git(seed, "commit", "--quiet", "-am", "other");
    git(seed, "push", "--quiet", "origin", "other");

    await expect(checkout({ ref: "other", sync: "keep" })).rejects.toThrow(
      /overwritten/,
    );
    expect(git(work, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("local edit\n");
  });

  test("reset keeps files the remote's .gitignore ignores", async () => {
    writeFileSync(join(seed, ".gitignore"), "cache/\n");
    upstream(".gitignore", "cache/\n");
    await checkout();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(work, "cache"));
    writeFileSync(join(work, "cache", "x"), "x");
    upstream("b.txt", "two\n");

    await checkout();

    expect(existsSync(join(work, "cache", "x"))).toBe(true);
  });

  test("a branch and a tag with the same name sync", async () => {
    git(seed, "tag", "same");
    git(seed, "push", "--quiet", "origin", "refs/tags/same");
    git(seed, "checkout", "--quiet", "-b", "same");
    writeFileSync(join(seed, "s.txt"), "s\n");
    git(seed, "add", ".");
    git(seed, "commit", "--quiet", "-m", "branch same");
    git(seed, "push", "--quiet", "origin", "refs/heads/same");
    const branch = git(seed, "rev-parse", "HEAD");
    expect((await checkout({ ref: "same" })).sha).toBe(branch);
    expect((await checkout({ ref: "same" })).sha).toBe(branch);
  });

  test("ref HEAD means the default branch, on a clone and on a sync", async () => {
    const tip = git(seed, "rev-parse", "HEAD");

    expect((await checkout({ ref: "HEAD" })).sha).toBe(tip);
    expect(await checkout({ ref: "HEAD" })).toMatchObject({
      action: "synced",
      sha: tip,
    });
    expect((await checkout({ ref: "HEAD", sync: "keep" })).sha).toBe(tip);
    // The default branch, not a branch named HEAD.
    expect(git(work, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(work, "branch", "--list", "HEAD")).toBe("");
  });

  test("keep resumes a branch of the agent's own that the remote lacks, reset refuses it", async () => {
    await checkout();
    git(work, "checkout", "--quiet", "-b", "mine");
    writeFileSync(join(work, "mine.txt"), "mine\n");
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "mine");
    const mine = git(work, "rev-parse", "HEAD");
    git(work, "checkout", "--quiet", "main");

    expect((await checkout({ ref: "mine", sync: "keep" })).sha).toBe(mine);
    expect(git(work, "rev-parse", "--abbrev-ref", "HEAD")).toBe("mine");
    await expect(checkout({ ref: "mine" })).rejects.toThrow(
      /is not a branch, tag or commit of/,
    );
  });

  test("a clone refuses a ref the sync would refuse", async () => {
    await expect(checkout({ ref: "origin/main" })).rejects.toThrow(
      /is not a branch, tag or commit of/,
    );
  });

  test("keep does not overwrite a tag the agent made", async () => {
    await checkout();
    git(work, "tag", "mine-tag");
    const local = git(work, "rev-parse", "mine-tag");
    git(seed, "tag", "mine-tag");
    upstream("b.txt", "two\n");
    git(seed, "tag", "-f", "mine-tag");
    git(seed, "push", "--quiet", "origin", "refs/tags/mine-tag");

    await checkout({ sync: "keep" });

    expect(git(work, "rev-parse", "mine-tag")).toBe(local);
  });

  test("a branch deleted on the remote is gone after a sync", async () => {
    git(seed, "checkout", "--quiet", "-b", "feat");
    writeFileSync(join(seed, "f.txt"), "f\n");
    git(seed, "add", ".");
    git(seed, "commit", "--quiet", "-m", "feat");
    git(seed, "push", "--quiet", "origin", "feat");
    await checkout({ ref: "feat" });
    git(seed, "push", "--quiet", "origin", "--delete", "feat");

    await expect(checkout({ ref: "feat" })).rejects.toThrow(
      /is not a branch, tag or commit of/,
    );
    expect(
      spawnSync("git", [
        "-C",
        work,
        "rev-parse",
        "--verify",
        "--quiet",
        "origin/feat",
      ]).status,
    ).not.toBe(0);
  });

  test("a checkout repointed to another repository forgets the old one's branches", async () => {
    git(seed, "checkout", "--quiet", "-b", "only-here");
    git(seed, "push", "--quiet", "origin", "only-here");
    await checkout({ ref: "only-here" });
    const other = join(root, "other.git");
    git(root, "init", "--quiet", "--bare", "-b", "main", other);
    git(seed, "push", "--quiet", other, "main");

    await expect(
      repo(sandbox, { repo: other, path: work, ref: "only-here" }),
    ).rejects.toThrow(/is not a branch, tag or commit of/);
  });

  test("reset removes untracked directories", async () => {
    await checkout();
    writeFileSync(join(work, ".gitignore"), "cache/\n");
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "ignore");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(work, "cache"));
    writeFileSync(join(work, "cache", "x"), "x");
    mkdirSync(join(work, "scratch"));
    writeFileSync(join(work, "scratch", "y"), "y");

    await checkout();

    expect(existsSync(join(work, "scratch"))).toBe(false);
    // The ignore rule was in a commit the reset discarded, so cache is untracked.
    expect(existsSync(join(work, "cache", "x"))).toBe(false);
  });
});

describe.skipIf(!backendPath)("repo with a token over HTTP", () => {
  test("clones, syncs and pushes with the header, which no file keeps", async () => {
    const token = "ghs_http_token_value";
    const remote = await startGitRemote(token);
    const root = mkdtempSync(join(tmpdir(), "repo-http-"));
    const work = join(root, "work");
    const sandbox = {
      commands: {
        // Async, since the remote is served from this same process.
        run: async (
          _id: unknown,
          argv: string[],
          options: { environment?: Record<string, string> },
        ) => {
          return new Promise<{
            exitCode: number;
            stdout: string;
            stderr: string;
          }>((resolve) => {
            execFile(
              argv[0] as string,
              argv.slice(1),
              { encoding: "utf8", env: { ...env, ...options.environment } },
              (error, stdout, stderr) => {
                resolve({
                  exitCode: error
                    ? typeof error.code === "number"
                      ? error.code
                      : 1
                    : 0,
                  stdout,
                  stderr,
                });
              },
            );
          });
        },
      },
      tools: { code: () => ({}) },
    } as unknown as Pick<DurableSandbox, "commands" | "tools">;

    try {
      const cloned = await repo(sandbox, {
        repo: remote.url,
        path: work,
        token,
      });
      expect(cloned.action).toBe("cloned");

      git(work, "checkout", "--quiet", "-b", "agent/http");
      writeFileSync(join(work, "new.txt"), "new\n");
      git(work, "add", ".");
      git(work, "commit", "--quiet", "-m", "new");
      await cloned.push("agent/http");

      expect(
        git(remote.dir, "rev-parse", "refs/heads/agent/http"),
      ).toHaveLength(40);

      const synced = await repo(sandbox, {
        repo: remote.url,
        path: work,
        token,
        sync: "keep",
      });
      expect(synced.action).toBe("synced");
      expect(readFileSync(join(work, ".git", "config"), "utf8")).not.toContain(
        token,
      );
      expect(remote.seen.some((header) => header !== "")).toBe(true);
    } finally {
      await remote.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
