/**
 * Tests for reading the deployed repository from host variables and git.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { gitRepo, hostRepo, parseGitHubUrl } from "./deployRepo.ts";

const sha = "a".repeat(40);

describe("hostRepo", () => {
  test.each([
    [
      "Vercel",
      {
        VERCEL_GIT_REPO_OWNER: "acme",
        VERCEL_GIT_REPO_SLUG: "platform",
        VERCEL_GIT_COMMIT_SHA: sha,
        VERCEL_GIT_COMMIT_REF: "main",
      },
    ],
    [
      "Netlify",
      {
        REPOSITORY_URL: "https://github.com/acme/platform",
        COMMIT_REF: sha,
        BRANCH: "main",
      },
    ],
    [
      "Render",
      {
        RENDER_GIT_REPO_SLUG: "acme/platform",
        RENDER_GIT_COMMIT: sha,
        RENDER_GIT_BRANCH: "main",
      },
    ],
    [
      "Railway",
      {
        RAILWAY_GIT_REPO_OWNER: "acme",
        RAILWAY_GIT_REPO_NAME: "platform",
        RAILWAY_GIT_COMMIT_SHA: sha,
        RAILWAY_GIT_BRANCH: "main",
      },
    ],
    [
      "GitHub Actions",
      {
        GITHUB_REPOSITORY: "acme/platform",
        GITHUB_SHA: sha,
        GITHUB_REF: "refs/heads/main",
        GITHUB_REF_NAME: "main",
      },
    ],
  ])("reads %s", (_host, env) => {
    expect(hostRepo(env)).toEqual({
      owner: "acme",
      name: "platform",
      fullName: "acme/platform",
      sha,
      ref: "refs/heads/main",
      baseRef: "main",
    });
  });

  test("a tag build on GitHub Actions has no branch", () => {
    expect(
      hostRepo({
        GITHUB_REPOSITORY: "acme/platform",
        GITHUB_SHA: sha,
        GITHUB_REF: "refs/tags/v1",
        GITHUB_REF_NAME: "v1",
      }),
    ).toEqual({
      owner: "acme",
      name: "platform",
      fullName: "acme/platform",
      sha,
    });
  });

  test.each([
    ["nothing", {}],
    ["a repo without a commit", { RENDER_GIT_REPO_SLUG: "acme/platform" }],
    [
      "a commit that isn't a full sha",
      { RENDER_GIT_REPO_SLUG: "acme/platform", RENDER_GIT_COMMIT: "abc123" },
    ],
    [
      "a repo that isn't owner/name",
      { RENDER_GIT_REPO_SLUG: "acme/platform/x", RENDER_GIT_COMMIT: sha },
    ],
    [
      "a remote that isn't GitHub",
      { REPOSITORY_URL: "https://gitlab.com/acme/platform", COMMIT_REF: sha },
    ],
  ])("%s is no repo", (_label, env) => {
    expect(hostRepo(env)).toBeUndefined();
  });
});

describe("parseGitHubUrl", () => {
  test.each([
    ["https://github.com/acme/platform", "acme/platform"],
    ["https://github.com/acme/platform.git", "acme/platform"],
    ["git@github.com:acme/platform.git", "acme/platform"],
    ["ssh://git@github.com/acme/platform.git", "acme/platform"],
    ["https://github.com/acme", undefined],
    ["https://evil.example/github.com/acme/platform", undefined],
    [undefined, undefined],
  ])("%s is %s", (url, expected) => {
    expect(parseGitHubUrl(url)).toBe(expected);
  });
});

describe("gitRepo", () => {
  test("reads the origin remote and HEAD of a checkout", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-deploy-repo-"));

    try {
      const git = (...args: string[]) => {
        return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
      };

      git("init", "-q", "-b", "main");
      git("config", "user.email", "ci@example.com");
      git("config", "user.name", "CI");
      git("remote", "add", "origin", "git@github.com:acme/platform.git");

      writeFileSync(join(dir, "a.txt"), "a");

      git("add", "a.txt");
      git("commit", "-q", "-m", "init");

      expect(gitRepo(dir)).toEqual({
        owner: "acme",
        name: "platform",
        fullName: "acme/platform",
        sha: git("rev-parse", "HEAD"),
        ref: "refs/heads/main",
        baseRef: "main",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("outside a checkout is no repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-deploy-repo-"));

    try {
      expect(gitRepo(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
