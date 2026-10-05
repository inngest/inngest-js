/**
 * Re-running a pipeline when a GitHub check is re-requested.
 *
 * @module
 */

import type { Inngest } from "inngest";
import type { PipelineConfig } from "../types.ts";

/**
 * Re-run a pipeline from a GitHub check's "Re-run" button.
 *
 * The original event isn't available from the SDK, so a minimal pull request
 * event is rebuilt from the check run's head commit and re-sent, marked with
 * `_ci.rerunOf` so the new run can be traced back.
 */
export const rerunEventFor = async ({
  event,
  step,
  client,
  config,
}: {
  // biome-ignore lint/suspicious/noExplicitAny: GitHub event
  event: any;
  // biome-ignore lint/suspicious/noExplicitAny: SDK step tools
  step: any;
  client: Inngest.Any;
  config: PipelineConfig;
}): Promise<{ rerun: boolean; reason?: string }> => {
  const checkRun = event?.data?.check_run ?? event?.data?.check_suite;
  const externalId: string | undefined = checkRun?.external_id;
  const name: string | undefined = checkRun?.name;

  const checkName =
    config.check === false ? config.id : (config.check?.name ?? config.id);

  // A suite has no name or external_id, and only the app that owns it hears
  // about its re-request, so re-run for the suite's commit. A check run is
  // only ours if it carries our check name: external IDs are not unique to
  // this pipeline, so they say nothing about who owns the check.
  const mine =
    !event?.data?.check_run ||
    name === checkName ||
    name?.startsWith(`${checkName} / `);

  if (!mine) {
    return { rerun: false, reason: "not this pipeline's check" };
  }

  const sha: string | undefined = checkRun?.head_sha;
  const repository = event?.data?.repository;

  if (!sha || !repository?.full_name) {
    return { rerun: false, reason: "no commit to re-run" };
  }

  const suite = event?.data?.check_run?.check_suite ?? event?.data?.check_suite;

  const payloadPullRequest = (checkRun?.pull_requests ??
    suite?.pull_requests ??
    [])[0];

  const headBranch: string | undefined =
    suite?.head_branch ?? checkRun?.head_branch;

  // A fork's branch is not a branch of this repository, so it must never be
  // re-sent as a push to one.
  const headRepo: string | undefined =
    checkRun?.head_repository?.full_name ?? suite?.head_repository?.full_name;

  const fromFork = Boolean(headRepo) && headRepo !== repository.full_name;

  const rerunOf = externalId?.split(":")[0];

  // Every pipeline hears the same webhook, so they all send the same ID and
  // the copies collapse into one event.
  const delivery: string | undefined =
    event?.data?._github?.delivery ?? event?.id;

  return step.run("resend-trigger", async () => {
    const { octokitForRun } = await import("../github/rest.ts");

    const [owner, repo] = String(repository.full_name).split("/") as [
      string,
      string,
    ];

    let pullRequest: unknown = payloadPullRequest;

    try {
      const octokit = await octokitForRun();

      if (payloadPullRequest?.number) {
        const { data } = await octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: payloadPullRequest.number,
        });

        pullRequest = data?.number ? data : payloadPullRequest;
      } else {
        const { data } =
          await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
            owner,
            repo,
            commit_sha: sha,
          });

        pullRequest = data.find((pr) => {
          return pr.state === "open" && pr.head.sha === sha;
        });
      }
    } catch {
      // Without credentials the payload's own pull request, or the branch,
      // is all there is to go on.
    }

    if (!pullRequest && fromFork) {
      return {
        rerun: false,
        reason: "fork check with no pull request to re-run",
      };
    }

    if (!pullRequest && !headBranch) {
      return { rerun: false, reason: "no pull request or branch to re-run" };
    }

    await client.send({
      ...(delivery ? { id: `ci-rerun-${delivery}` } : {}),
      name: pullRequest ? "github/pull_request.synchronize" : "github/push",
      data: {
        ...(pullRequest
          ? {
              action: "synchronize",
              pull_request: pullRequest,
              number: (pullRequest as { number: number }).number,
            }
          : { ref: `refs/heads/${headBranch}`, after: sha }),
        repository,
        _github: event?.data?._github,
        _ci: {
          ...(rerunOf ? { rerunOf } : {}),
          ...(externalId?.includes(":")
            ? { fromJob: externalId.split(":").slice(1).join(":") }
            : {}),
        },
      },
    });

    return { rerun: true, sha };
  });
};
