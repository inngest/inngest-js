/**
 * Listing and deleting what CI's cleanup finds in the Sandboxes API: paged
 * lists read as one stream, and snapshot deletes that tolerate what is already
 * gone. Cleanup steps, run cleanup and invalidation all go through these
 * rather than writing the paging and not-found handling again.
 *
 * @module
 */

import type { Inngest } from "inngest";
import { isSnapshotNotFound } from "../util.ts";

/** A page of a list the Sandboxes API returns. */
export interface Page<T> {
  items: T[];
  page: { hasMore: boolean; cursor?: string };
}

/** Every item of a paged list, in order, fetching the next page as it is read. */
export async function* pages<T>(
  list: (cursor?: string) => Promise<Page<T>>,
): AsyncGenerator<T> {
  let cursor: string | undefined;

  do {
    const { items, page } = await list(cursor);

    yield* items;

    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
}

/** Every sandbox, whoever made it. */
export const listSandboxes = (client: Inngest.Any) => {
  return pages((cursor) => {
    return client.sandboxes.list({ ...(cursor ? { cursor } : {}), limit: 100 });
  });
};

/**
 * Every snapshot that still exists, whoever made it. The API keeps the records
 * of deleted ones in its lists, which are not snapshots any more.
 */
export async function* listSnapshots(client: Inngest.Any) {
  const all = pages((cursor) => {
    return client.sandboxes.snapshots.list({
      ...(cursor ? { cursor } : {}),
      limit: 100,
    });
  });

  for await (const snapshot of all) {
    if (!/^DELET/.test(snapshot.status)) {
      yield snapshot;
    }
  }
}

/**
 * Delete the snapshots whose name matches. Listing has no name filter beyond
 * an exact one, so the comparison happens here.
 */
export const deleteMatching = async (
  client: Inngest.Any,
  matches: (name: string) => boolean,
  onFailure?: (id: string, error: unknown) => void,
): Promise<{ deleted: string[]; failed: string[] }> => {
  const ids: string[] = [];

  for await (const snapshot of listSnapshots(client)) {
    if (snapshot.name && matches(snapshot.name)) {
      ids.push(snapshot.id);
    }
  }

  return deleteSnapshots(client, ids, onFailure);
};

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
