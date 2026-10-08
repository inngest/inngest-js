/**
 * Which repository and commit this app was deployed from. A build another
 * app asks for has no GitHub event of its own, so what it checks out and
 * hashes comes from the deployment: the host's own variables, or locally, the
 * working directory's git remote and `HEAD`.
 *
 * Building from the deployed commit means a build always matches the recipe
 * that's running.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import type { RepoContext } from "../types.ts";

/** Environment variables, as `process.env` has them. */
type Env = Record<string, string | undefined>;

/** What a host says about a deployment, before it's checked. */
interface Deployed {
  fullName?: string;
  sha?: string;
  branch?: string;
}

/** Where each host keeps the repository, commit and branch it deployed. */
const hosts: { name: string; read: (env: Env) => Deployed }[] = [
  {
    name: "Vercel",
    read: (env) => {
      return {
        fullName: joinRepo(env.VERCEL_GIT_REPO_OWNER, env.VERCEL_GIT_REPO_SLUG),
        sha: env.VERCEL_GIT_COMMIT_SHA,
        branch: env.VERCEL_GIT_COMMIT_REF,
      };
    },
  },
  {
    name: "Netlify",
    read: (env) => {
      return {
        fullName: parseGitHubUrl(env.REPOSITORY_URL),
        sha: env.COMMIT_REF,
        branch: env.BRANCH,
      };
    },
  },
  {
    name: "Render",
    read: (env) => {
      return {
        fullName: env.RENDER_GIT_REPO_SLUG,
        sha: env.RENDER_GIT_COMMIT,
        branch: env.RENDER_GIT_BRANCH,
      };
    },
  },
  {
    name: "Railway",
    read: (env) => {
      return {
        fullName: joinRepo(
          env.RAILWAY_GIT_REPO_OWNER,
          env.RAILWAY_GIT_REPO_NAME,
        ),
        sha: env.RAILWAY_GIT_COMMIT_SHA,
        branch: env.RAILWAY_GIT_BRANCH,
      };
    },
  },
  {
    name: "GitHub Actions",
    read: (env) => {
      return {
        fullName: env.GITHUB_REPOSITORY,
        sha: env.GITHUB_SHA,
        branch: env.GITHUB_REF?.startsWith("refs/heads/")
          ? env.GITHUB_REF_NAME
          : undefined,
      };
    },
  },
];

const joinRepo = (
  owner: string | undefined,
  name: string | undefined,
): string | undefined => {
  return owner && name ? `${owner}/${name}` : undefined;
};

const repoPart = /^[A-Za-z0-9_.-]+$/;

const sha = /^[0-9a-f]{40}$/i;

/**
 * The `owner/name` of a GitHub URL, in any of the forms git and hosts write:
 * `https://github.com/o/n`, `git@github.com:o/n.git` or
 * `ssh://git@github.com/o/n.git`. Anything else is `undefined`.
 */
export const parseGitHubUrl = (url: string | undefined): string | undefined => {
  const match = url
    ?.trim()
    .match(
      /^(?:https:\/\/|ssh:\/\/git@|git@)github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
    );

  return match ? joinRepo(match[1], match[2]) : undefined;
};

/** A host's deployment as the run's repository, if it names both a repo and a commit. */
const toRepo = (deployed: Deployed): RepoContext | undefined => {
  const [owner, name, ...rest] = deployed.fullName?.split("/") ?? [];

  const valid =
    owner &&
    name &&
    rest.length === 0 &&
    repoPart.test(owner) &&
    repoPart.test(name) &&
    sha.test(deployed.sha ?? "");

  if (!valid) {
    return undefined;
  }

  const branch = deployed.branch?.trim();

  return {
    owner,
    name,
    fullName: `${owner}/${name}`,
    sha: (deployed.sha as string).toLowerCase(),
    ...(branch ? { ref: `refs/heads/${branch}`, baseRef: branch } : {}),
  };
};

/**
 * The repository and commit the host says it deployed, from the first host
 * whose variables name both.
 */
export const hostRepo = (
  /** The environment to read. */
  env: Env = process.env,
): RepoContext | undefined => {
  for (const host of hosts) {
    const repo = toRepo(host.read(env));

    if (repo) {
      return repo;
    }
  }

  return undefined;
};

/**
 * The working directory's GitHub remote and `HEAD`, for an app running from a
 * checkout, as in local development. `undefined` outside a git checkout, or
 * when `origin` isn't on GitHub.
 */
export const gitRepo = (
  /** The directory to ask git about. */
  cwd: string = process.cwd(),
): RepoContext | undefined => {
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
    ...(branch && branch !== "HEAD" ? { branch } : {}),
  });
};

/**
 * Which repository and commit this app was deployed from: the host's
 * variables first, then the working directory's git checkout.
 */
export const deployedRepo = (): RepoContext | undefined => {
  return hostRepo() ?? gitRepo();
};
