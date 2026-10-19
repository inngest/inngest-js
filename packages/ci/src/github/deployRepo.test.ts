/**
 * Tests for finding the repository and commit an app was deployed from.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { deployedRepo } from "./deployRepo.ts";

const sha = "a".repeat(40);

/** A directory that isn't inside any git checkout. */
const nowhere = mkdtempSync(join(tmpdir(), "deploy-repo-"));

describe("deployedRepo", () => {
  test.each([
    {
      name: "Vercel",
      env: {
        VERCEL_GIT_REPO_OWNER: "acme",
        VERCEL_GIT_REPO_SLUG: "platform",
        VERCEL_GIT_COMMIT_SHA: sha.toUpperCase(),
        VERCEL_GIT_COMMIT_REF: "main",
      },
    },
    {
      name: "GitHub Actions",
      env: {
        GITHUB_REPOSITORY: "acme/platform",
        GITHUB_SHA: sha,
        GITHUB_REF_NAME: "main",
      },
    },
  ])("reads the repository and commit $name gives", ({ env }) => {
    expect(deployedRepo(env, nowhere)).toEqual({
      owner: "acme",
      name: "platform",
      fullName: "acme/platform",
      sha,
      ref: "refs/heads/main",
      baseRef: "main",
    });
  });

  test.each([
    { name: "a variable is missing", env: { GITHUB_REPOSITORY: "acme/x" } },
    {
      name: "the commit isn't a full sha",
      env: { GITHUB_REPOSITORY: "acme/x", GITHUB_SHA: "abc123" },
    },
    {
      name: "the repository isn't owner/name",
      env: { GITHUB_REPOSITORY: "acme", GITHUB_SHA: sha },
    },
  ])("finds nothing when $name", ({ env }) => {
    expect(deployedRepo(env, nowhere)).toBeUndefined();
  });

  test.each([
    "https://github.com/acme/platform.git",
    "git@github.com:acme/platform.git",
    "ssh://git@github.com/acme/platform",
  ])("falls back to the checkout's remote %s", (remote) => {
    const dir = mkdtempSync(join(tmpdir(), "deploy-repo-git-"));

    const git = (...args: string[]) => {
      return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    };

    git("init", "-q", "-b", "main");
    git("remote", "add", "origin", remote);

    git(
      "-c",
      "user.email=ci@example.com",
      "-c",
      "user.name=ci",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    );

    expect(deployedRepo({}, dir)).toEqual({
      owner: "acme",
      name: "platform",
      fullName: "acme/platform",
      sha: git("rev-parse", "HEAD"),
      ref: "refs/heads/main",
      baseRef: "main",
    });
  });
});
