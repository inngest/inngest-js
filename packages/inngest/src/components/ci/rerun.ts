import type { Inngest } from "../Inngest.ts";
import type { PipelineConfig } from "./types.ts";

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

  // Only act on checks this pipeline created.
  const mine =
    name === checkName ||
    name?.startsWith(`${checkName} / `) ||
    Boolean(externalId);

  if (!mine) {
    return { rerun: false, reason: "not this pipeline's check" };
  }

  const sha: string | undefined = checkRun?.head_sha;
  const repository = event?.data?.repository;

  if (!sha || !repository?.full_name) {
    return { rerun: false, reason: "no commit to re-run" };
  }

  const rerunOf = externalId?.split(":")[0];

  return step.run("resend-trigger", async () => {
    const { octokitForRun } = await import("./github/rest.ts");
    const [owner, repo] = String(repository.full_name).split("/") as [
      string,
      string,
    ];

    let pullRequest: unknown;

    try {
      const octokit = await octokitForRun();
      const { data } = await octokit.rest.pulls.list({
        owner,
        repo,
        state: "open",
      });
      pullRequest = data.find((pr) => pr.head.sha === sha);
    } catch {
      // Without credentials the re-run still works for push pipelines.
    }

    await client.send({
      name: pullRequest ? "github/pull_request.synchronize" : "github/push",
      data: {
        ...(pullRequest
          ? {
              action: "synchronize",
              pull_request: pullRequest,
              number: (pullRequest as { number: number }).number,
            }
          : { ref: `refs/heads/${repository.default_branch}`, after: sha }),
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
