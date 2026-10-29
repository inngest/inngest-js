/**
 * Cleanup for the snapshots a run owns. Each one registers a defer, once the
 * run holds its ID, that deletes it by ID when the run ends for any reason,
 * including cancel and timeout. The run's own cleanup step deletes them first
 * on a normal end and aborts the defers, so a run that finishes normally
 * starts no extra run.
 *
 * A run cancelled after a build ended and before the run adopted its snapshot,
 * which happens within one request, leaves that snapshot to its expiry.
 *
 * @module
 */

import type { Inngest } from "inngest";
import type { DeferredFunction } from "inngest/experimental";
import { createDefer } from "inngest/experimental";
import { deleteSnapshots } from "../machine/admin.ts";
import type { CiRunScope } from "./scope.ts";

/** The ID of the function that deletes a snapshot a run left behind. */
export const snapshotCleanupFunctionId = "ci-snapshot-cleanup";

const functions = new WeakMap<Inngest.Any, DeferredFunction.Any>();

/**
 * The function a run's defers start to delete one snapshot. One per client,
 * and served with the pipelines.
 */
export const snapshotCleanupFunction = (
  client: Inngest.Any,
): DeferredFunction.Any => {
  const existing = functions.get(client);

  if (existing) {
    return existing;
  }

  const cleanup = createDefer(
    client,
    { id: snapshotCleanupFunctionId },
    async ({ event, step }) => {
      await step.run("delete", async () => {
        const { failed } = await deleteSnapshots(client, [
          String((event.data as { snapshotId: string }).snapshotId),
        ]);

        // Thrown so the step retries; an ID that is already gone isn't failed.
        if (failed.length > 0) {
          throw new Error(`Couldn't delete snapshot ${failed[0]}`);
        }
      });
    },
  );

  functions.set(client, cleanup);

  return cleanup;
};

/**
 * Make a snapshot the run's to delete, whichever way the run ends. A build run
 * hands its snapshots to the run that invoked it when it succeeds (see
 * `handOffSnapshots`), so its defers only start when the build fails or is
 * cancelled.
 */
export const ownSnapshot = (
  run: CiRunScope,
  snapshotId: string,
  options: {
    /** Whether to delete it when the run ends. Defaults to true. */
    defer?: boolean;
  } = {},
): void => {
  run.createdSnapshots.add(snapshotId);

  if (options.defer === false || run.snapshotCleanups.has(snapshotId)) {
    return;
  }

  // The ID makes the defer's ID, so a replay registers the same one and the
  // SDK skips it.
  run.snapshotCleanups.set(
    snapshotId,
    run.defer(`snapshot:${snapshotId}:cleanup`, {
      function: snapshotCleanupFunction(run.ci.client),
      data: { snapshotId },
    }),
  );
};

/**
 * A build run that succeeded gives its snapshots to the run that invoked it,
 * which owns them from here on, so its own defers have nothing to do. The
 * snapshots stay in `createdSnapshots`, which the build hands back.
 */
export const handOffSnapshots = (run: CiRunScope): void => {
  for (const handle of run.snapshotCleanups.values()) {
    handle.abort();
  }

  run.snapshotCleanups.clear();
};

/**
 * The run no longer owns a snapshot, because it deleted it or it is gone. Its
 * defer has nothing left to do.
 */
export const releaseSnapshot = (run: CiRunScope, snapshotId: string): void => {
  run.createdSnapshots.delete(snapshotId);

  run.snapshotCleanups.get(snapshotId)?.abort();

  run.snapshotCleanups.delete(snapshotId);
};
