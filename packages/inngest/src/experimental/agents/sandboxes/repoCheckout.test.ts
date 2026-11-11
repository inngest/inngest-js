/**
 * @module
 * Tests for the checkout a sandbox's `repo` does when it starts, against real
 * git: a first clone, a checkout left alone on resume, and a ref change.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { DurableSandbox } from "../../../components/sandbox/types.ts";
import { checkoutRepo } from "./repo.ts";

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

describe("checkoutRepo", () => {
  let root: string;
  let origin: string;
  let seed: string;
  let work: string;
  let seen: { environment: Record<string, string>; script: string }[];

  // A sandbox whose commands really run, in this machine's shell.
  const sandbox = {
    commands: {
      run: async (
        _id: unknown,
        argv: string[],
        options: { environment?: Record<string, string> },
      ) => {
        seen.push({
          environment: options.environment ?? {},
          script: argv.at(-1) ?? "",
        });

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
  } as unknown as Pick<DurableSandbox, "commands">;

  const checkout = (
    config: {
      ref?: string;
      author?: { name: string; email: string };
    } = {},
    token: string | null = null,
  ) => {
    return checkoutRepo(
      sandbox,
      { url: origin, path: work, ...config },
      async () => {
        return token;
      },
    );
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
    root = mkdtempSync(join(tmpdir(), "repo-checkout-"));
    origin = join(root, "origin.git");
    seed = join(root, "seed");
    work = join(root, "work");
    seen = [];
    git(root, "init", "--quiet", "--bare", "-b", "main", origin);
    git(root, "clone", "--quiet", origin, seed);
    git(seed, "checkout", "--quiet", "-b", "main");
    upstream("a.txt", "one\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("clones into an empty path and authors commits as inngest-agent", async () => {
    const result = await checkout();

    expect(result.action).toBe("cloned");
    expect(result.sha).toBe(git(seed, "rev-parse", "HEAD"));
    expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("one\n");
    expect(git(work, "config", "user.name")).toBe("inngest-agent");
  });

  test("the author option replaces the default", async () => {
    await checkout({ author: { name: "Bot", email: "bot@example.com" } });

    expect(git(work, "config", "user.name")).toBe("Bot");
    expect(git(work, "config", "user.email")).toBe("bot@example.com");
  });

  test("the read token reaches only the environment of the checkout command", async () => {
    await checkout({}, "ghs_read_token");

    expect(seen[0]?.environment.GIT_TOKEN).toBe("ghs_read_token");
    expect(seen[0]?.script).not.toContain("ghs_read_token");
    expect(readFileSync(join(work, ".git", "config"), "utf8")).not.toContain(
      "ghs_read_token",
    );
  });

  test("an existing checkout on the same ref is left alone, work and all", async () => {
    await checkout();
    writeFileSync(join(work, "notes.txt"), "mine\n");
    writeFileSync(join(work, "a.txt"), "edited\n");
    upstream("b.txt", "two\n");

    const result = await checkout({ ref: "main" });

    expect(result.action).toBe("kept");
    expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("edited\n");
    expect(readFileSync(join(work, "notes.txt"), "utf8")).toBe("mine\n");
  });

  test("a different ref is fetched and checked out", async () => {
    await checkout();
    git(seed, "checkout", "--quiet", "-b", "feature");
    writeFileSync(join(seed, "f.txt"), "feature\n");
    git(seed, "add", ".");
    git(seed, "commit", "--quiet", "-m", "feature");
    git(seed, "push", "--quiet", "origin", "feature");

    const result = await checkout({ ref: "feature" });

    expect(result.action).toBe("switched");
    expect(readFileSync(join(work, "f.txt"), "utf8")).toBe("feature\n");
    expect(git(work, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
  });

  test("an uncommitted change to a tracked file makes a ref change an error", async () => {
    await checkout();
    git(seed, "checkout", "--quiet", "-b", "feature");
    git(seed, "commit", "--quiet", "--allow-empty", "-m", "feature");
    git(seed, "push", "--quiet", "origin", "feature");
    writeFileSync(join(work, "a.txt"), "edited\n");

    await expect(checkout({ ref: "feature" })).rejects.toThrow(/uncommitted/);
    expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("edited\n");
  });

  test("an untracked file does not block a ref change", async () => {
    await checkout();
    git(seed, "checkout", "--quiet", "-b", "feature");
    git(seed, "commit", "--quiet", "--allow-empty", "-m", "feature");
    git(seed, "push", "--quiet", "origin", "feature");
    writeFileSync(join(work, "scratch.txt"), "untracked\n");

    const result = await checkout({ ref: "feature" });

    expect(result.action).toBe("switched");
    expect(readFileSync(join(work, "scratch.txt"), "utf8")).toBe("untracked\n");
  });

  test("a branch name and its commit sha count as the same ref", async () => {
    await checkout();

    const sha = git(work, "rev-parse", "HEAD");
    const result = await checkout({ ref: sha });

    expect(result.action).toBe("kept");
  });
});
