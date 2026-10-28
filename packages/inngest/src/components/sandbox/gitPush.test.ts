/**
 * @module
 * Tests for `pushBundle()` against a git remote that serves only a token.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  backendPath,
  type GitRemote,
  git,
  startGitRemote,
} from "./git-fixtures/test-helpers.ts";
import {
  assertHostGit,
  type GitPolicy,
  gitAuth,
  isPushableRef,
  pushBundle,
} from "./gitPush.ts";

const token = "ghs_secret_token_value";

describe.skipIf(!backendPath)("pushBundle", { timeout: 60_000 }, () => {
  let remote: GitRemote;
  let work: string;

  beforeEach(async () => {
    remote = await startGitRemote(token);
    work = mkdtempSync(join(tmpdir(), "git-push-work-"));
    git(work, "clone", "--quiet", remote.dir, ".");
  });

  afterEach(async () => {
    await remote.close();
    rmSync(work, { recursive: true, force: true });
  });

  const commit = (branch: string, file: string, text: string) => {
    git(work, "checkout", "--quiet", "-B", branch, "origin/main");
    writeFileSync(join(work, file), text);
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", `edit ${file}`);
  };

  const push = async (branch: string, policy?: GitPolicy) => {
    const ref = `refs/heads/${branch}`;
    const path = join(work, "out.bundle");
    git(work, "bundle", "create", "--quiet", path, ref);
    const { readFileSync } = await import("node:fs");

    return pushBundle({
      remote: remote.url,
      auth: await gitAuth(() => {
        return token;
      }),
      bundle: new Uint8Array(readFileSync(path)),
      targets: [{ src: ref, dst: ref }],
      policy,
    });
  };

  test("pushes a new branch and shows the policy what it changes", async () => {
    commit("agent/fix", "src/b.ts", "export const b = 2;\n");
    let seen: unknown;
    const outcome = await push("agent/fix", async (change) => {
      seen = {
        branch: change.branch,
        paths: change.paths,
        subjects: change.commits.map((c) => {
          return c.subject;
        }),
        patch: await change.patch(),
      };
    });

    expect(outcome).toMatchObject({
      pushed: [{ ref: "refs/heads/agent/fix", status: "pushed", asked: true }],
    });
    expect(seen).toMatchObject({
      branch: "agent/fix",
      paths: ["src/b.ts"],
      subjects: ["edit src/b.ts"],
    });
    expect((seen as { patch: string }).patch).toContain("export const b = 2;");
    expect(git(remote.dir, "rev-parse", "refs/heads/agent/fix")).toHaveLength(
      40,
    );
  });

  test("a refusal pushes nothing", async () => {
    commit("main", "src/a.ts", "export const a = 2;\n");
    const before = git(remote.dir, "rev-parse", "main");
    const outcome = await push("main", (change) => {
      return change.branch === "main" ? { refuse: "no main" } : undefined;
    });

    expect(outcome).toEqual({ refused: "no main" });
    expect(git(remote.dir, "rev-parse", "main")).toBe(before);
  });

  test("a policy can redirect to another ref", async () => {
    commit("agent/x", "src/c.ts", "c\n");
    const outcome = await push("agent/x", () => {
      return { ref: "refs/heads/agent/y" };
    });

    expect(outcome).toMatchObject({
      pushed: [{ ref: "refs/heads/agent/y", asked: false }],
    });
    expect(git(remote.dir, "rev-parse", "refs/heads/agent/y")).toHaveLength(40);
  });

  test("never sends a push that is not a fast-forward", async () => {
    commit("main", "src/a.ts", "export const a = 2;\n");
    git(work, "reset", "--quiet", "--hard", "HEAD~1");
    writeFileSync(join(work, "other.txt"), "x\n");
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "diverge");
    const before = git(remote.dir, "rev-parse", "main");
    // The remote moves first.
    const other = mkdtempSync(join(tmpdir(), "git-push-other-"));
    git(other, "clone", "--quiet", remote.dir, ".");
    writeFileSync(join(other, "z.txt"), "z\n");
    git(other, "add", ".");
    git(other, "commit", "--quiet", "-m", "ahead");
    git(other, "push", "--quiet", remote.dir, "main");
    rmSync(other, { recursive: true, force: true });

    const outcome = await push("main");

    expect(outcome).toMatchObject({
      pushed: [{ status: "non-fast-forward" }],
    });
    expect(git(remote.dir, "rev-parse", "main")).not.toBe(before);
    expect(git(remote.dir, "log", "--format=%s", "main")).not.toContain(
      "diverge",
    );
  });

  test("a wrong token fails without printing it", async () => {
    commit("agent/fix", "src/b.ts", "b\n");
    const ref = "refs/heads/agent/fix";
    const path = join(work, "out.bundle");
    git(work, "bundle", "create", "--quiet", path, ref);
    const { readFileSync } = await import("node:fs");
    const bad = pushBundle({
      remote: remote.url,
      auth: await gitAuth(() => {
        return "wrong_token_value";
      }),
      bundle: new Uint8Array(readFileSync(path)),
      targets: [{ src: ref, dst: ref }],
    });

    await expect(bad).rejects.toThrow(/listing the remote failed/);
    await expect(bad).rejects.not.toThrow(/wrong_token_value/);
  });
});

describe("isPushableRef", () => {
  test("accepts full branch and tag names and rejects the rest", () => {
    expect(isPushableRef("refs/heads/agent/fix-1")).toBe(true);
    expect(isPushableRef("refs/tags/v1.0")).toBe(true);
    expect(isPushableRef("agent/fix")).toBe(false);
    expect(isPushableRef("refs/heads/a..b")).toBe(false);
    expect(isPushableRef("refs/heads/a b")).toBe(false);
    expect(isPushableRef("refs/heads/")).toBe(false);
    expect(isPushableRef("refs/heads/-x")).toBe(false);
    expect(isPushableRef("refs/heads/a/-x")).toBe(false);
  });
});

describe("assertHostGit", () => {
  test("passes when the host has git", async () => {
    await expect(assertHostGit()).resolves.toBeUndefined();
  });
});
