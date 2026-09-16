import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { PullRequestAction } from "./triggers.ts";

const exec = promisify(execFile);

const git = async (args: string[], cwd: string): Promise<string> => {
  const { stdout } = await exec("git", args, { cwd });
  return stdout.trim();
};

const safeGit = async (
  args: string[],
  cwd: string,
  fallback = "",
): Promise<string> => {
  try {
    return await git(args, cwd);
  } catch {
    return fallback;
  }
};

/**
 * Work out `owner/name` from the `origin` remote, falling back to a local
 * placeholder so fixtures still work in a repo with no remote.
 */
const repoFullName = async (cwd: string, override?: string) => {
  if (override) {
    return override;
  }

  const url = await safeGit(["remote", "get-url", "origin"], cwd);
  const match = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);

  return match ? `${match[1]}/${match[2]}` : "local/repo";
};

interface FixtureBase {
  repo?: string;
  cwd?: string;
}

const repository = async (fullName: string) => {
  const [owner = "local", name = "repo"] = fullName.split("/");
  return {
    id: 1,
    name,
    full_name: fullName,
    private: false,
    owner: { login: owner, id: 1, type: "Organization" },
    default_branch: "main",
    html_url: `https://github.com/${fullName}`,
  };
};

const meta = (event: string) => ({
  _github: {
    event,
    delivery: `local-${Date.now()}`,
    installationId: process.env.GITHUB_INSTALLATION_ID
      ? Number(process.env.GITHUB_INSTALLATION_ID)
      : undefined,
  },
});

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Realistic GitHub event payloads built from the local git repository, so
 * pipelines can be run against the Dev Server without pushing anything.
 *
 * These are Node-only.
 */
export const fixtures = {
  /**
   * A pull request event for the current checkout.
   */
  pullRequest: async (
    opts: FixtureBase & {
      action?: PullRequestAction;
      base?: string;
      head?: string;
      number?: number;
    } = {},
  ): Promise<{ name: string; data: Record<string, unknown> }> => {
    const cwd = opts.cwd ?? process.cwd();
    const fullName = await repoFullName(cwd, opts.repo);
    const baseRef = opts.base ?? "main";

    const headSha = await safeGit(["rev-parse", "HEAD"], cwd, "0".repeat(40));
    const headRef =
      opts.head ??
      (await safeGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd, "local"));
    const baseSha =
      (await safeGit(["merge-base", "HEAD", `origin/${baseRef}`], cwd)) ||
      (await safeGit(["rev-parse", `${baseRef}`], cwd, headSha));

    const repo = await repository(fullName);
    const number = opts.number ?? 1;

    return {
      name: `github/pull_request.${opts.action ?? "opened"}`,
      data: {
        action: opts.action ?? "opened",
        number,
        pull_request: {
          number,
          state: "open",
          title: `Local run from ${headRef}`,
          html_url: `https://github.com/${fullName}/pull/${number}`,
          draft: false,
          head: { sha: headSha, ref: headRef, repo },
          base: { sha: baseSha, ref: baseRef, repo },
          user: { login: "local" },
        },
        repository: repo,
        sender: { login: "local" },
        local: { path: cwd, baseRef },
        ...meta("pull_request"),
      },
    };
  },

  /**
   * A push event for the current checkout.
   */
  push: async (
    opts: FixtureBase & { ref?: string } = {},
  ): Promise<{ name: string; data: Record<string, unknown> }> => {
    const cwd = opts.cwd ?? process.cwd();
    const fullName = await repoFullName(cwd, opts.repo);
    const branch =
      (await safeGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd, "main")) ||
      "main";
    const ref = opts.ref ?? `refs/heads/${branch}`;
    const after = await safeGit(["rev-parse", "HEAD"], cwd, "0".repeat(40));
    const before = await safeGit(["rev-parse", "HEAD~1"], cwd, after);
    const repo = await repository(fullName);

    return {
      name: "github/push",
      data: {
        ref,
        before,
        after,
        created: false,
        deleted: false,
        forced: false,
        repository: repo,
        pusher: { name: "local" },
        sender: { login: "local" },
        local: { path: cwd, baseRef: branch },
        ...meta("push"),
      },
    };
  },

  /**
   * An issue comment event, for slash-command pipelines.
   */
  comment: async (
    opts: FixtureBase & {
      body: string;
      number?: number;
      user?: string;
    },
  ): Promise<{ name: string; data: Record<string, unknown> }> => {
    const cwd = opts.cwd ?? process.cwd();
    const fullName = await repoFullName(cwd, opts.repo);
    const repo = await repository(fullName);
    const number = opts.number ?? 1;
    const branch =
      (await safeGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd, "main")) ||
      "main";

    return {
      name: "github/issue_comment.created",
      data: {
        action: "created",
        issue: {
          number,
          pull_request: {
            url: `https://api.github.com/repos/${fullName}/pulls/${number}`,
          },
        },
        comment: {
          id: 1,
          body: opts.body,
          user: { login: opts.user ?? "local" },
        },
        repository: repo,
        sender: { login: opts.user ?? "local" },
        local: { path: cwd, baseRef: branch },
        ...meta("issue_comment"),
      },
    };
  },
};
