/**
 * Re-running a pipeline when a GitHub check is re-requested.
 *
 * @module
 */

import type { Inngest } from "inngest";
import type { PipelineConfig } from "../types.ts";

/**
 * Whether a check's event may start a re-run. Re-requesting from GitHub's own
 * button is already limited to people who can write to the repository; a
 * button of ours (`requested_action`) carries the clicker, so it is checked
 * here.
 */
/**
 * Whether a check's event is for this pipeline: a check run is only ours if it
 * carries our check name, since external IDs are not unique to a pipeline. A
 * suite has no name, and every pipeline on the commit is meant.
 */
export const isOurCheck = (
  // biome-ignore lint/suspicious/noExplicitAny: GitHub event
  event: any,
  config: PipelineConfig,
): boolean => {
  const checkName =
    config.check === false ? config.id : (config.check?.name ?? config.id);

  const name: string | undefined = event?.data?.check_run?.name;

  return (
    !event?.data?.check_run ||
    name === checkName ||
    Boolean(name?.startsWith(`${checkName} / `))
  );
};

export const mayRerun = async ({
  event,
  step,
}: {
  // biome-ignore lint/suspicious/noExplicitAny: GitHub event
  event: any;
  // biome-ignore lint/suspicious/noExplicitAny: SDK step tools
  step: any;
}): Promise<boolean> => {
  const login: string | undefined = event?.data?.sender?.login;

  if (!event?.data?.requested_action) {
    return true;
  }

  if (!login || !event?.data?.repository?.full_name) {
    return false;
  }

  return step.run("check-permission", async () => {
    const { octokitForRun } = await import("../github/rest.ts");
    const { hasPermission } = await import("../github/triggers.ts");
    const [owner, repo] = String(event.data.repository.full_name).split(
      "/",
    ) as [string, string];

    try {
      const octokit = await octokitForRun();
      const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
        owner,
        repo,
        username: login,
      });

      return hasPermission(data.permission, "write");
    } catch (error) {
      // Not being able to see the permission means no.
      const status = (error as { status?: number }).status;

      if (status === 403 || status === 404) {
        return false;
      }

      throw error;
    }
  });
};

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

  if (!isOurCheck(event, config)) {
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

  const rerunOf = externalId?.split(":")[0];

  // A job's check re-runs that job alone; the pipeline's and the suite's
  // re-run everything.
  const job = externalId?.includes(":")
    ? externalId.split(":").slice(1).join(":")
    : undefined;

  const noCache = event?.data?.requested_action?.identifier === "rerun-fresh";

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
    let branchVerified = false;

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

        // A branch name alone proves nothing: a fork's `main` is not ours. Only
        // re-push a branch whose head is this very commit.
        if (!pullRequest && headBranch) {
          const { data: branch } = await octokit.rest.repos.getBranch({
            owner,
            repo,
            branch: headBranch,
          });

          branchVerified = branch?.commit?.sha === sha;
        }
      }
    } catch {
      // Without credentials the payload's own pull request is all there is to
      // go on.
    }

    if (!pullRequest && !branchVerified) {
      return {
        rerun: false,
        reason: "no pull request, and the branch could not be verified",
      };
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
          ...(job && job !== "pipeline" ? { job } : {}),
          ...(noCache ? { noCache } : {}),
        },
      },
    });

    return { rerun: true, sha };
  });
};
