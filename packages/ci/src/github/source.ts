/**
 * Which repository and commit `checkout()` and `files()` read: the run's own,
 * or another repository and ref resolved to a commit by memoized steps.
 *
 * @module
 */

import { NonRetriableError } from "inngest";
import { CiUsageError } from "../errors.ts";
import { ciRun } from "../pipeline/metadata.ts";
import { steps } from "../pipeline/names.ts";
import type { CiRunScope } from "../pipeline/scope.ts";
import { inGitHubSpan } from "../pipeline/scope.ts";
import type { FilesOptions } from "../types.ts";
import { once, parseRepo } from "../util.ts";
import type { AuthContext, GitHubProvider, Octokit } from "./auth.ts";
import { mapGitHubError } from "./rest.ts";

/** What a caller asked to read: a repository, a ref, both or neither. */
export type SourceSpec = FilesOptions;

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

/** Whether two `owner/name` strings name the same repository, ignoring case. */
export const sameRepo = (a: string, b: string | undefined): boolean => {
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

const sourceKey = (fullName: string, ref: string): string => {
  return `${fullName.toLowerCase()}@${ref}`;
};

const accessError = (fullName: string, viaApp: boolean): NonRetriableError => {
  return new NonRetriableError(
    viaApp
      ? `The GitHub App can't access \`${fullName}\`. Give the GitHub App access to that repository, by installing it on the owner or adding the repository to its installation.`
      : `The token can't access \`${fullName}\`. Use a token that has access to that repository.`,
  );
};

const notFoundError = (
  fullName: string,
  ref: string | undefined,
): NonRetriableError => {
  return new NonRetriableError(
    ref === undefined
      ? `Couldn't find the default branch of \`${fullName}\`.`
      : `\`${ref}\` isn't a branch, tag or commit of \`${fullName}\`.`,
  );
};

const emptyError = (fullName: string): NonRetriableError => {
  return new NonRetriableError(
    `\`${fullName}\` has no commits to read: the repository is empty.`,
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

/**
 * How to authenticate to read a source. Another repository than the run's gets
 * a token narrowed to just that repository.
 */
const authFor = (run: CiRunScope, source: ResolvedSource): AuthContext => {
  return {
    owner: source.owner,
    repo: source.name,
    ...(source.installationId === undefined
      ? {}
      : { installationId: source.installationId }),
    ...(sameRepo(source.fullName, run.repo?.fullName)
      ? {}
      : { repositoryNames: [source.name] }),
  };
};

/** The Octokit client for a resolved source, which may be another installation. */
export const octokitForSource = (
  run: CiRunScope,
  source: ResolvedSource,
): Promise<Octokit> => {
  return providerOf(run).octokit(authFor(run, source));
};

/** The token that clones a resolved source. Call it only inside a step handler. */
export const tokenForSource = (
  run: CiRunScope,
  source: ResolvedSource,
): Promise<string> => {
  return providerOf(run).token(authFor(run, source));
};

const statusOf = (error: unknown): number | undefined => {
  return (error as { status?: number }).status;
};

/**
 * Return when an error means GitHub can't see the repository (a 403 that isn't
 * a rate limit, or a 404). Throw anything else: rate limits as retries, server
 * errors as they are, and other client errors as non-retriable.
 */
const throwUnlessMissing = (error: unknown): void => {
  const mapped = mapGitHubError(error);
  const status = statusOf(error);

  if (
    mapped instanceof NonRetriableError &&
    (status === 403 || status === 404)
  ) {
    return;
  }

  throw mapped ?? error;
};

/**
 * Run a read against a repository with an installation that can see it. The
 * run's own installation goes first, since that's usually enough, and the
 * repository's own installation is only looked up when that can't see it.
 */
const locate = async <T>(
  run: CiRunScope,
  fullName: string,
  read: (octokit: Octokit, source: ResolvedSource) => Promise<T>,
): Promise<{ value: T; source: ResolvedSource }> => {
  const { owner, name } = parseRepo(fullName);
  const { installationFor } = providerOf(run);
  const first = installationFor ? run.repo?.installationId : undefined;

  const attempt = async (installationId: number | undefined) => {
    const source: ResolvedSource = {
      owner,
      name,
      fullName,
      sha: "",
      ...(installationId === undefined ? {} : { installationId }),
    };

    const octokit = await octokitForSource(run, source);

    return { value: await read(octokit, source), source };
  };

  if (!installationFor || first !== undefined) {
    try {
      return await attempt(first);
    } catch (error) {
      throwUnlessMissing(error);
    }
  }

  if (!installationFor) {
    throw accessError(fullName, false);
  }

  const found = await installationFor(owner, name);

  if (found === undefined || found === first) {
    throw accessError(fullName, true);
  }

  try {
    return await attempt(found);
  } catch (error) {
    throwUnlessMissing(error);

    throw accessError(fullName, true);
  }
};

/** The commit a ref points at, in a repository this client can read. */
const readCommit = async (
  octokit: Octokit,
  source: ResolvedSource,
  ref: string,
): Promise<string> => {
  try {
    const { data } = await octokit.rest.repos.getCommit({
      owner: source.owner,
      repo: source.name,
      ref,
    });

    return data.sha;
  } catch (error) {
    const status = statusOf(error);

    if (status === 409) {
      throw emptyError(source.fullName);
    }

    if (status === 422) {
      throw notFoundError(source.fullName, ref);
    }

    if (status === 404) {
      // A missing ref and a repository this client can't see are both a 404.
      // Asking for the repository says which.
      await octokit.rest.repos.get({ owner: source.owner, repo: source.name });

      throw notFoundError(source.fullName, ref);
    }

    throw error;
  }
};

/**
 * The default branch's name, from one step per repository per run. `repo` and
 * `ref: "<default branch>"` then share one commit step, keyed on the branch.
 */
const defaultBranch = (run: CiRunScope, fullName: string): Promise<string> => {
  return once(run.defaultBranches, fullName.toLowerCase(), () => {
    return inGitHubSpan(run, () => {
      return ciRun(run, steps.resolveDefaultBranch(fullName), async () => {
        const { value } = await locate(
          run,
          fullName,
          async (octokit, source) => {
            const { data } = await octokit.rest.repos.get({
              owner: source.owner,
              repo: source.name,
            });

            return data.default_branch;
          },
        );

        if (!value) {
          throw notFoundError(fullName, undefined);
        }

        return value;
      });
    });
  });
};

/**
 * Resolve what a caller asked to read to a commit.
 *
 * The run's own repository and commit come straight from the run. Anything
 * else is looked up in memoized steps, in the run's GitHub span rather than
 * whichever job asked first, so every replay and every job sees the same
 * commit: one step finds a repository's default branch when no `ref` is given,
 * and one step per repository and branch finds the commit. Call it outside a
 * step: a step can't start another. Called again for what it already resolved,
 * it starts nothing, so a step can call it.
 */
export const resolveSource = async (
  run: CiRunScope,
  spec: SourceSpec,
): Promise<ResolvedSource> => {
  if (targetsRunRepo(run, spec)) {
    if (!run.repo) {
      throw new CiUsageError(
        'This run\'s trigger has no repository. Pass `repo: "owner/name"`, or set `repo` on the pipeline.',
      );
    }

    return run.repo;
  }

  const fullName = spec.repo ?? run.repo?.fullName;

  if (!fullName) {
    throw new CiUsageError(
      'This run\'s trigger has no repository, so `ref` needs a `repo: "owner/name"` beside it.',
    );
  }

  parseRepo(fullName);

  // Checked here, outside the steps, so a missing provider is a usage error
  // and not something a step retries.
  providerOf(run);

  const ref = spec.ref ?? (await defaultBranch(run, fullName));
  const key = sourceKey(fullName, ref);

  return once(run.sources, key, () => {
    return inGitHubSpan(run, () => {
      return ciRun(run, steps.resolveRef(fullName, ref, key), async () => {
        const { value, source } = await locate(
          run,
          fullName,
          (octokit, found) => {
            return readCommit(octokit, found, ref);
          },
        );

        return { ...source, sha: value };
      });
    });
  });
};
