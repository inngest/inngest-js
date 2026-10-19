/**
 * Which repository and commit this app was deployed from. A build another
 * app asks for has no GitHub event of its own, so what it checks out and
 * hashes comes from the deployment: the host's variables, or locally, the
 * working directory's git remote and `HEAD`.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import type { RepoContext } from "../types.ts";

/** Environment variables, as `process.env` has them. */
type Env = Record<string, string | undefined>;

/** What a host or git says about a deployment: `owner/name`, commit and branch. */
interface Deployed {
  fullName?: string;
  sha?: string;
  branch?: string;
}

/** How each host says where it deployed from. A new host is a new row. */
const hosts: ((env: Env) => Deployed)[] = [
  (env) => {
    return {
      fullName:
        env.VERCEL_GIT_REPO_OWNER && env.VERCEL_GIT_REPO_SLUG
          ? `${env.VERCEL_GIT_REPO_OWNER}/${env.VERCEL_GIT_REPO_SLUG}`
          : undefined,
      sha: env.VERCEL_GIT_COMMIT_SHA,
      branch: env.VERCEL_GIT_COMMIT_REF,
    };
  },
  (env) => {
    return {
      fullName: env.GITHUB_REPOSITORY,
      sha: env.GITHUB_SHA,
      branch: env.GITHUB_REF_NAME,
    };
  },
];

/**
 * The `owner/name` of a GitHub remote URL, as `https://github.com/o/n`,
 * `git@github.com:o/n.git` or `ssh://git@github.com/o/n.git`.
 */
const parseGitHubUrl = (url: string | undefined): string | undefined => {
  const match = url
    ?.trim()
    .match(
      /^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/,
    );

  return match?.[1];
};

/** A deployment as the run's repository, if it names both a repository and a commit. */
const toRepo = ({
  fullName,
  sha,
  branch,
}: Deployed): RepoContext | undefined => {
  const [owner, name, ...rest] = fullName?.split("/") ?? [];

  if (!owner || !name || rest.length || !sha || !/^[0-9a-f]{40}$/i.test(sha)) {
    return undefined;
  }

  return {
    owner,
    name,
    fullName: `${owner}/${name}`,
    sha: sha.toLowerCase(),
    ...(branch ? { ref: `refs/heads/${branch}`, baseRef: branch } : {}),
  };
};

/**
 * The repository and commit the host says it deployed, or else the working
 * directory's GitHub remote and `HEAD` for an app running from a checkout.
 * `undefined` when neither names a GitHub repository and a commit.
 */
export const deployedRepo = (
  /** The environment to read. */
  env: Env = process.env,
  /** The directory to ask git about. */
  cwd: string = process.cwd(),
): RepoContext | undefined => {
  for (const host of hosts) {
    const repo = toRepo(host(env));

    if (repo) {
      return repo;
    }
  }

  const git = (...args: string[]): string | undefined => {
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return undefined;
    }
  };

  const branch = git("rev-parse", "--abbrev-ref", "HEAD");

  return toRepo({
    fullName: parseGitHubUrl(git("remote", "get-url", "origin")),
    sha: git("rev-parse", "HEAD"),
    branch: branch === "HEAD" ? undefined : branch,
  });
};
