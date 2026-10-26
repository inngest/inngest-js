/**
 * A pull request's own cache: the snapshots it takes for a key the default
 * branch doesn't have. Each is held by a run of its own that waits for the pull
 * request to close and then ends, which deletes the snapshot (see
 * `step.sandbox.scope()`). Whatever ends that run deletes it too: a missed close
 * event leaves it to the wait's timeout, and a cancelled or failed run to its
 * cleanup, so nothing sweeps for leftovers.
 *
 * @module
 */

import type { Inngest, InngestFunction } from "inngest";
import { sandboxMiddleware } from "inngest/experimental";
import { ciStep, traceName } from "./names.ts";
import { pipelineFunctionOptions } from "./pipeline.ts";
import type { CiRunScope } from "./scope.ts";

/** Sent when a build takes a snapshot for a pull request's own cache. */
export const prCacheHoldEvent = "ci/pr-cache.hold";

/** How long a snapshot is held when the pull request's close is never seen. */
const holdTimeout = "30d";

/**
 * Ask for a pull request's snapshot to be held until the pull request closes.
 * A step, so a replay doesn't send it again.
 */
export const holdForPullRequest = async (
  run: CiRunScope,
  stepId: string,
  snapshotId: string,
): Promise<void> => {
  const { repo } = run;

  if (!repo?.pullRequest) {
    return;
  }

  await run.step.sendEvent(ciStep(stepId, traceName.holdPullRequestCache), {
    name: prCacheHoldEvent,
    data: {
      repo: repo.fullName,
      pr: repo.pullRequest.number,
      snapshotId,
    },
  });
};

/**
 * The function that holds one snapshot: it scopes it to its own run, then waits
 * for the pull request to close.
 */
export const prCacheFunction = ({
  client,
}: {
  client: Inngest.Any;
}): InngestFunction.Any => {
  return client.createFunction(
    {
      id: "ci/pr-cache",
      ...pipelineFunctionOptions,
      triggers: [{ event: prCacheHoldEvent }],
      middleware: [sandboxMiddleware()],
    },
    // biome-ignore lint/suspicious/noExplicitAny: SDK ctx
    async ({ event, step }: any) => {
      step.sandbox.scope({ snapshotId: event.data.snapshotId });

      await step.waitForEvent("pull-request-closed", {
        event: "github/pull_request.closed",
        timeout: holdTimeout,
        if: "async.data.repository.full_name == event.data.repo && async.data.number == event.data.pr",
      });

      return { held: event.data.snapshotId };
    },
  );
};
