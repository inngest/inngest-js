/**
 * Cleanup for the snapshots a run owns. Each one registers a defer, once the
 * run holds its ID, that deletes it by ID when the run ends for any reason,
 * including cancel and timeout. The run's own cleanup step deletes them first
 * on a normal end and aborts the defers, so a run that finishes normally
 * starts no extra run.
 *
 * A snapshot a run takes under a name is also covered before it is created, by
 * a defer keyed on that name (see `ownSnapshotName`), but only for the case
 * where it failed and never gave the run an ID. That defer deletes nothing that
 * still holds the name: the holder may be another build's snapshot that won a
 * name race, and a snapshot has nothing to say who created it. So a run ended
 * between the create and learning the ID leaves a READY snapshot until it
 * expires, as do an unnamed fallback and a cache-named snapshot.
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
        const data = event.data as { snapshotId?: string; name?: string };
        const ids: string[] = [];

        if (data.snapshotId !== undefined) {
          ids.push(String(data.snapshotId));
        }

        if (data.name !== undefined) {
          const { items } = await client.sandboxes.snapshots.list({
            name: data.name,
          });

          // Only a failed snapshot, which no longer holds the name and so
          // can't be a race winner's. One that holds it may be another run's.
          for (const snapshot of items) {
            if (snapshot.status === "FAILED") {
              ids.push(snapshot.id);
            }
          }
        }

        const { failed } = await deleteSnapshots(client, ids);

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
 * Cover a snapshot the run is about to take under a name, before it exists.
 * The defer deletes only a failed snapshot with the name, never one that holds
 * it. Call `releaseSnapshotName` once the run holds the ID and owns it by that.
 */
export const ownSnapshotName = (run: CiRunScope, name: string): void => {
  const key = `name:${name}`;

  if (run.snapshotCleanups.has(key)) {
    return;
  }

  run.snapshotCleanups.set(
    key,
    run.defer(`snapshot-name:${name}:cleanup`, {
      function: snapshotCleanupFunction(run.ci.client),
      data: { name },
    }),
  );
};

/**
 * The run holds the ID of what the name covered, or the name's snapshot isn't
 * its own, so the name's defer has nothing left to do.
 */
export const releaseSnapshotName = (run: CiRunScope, name: string): void => {
  const key = `name:${name}`;

  run.snapshotCleanups.get(key)?.abort();

  run.snapshotCleanups.delete(key);
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
