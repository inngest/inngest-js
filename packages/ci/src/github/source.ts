/**
 * Which repository and commit `checkout()` and `files()` read: the run's own,
 * or another repository and ref resolved to a commit by one step per run.
 *
 * @module
 */

import { NonRetriableError } from "inngest";
import { CiUsageError } from "../errors.ts";
import { ciRun } from "../pipeline/metadata.ts";
import { ciStep, traceName } from "../pipeline/names.ts";
import type { CiRunScope } from "../pipeline/scope.ts";
import { inGitHubSpan } from "../pipeline/scope.ts";
import { errorMessage, parseRepo } from "../util.ts";
import type { GitHubProvider, Octokit } from "./auth.ts";
import { mapGitHubError } from "./rest.ts";

/** What a caller asked to read: a repository, a ref, both or neither. */
export interface SourceSpec {
  /** `owner/name`. Defaults to the run's repository. */
  repo?: string;
  /** A branch, tag or commit SHA. */
  ref?: string;
}

/** A repository at one commit, and the installation that can read it. */
export interface ResolvedSource {
  owner: string;
  name: string;
  fullName: string;
  /** The commit, never a ref name. */
  sha: string;
  /** The GitHub App installation that can read it. Not a secret. */
  installationId?: number;
}

const sameRepo = (a: string, b: string | undefined): boolean => {
  return a.toLowerCase() === b?.toLowerCase();
};

/**
 * Whether a spec means the run's own repository at the run's own commit, which
 * needs no lookup and, locally, is the working tree.
 */
export const targetsRunRepo = (run: CiRunScope, spec: SourceSpec): boolean => {
  return (
    spec.ref === undefined &&
    (spec.repo === undefined || sameRepo(spec.repo, run.repo?.fullName))
  );
};

const sourceKey = (fullName: string, ref: string | undefined): string => {
  return `${fullName.toLowerCase()}@${ref ?? ""}`;
};

const accessError = (fullName: string): NonRetriableError => {
  return new NonRetriableError(
    `The GitHub App can't access \`${fullName}\`. Give the GitHub App access to that repository, by installing it on the owner or adding the repository to its installation.`,
  );
};

const providerOf = (run: CiRunScope): GitHubProvider => {
  const provider = run.ci.github as GitHubProvider | undefined;

  if (!provider) {
    throw new CiUsageError(
      "No GitHub provider is configured. Pass `github: githubApp({ … })` or `githubToken({ … })` to `createCi`.",
    );
  }

  return provider;
};

/** The Octokit client for a resolved source, which may be another installation. */
export const octokitForSource = (
  run: CiRunScope,
  source: ResolvedSource,
): Promise<Octokit> => {
  return providerOf(run).octokit({
    owner: source.owner,
    repo: source.name,
    ...(source.installationId === undefined
      ? {}
      : { installationId: source.installationId }),
  });
};

/** The token that clones a resolved source. Call it only inside a step handler. */
export const tokenForSource = (
  run: CiRunScope,
  source: ResolvedSource,
): Promise<string> => {
  return providerOf(run).token({
    owner: source.owner,
    repo: source.name,
    ...(source.installationId === undefined
      ? {}
      : { installationId: source.installationId }),
  });
};

const statusOf = (error: unknown): number | undefined => {
  return (error as { status?: number }).status;
};

/** Ask GitHub, which is the work of the resolving step. */
const lookUp = async (
  run: CiRunScope,
  fullName: string,
  ref: string | undefined,
): Promise<ResolvedSource> => {
  const { owner, name } = parseRepo(fullName);
  const provider = providerOf(run);
  const own = sameRepo(fullName, run.repo?.fullName);

  const installationId =
    own && run.repo?.installationId !== undefined
      ? run.repo.installationId
      : await provider.installationFor?.(owner, name);

  if (provider.installationFor && installationId === undefined) {
    throw accessError(fullName);
  }

  const source: ResolvedSource = {
    owner,
    name,
    fullName,
    sha: "",
    ...(installationId === undefined ? {} : { installationId }),
  };

  const octokit = await octokitForSource(run, source);

  let branch: string;

  try {
    const { data } = await octokit.rest.repos.get({ owner, repo: name });

    branch = data.default_branch;
  } catch (error) {
    if (statusOf(error) === 404 || statusOf(error) === 403) {
      throw accessError(fullName);
    }

    throw mapGitHubError(error) ?? error;
  }

  try {
    const { data } = await octokit.rest.repos.getCommit({
      owner,
      repo: name,
      ref: ref ?? branch,
    });

    return { ...source, sha: data.sha };
  } catch (error) {
    if (statusOf(error) === 404 || statusOf(error) === 422) {
      throw new NonRetriableError(
        `\`${ref}\` isn't a branch, tag or commit of \`${fullName}\`.`,
      );
    }

    throw mapGitHubError(error) ?? error;
  }
};

/**
 * Resolve what a caller asked to read to a commit.
 *
 * The run's own repository and commit come straight from the run. Anything
 * else is looked up in one memoized step per repository and ref, in the run's
 * GitHub span rather than whichever job asked first, so every replay and every
 * job sees the same commit. Call it outside a step: a step can't start another.
 */
export const resolveSource = async (
  run: CiRunScope,
  spec: SourceSpec,
): Promise<ResolvedSource> => {
  if (targetsRunRepo(run, spec)) {
    const repo = run.repo;

    if (!repo) {
      throw new CiUsageError(
        'This run\'s trigger has no repository. Pass `repo: "owner/name"`, or set `repo` on the pipeline.',
      );
    }

    return {
      owner: repo.owner,
      name: repo.name,
      fullName: repo.fullName,
      sha: repo.sha,
      ...(repo.installationId === undefined
        ? {}
        : { installationId: repo.installationId }),
    };
  }

  const fullName = spec.repo ?? run.repo?.fullName;

  if (!fullName) {
    throw new CiUsageError(
      'This run\'s trigger has no repository, so `ref` needs a `repo: "owner/name"` beside it.',
    );
  }

  const key = sourceKey(fullName, spec.ref);
  const known = run.sources.get(key);

  if (known) {
    return known;
  }

  const pending = inGitHubSpan(run, () => {
    return ciRun(
      run,
      {
        step: ciStep(`github › ref:${key}`, traceName.resolveRef),
        intent: `Resolve ${spec.ref ? `\`${spec.ref}\`` : "the default branch"} of \`${fullName}\` to a commit`,
      },
      async (note) => {
        try {
          const source = await lookUp(run, fullName, spec.ref);

          note.outcome({ repo: fullName, sha: source.sha });

          return source;
        } catch (error) {
          if (error instanceof CiUsageError) {
            throw new NonRetriableError(errorMessage(error), { cause: error });
          }

          throw error;
        }
      },
    );
  });

  run.sources.set(key, pending);

  return pending;
};

/**
 * A source that `resolveSource` already resolved, for use inside a step where
 * resolving is not possible.
 */
export const resolvedSource = async (
  run: CiRunScope,
  spec: SourceSpec,
): Promise<ResolvedSource> => {
  if (targetsRunRepo(run, spec)) {
    return resolveSource(run, spec);
  }

  const fullName = spec.repo ?? run.repo?.fullName ?? "";
  const known = run.sources.get(sourceKey(fullName, spec.ref));

  if (!known) {
    throw new Error(
      `\`${fullName}\` wasn't resolved before it was read. This is a bug in @inngest/ci.`,
    );
  }

  return known;
};
