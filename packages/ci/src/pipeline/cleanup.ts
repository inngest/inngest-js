/**
 * Making a sandbox or snapshot a run's own, so that it is destroyed or deleted
 * when the run ends for any reason, including cancel and timeout. The run
 * defers a cleanup function to run after it, with the ID of what to remove.
 * Machines use the SDK's sandbox cleanup, which `sandboxMiddleware()` serves;
 * snapshots use the one here, which the app serves with `ci.functions()`.
 *
 * @module
 */

import type { Inngest, InngestFunction } from "inngest";
import { createDefer, createSandboxCleanup } from "inngest/experimental";
import type { DeferHandle } from "inngest/types";
import type { CiRunScope } from "./scope.ts";

/** What a run's cleanup removes, by ID. */
export type RunOwned = { sandboxId: string } | { snapshotId: string };

const snapshotCleanups = new WeakMap<Inngest.Any, InngestFunction.Any>();

/**
 * The function that deletes a snapshot a run owned, if it still exists. One per
 * client, so the app serves the function its runs defer to.
 */
export const snapshotCleanupFunction = (
  client: Inngest.Any,
): InngestFunction.Any => {
  const existing = snapshotCleanups.get(client);

  if (existing) {
    return existing;
  }

  const cleanup = createDefer(
    client,
    { id: "ci-snapshot-cleanup" },
    async ({ event, step }) => {
      await step.run("delete", async () => {
        const { snapshotId } = event.data as { snapshotId: string };

        await (await client.sandboxes.snapshots.get(snapshotId))?.delete();
      });
    },
  ) as unknown as InngestFunction.Any;

  snapshotCleanups.set(client, cleanup);

  return cleanup;
};

/**
 * Make a sandbox or snapshot this run's own. The returned handle stops the
 * cleanup once the run has removed it itself.
 */
export const ownedByRun = (
  run: Pick<CiRunScope, "defer" | "ci">,
  target: RunOwned,
): DeferHandle => {
  const { client } = run.ci;

  if ("sandboxId" in target) {
    return run.defer(`sandbox:${target.sandboxId}:cleanup`, {
      function: createSandboxCleanup(client),
      data: target,
    });
  }

  // The cleanup is built for this client, so its type isn't the call's.
  const defer = run.defer as unknown as (
    id: string,
    options: { function: InngestFunction.Any; data: unknown },
  ) => DeferHandle;

  return defer(`snapshot:${target.snapshotId}:cleanup`, {
    function: snapshotCleanupFunction(client),
    data: target,
  });
};
