/**
 * Tests for the GitHub clone script: paths and refs are data, and fork pull
 * requests fetch their head.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { RepoContext } from "../types.ts";
import { cloneScript } from "./checkout.ts";

const git = (cwd: string, ...args: string[]): string => {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
};

const repoContext = (sha: string, fork = false): RepoContext => {
  return {
    owner: "o",
    name: "r",
    fullName: "o/r",
    sha,
    ...(fork ? { pullRequest: { number: 7, headRef: "feature", fork } } : {}),
  };
};

describe("cloneScript", () => {
  let root: string;
  let origin: string;
  let sha: string;

  const run = (script: string) => {
    return execFileSync("/bin/sh", ["-c", script], {
      cwd: root,
      env: { ...process.env, CI_REPO_URL: origin },
      encoding: "utf8",
    });
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ci-checkout-"));
    origin = join(root, "origin");

    mkdirSync(origin);

    git(origin, "init", "-q", "-b", "main");
    git(origin, "config", "user.email", "ci@example.com");
    git(origin, "config", "user.name", "ci");

    writeFileSync(join(origin, "a.txt"), "a");

    git(origin, "add", ".");
    git(origin, "commit", "-q", "-m", "init");

    sha = git(origin, "rev-parse", "HEAD");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("a path with spaces and shell syntax is only ever a path", () => {
    const marker = join(root, "pwned");
    const target = join(root, `my work $(touch ${marker}) ; touch ${marker}`);

    run(
      cloneScript({
        repo: repoContext(sha),
        opts: { history: "full" },
        target,
        sha,
      }),
    );

    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(target, "a.txt"), "utf8")).toBe("a");
  });

  test("a ref with shell syntax is only ever a ref", () => {
    const marker = join(root, "pwned");
    const ref = `${sha}; touch ${marker}`;

    expect(() => {
      run(
        cloneScript({
          repo: repoContext(sha),
          opts: { history: "full" },
          target: join(root, "work"),
          sha: ref,
        }),
      );
    }).toThrow();

    expect(existsSync(marker)).toBe(false);
  });

  test("a ref that git would read as an option is refused", () => {
    expect(() => {
      return cloneScript({
        repo: repoContext(sha),
        opts: { history: "full" },
        target: join(root, "work"),
        sha: "--upload-pack=touch /tmp/pwned",
      });
    }).toThrow("git would read as an option");
  });

  test("a fork pull request fetches the pull request head", () => {
    git(origin, "checkout", "-q", "-b", "other");
    writeFileSync(join(origin, "fork.txt"), "from a fork");
    git(origin, "add", ".");
    git(origin, "commit", "-q", "-m", "fork change");

    const forkSha = git(origin, "rev-parse", "HEAD");

    // GitHub keeps a fork's head under `refs/pull/<n>/head` and no branch.
    git(origin, "update-ref", "refs/pull/7/head", forkSha);
    git(origin, "checkout", "-q", "main");
    git(origin, "branch", "-q", "-D", "other");

    const target = join(root, "work");

    run(
      cloneScript({
        repo: repoContext(forkSha, true),
        opts: { history: "full" },
        target,
        sha: forkSha,
      }),
    );

    expect(git(target, "rev-parse", "HEAD")).toBe(forkSha);
  });

  test("a second run updates the existing checkout and keeps ignored files", () => {
    writeFileSync(join(origin, ".gitignore"), "node_modules\n");
    writeFileSync(join(origin, "b.txt"), "b");

    git(origin, "add", ".");
    git(origin, "commit", "-q", "-m", "second");

    const first = git(origin, "rev-parse", "HEAD");
    const target = join(root, "work");

    run(
      cloneScript({
        repo: repoContext(first),
        opts: { history: "full" },
        target,
        sha: first,
      }),
    );

    mkdirSync(join(target, "node_modules"));
    writeFileSync(join(target, "node_modules", "x"), "installed");

    writeFileSync(join(origin, "a.txt"), "changed");
    git(origin, "rm", "-q", "b.txt");
    git(origin, "add", ".");
    git(origin, "commit", "-q", "-m", "third");

    const second = git(origin, "rev-parse", "HEAD");

    run(
      cloneScript({
        repo: repoContext(second),
        opts: { history: "full" },
        target,
        sha: second,
      }),
    );

    expect(git(target, "rev-parse", "HEAD")).toBe(second);
    expect(readFileSync(join(target, "a.txt"), "utf8")).toBe("changed");
    expect(existsSync(join(target, "b.txt"))).toBe(false);
    expect(readFileSync(join(target, "node_modules", "x"), "utf8")).toBe(
      "installed",
    );
  });

  test("the remote ends up as the plain URL, after a clone and an update", () => {
    const target = join(root, "work");

    run(
      cloneScript({
        repo: repoContext(sha),
        opts: { history: "full" },
        target,
        sha,
      }),
    );

    expect(git(target, "remote", "get-url", "origin")).toBe(
      "https://github.com/o/r.git",
    );

    git(target, "remote", "set-url", "origin", "https://expired.invalid/o/r");

    run(
      cloneScript({
        repo: repoContext(sha),
        opts: {},
        target,
        sha,
      }),
    );

    expect(git(target, "remote", "get-url", "origin")).toBe(
      "https://github.com/o/r.git",
    );
  });

  test("a fork pull request update fetches the pull request head", () => {
    const target = join(root, "work");

    git(origin, "update-ref", "refs/pull/7/head", sha);

    run(
      cloneScript({
        repo: repoContext(sha, true),
        opts: { history: "full" },
        target,
        sha,
      }),
    );

    git(origin, "checkout", "-q", "-b", "other");
    writeFileSync(join(origin, "fork.txt"), "from a fork");
    git(origin, "add", ".");
    git(origin, "commit", "-q", "-m", "fork change");

    const forkSha = git(origin, "rev-parse", "HEAD");

    git(origin, "update-ref", "refs/pull/7/head", forkSha);
    git(origin, "checkout", "-q", "main");
    git(origin, "branch", "-q", "-D", "other");

    run(
      cloneScript({
        repo: repoContext(forkSha, true),
        opts: { history: "full" },
        target,
        sha: forkSha,
      }),
    );

    expect(git(target, "rev-parse", "HEAD")).toBe(forkSha);
    expect(readFileSync(join(target, "fork.txt"), "utf8")).toBe("from a fork");
  });
});
