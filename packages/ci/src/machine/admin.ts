/**
 * Deleting what a run created in the Sandboxes API, by ID: snapshot and
 * machine deletes that tolerate what is already gone. Cleanup steps and
 * invalidation go through these rather than writing the not-found handling
 * again. Nothing here lists the API: a run only ever touches what it holds the
 * ID of.
 *
 * @module
 */

import type { Inngest } from "inngest";
import { isSandboxNotFound, isSnapshotNotFound } from "../util.ts";

/**
 * Delete snapshots by ID. One that is already gone counts for nothing, and one
 * that can't be deleted is reported to `onFailure` and left to expire, so a
 * snapshot that stays never stops the rest.
 */
export const deleteSnapshots = async (
  client: Inngest.Any,
  ids: Iterable<string>,
  onFailure?: (id: string, error: unknown) => void,
): Promise<{ deleted: string[]; failed: string[] }> => {
  const deleted: string[] = [];
  const failed: string[] = [];

  for (const id of ids) {
    try {
      const snapshot = await client.sandboxes.snapshots.get(id);

      if (snapshot) {
        await snapshot.delete();

        deleted.push(id);
      }
    } catch (error) {
      if (isSnapshotNotFound(error)) {
        continue;
      }

      failed.push(id);

      onFailure?.(id, error);
    }
  }

  return { deleted, failed };
};

/**
 * Destroy machines by ID. One that is already gone counts for nothing. Any
 * other error is thrown, so the step that calls this retries.
 */
export const destroySandboxes = async (
  client: Inngest.Any,
  ids: Iterable<string>,
): Promise<{ destroyed: number }> => {
  let destroyed = 0;

  for (const id of ids) {
    try {
      const sandbox = await client.sandboxes.get(id);

      if (sandbox) {
        await sandbox.destroy();

        destroyed++;
      }
    } catch (error) {
      if (!isSandboxNotFound(error)) {
        throw error;
      }
    }
  }

  return { destroyed };
};
