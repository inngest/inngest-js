/**
 * A pull request's own cache: the snapshots it takes for a key the default
 * branch doesn't have, named `ci/pr:<repo>#<number>/...`. When the pull request
 * closes, this deletes every snapshot with that prefix. A close that is never
 * seen leaves them to the platform's expiry.
 *
 * @module
 */

import type { Inngest, InngestFunction } from "inngest";
import { pullRequestPrefix } from "../cache/names.ts";
import { isSnapshotNotFound } from "../util.ts";
import { pipelineFunctionOptions } from "./pipeline.ts";

/**
 * Delete every snapshot whose name starts with a pull request's prefix. The
 * API filters by exact name only, so this pages through the snapshots and
 * matches the prefix here.
 */
export const deletePullRequestSnapshots = async (
  client: Inngest.Any,
  prefix: string,
): Promise<{ deleted: number }> => {
  let deleted = 0;
  let cursor: string | undefined;

  while (true) {
    const page = await client.sandboxes.snapshots.list({
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });

    for (const snapshot of page.items) {
      if (!snapshot.name?.startsWith(prefix)) {
        continue;
      }

      try {
        await snapshot.delete();

        deleted++;
      } catch (error) {
        if (!isSnapshotNotFound(error)) {
          throw error;
        }
      }
    }

    if (!page.page.hasMore || !page.page.cursor) {
      return { deleted };
    }

    cursor = page.page.cursor;
  }
};

/** The function that deletes a pull request's cache when it closes. */
export const prClosedFunction = ({
  client,
}: {
  client: Inngest.Any;
}): InngestFunction.Any => {
  return client.createFunction(
    {
      id: "ci/pr-closed",
      ...pipelineFunctionOptions,
      triggers: [{ event: "github/pull_request.closed" }],
    },
    // biome-ignore lint/suspicious/noExplicitAny: SDK ctx
    async ({ event, step }: any) => {
      const repo = event.data?.repository?.full_name;
      const number = event.data?.number;

      if (!repo || number === undefined) {
        return { deleted: 0 };
      }

      return step.run("delete", () => {
        return deletePullRequestSnapshots(
          client,
          pullRequestPrefix(repo, number),
        );
      });
    },
  );
};
