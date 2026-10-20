/**
 * Checking a GitHub event against GitHub itself. A webhook can be forged by
 * anyone who has its URL, so a run that opts in asks the API whether what the
 * event claims is true before it does anything.
 *
 * @module
 */

import type { RepoContext } from "../types.ts";
import type { Octokit } from "./auth.ts";

/**
 * Why an event can't be trusted, or `undefined` when GitHub agrees with it.
 *
 * - A pull request event must name a pull request that exists and whose head
 *   is the commit the event says. A newer push has its own event, and the
 *   pipeline's `singleton` ends the older run anyway.
 * - A push event must name a commit that is the tip of its ref or an ancestor
 *   of it, so two quick pushes both run.
 *
 * Other events are not checked. A repository the token can't see is a
 * "not found", so the token's own access is the allow list.
 */
export const eventRejection = async ({
  octokit,
  repo,
}: {
  octokit: Octokit;
  repo: RepoContext;
}): Promise<string | undefined> => {
  const { owner, name: repoName, sha } = repo;

  try {
    if (repo.trigger?.startsWith("github/pull_request.")) {
      const number = repo.pullRequest?.number ?? 0;
      const { data: pr } = await octokit.rest.pulls.get({
        owner,
        repo: repoName,
        pull_number: number,
      });

      return pr.head.sha === sha
        ? undefined
        : `Pull request #${number} is at ${pr.head.sha}, not ${sha}`;
    }

    if (repo.trigger === "github/push") {
      const { data: tip } = await octokit.rest.git.getRef({
        owner,
        repo: repoName,
        ref: (repo.ref ?? "").replace(/^refs\//, ""),
      });

      if (tip.object.sha === sha) {
        return undefined;
      }

      const { data: comparison } = await octokit.rest.repos.compareCommits({
        owner,
        repo: repoName,
        base: sha,
        head: tip.object.sha,
      });

      return comparison.status === "ahead"
        ? undefined
        : `${sha} is not on ${repo.ref}`;
    }
  } catch (error) {
    if ((error as { status?: number }).status === 404) {
      return `GitHub has no such pull request, ref or commit in ${repo.fullName}`;
    }

    throw error;
  }

  return undefined;
};
