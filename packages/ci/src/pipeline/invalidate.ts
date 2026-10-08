/**
 * Invalidating a job's cached images by hand: the event that asks for it, the
 * helper that builds the event, and the generated function that deletes the
 * job's cached snapshots.
 *
 * Only snapshots go. Running sandboxes are unaffected, and the job's next run
 * that misses its name builds again.
 *
 * @module
 */

import type { Inngest, InngestFunction } from "inngest";
import { NonRetriableError } from "inngest";
import { clientSnapshots } from "../cache/cache.ts";
import type { AnyJob } from "../types.ts";
import { boundedPrefix, isSnapshotNotFound } from "../util.ts";
import type { RegisteredJob } from "./job.ts";
import { withNotes } from "./metadata.ts";
import { ciStep } from "./names.ts";

/** The event that invalidates a job's cached images. */
export const invalidateEventName = "ci/base-image.invalidate";

/** The ID of the generated function that handles it. */
export const invalidateFunctionId = "ci/invalidate";

/** What the event carries. */
export interface InvalidateData extends Record<string, unknown> {
  /** The ID of a job registered on the client. */
  job: string;
  /** Limits the deletion to one scope: a branch, `pr:<n>`, `global` or `local`. */
  scope?: string;
}

/**
 * The event that deletes a job's cached images, for `inngest.send`. Without a
 * `scope` it deletes them in every scope. Running sandboxes are unaffected,
 * and the job's next run builds again.
 *
 * ```ts
 * await inngest.send(invalidateEvent(nodeBase, { scope: "main" }));
 * ```
 */
export const invalidateEvent = (
  job: AnyJob | string,
  opts: {
    /** Only delete the images cached in this scope. */
    scope?: string;
  } = {},
): { name: typeof invalidateEventName; data: InvalidateData } => {
  return {
    name: invalidateEventName,
    data: {
      job: typeof job === "string" ? job : job.id,
      ...(opts.scope === undefined ? {} : { scope: opts.scope }),
    },
  };
};

/** A snapshot as the invalidation sees it. */
interface Named {
  id: string;
  name?: string;
  status?: string;
}

/** The most names an outcome lists, so it stays small however many go. */
const maxListedNames = 20;

/**
 * Whether the start of a cut name is consistent with a full one: either one
 * begins with the other, so the cut fell inside or after the part compared.
 */
const consistent = (kept: string, expected: string): boolean => {
  return kept.startsWith(expected) || expected.startsWith(kept);
};

/**
 * Whether the start of a cut name could belong to this job in some scope. The
 * cut may fall inside the job segment, so a tail of the kept start that begins
 * a `/<job>/` counts too.
 */
const consistentInAnyScope = (kept: string, job: string): boolean => {
  const marker = `/${job}/`;

  if (kept.includes(marker)) {
    return true;
  }

  for (let i = kept.indexOf("/"); i >= 0; i = kept.indexOf("/", i + 1)) {
    if (marker.startsWith(kept.slice(i))) {
      return true;
    }
  }

  return false;
};

/** Longer registered job IDs that end in `/<job>`, which `<job>` could be mistaken for. */
const longerSiblings = (job: string, jobIds: string[]): string[] => {
  return jobIds.filter((id) => {
    return id !== job && id.endsWith(`/${job}`);
  });
};

/**
 * The snapshot names `ci/<scope>/<job>/<key>` that are this job's, in this
 * scope or any. A name too long for a snapshot was cut to a prefix and a hash,
 * so it matches by its prefix, and may match more than it should: deleting too
 * much only costs a rebuild.
 */
const isJobsSnapshot = ({
  name,
  job,
  scope,
  siblings,
}: {
  name: string | undefined;
  job: string;
  scope: string | undefined;
  /** Other registered job IDs that end in `/<job>`. */
  siblings: string[];
}): boolean => {
  if (!name?.startsWith("ci/")) {
    return false;
  }

  const kept = boundedPrefix(name);

  if (kept !== undefined) {
    const longer = siblings.some((id) => {
      return kept.includes(`/${id}/`);
    });

    if (longer) {
      return false;
    }

    if (scope !== undefined) {
      return consistent(kept, `ci/${scope}/${job}/`);
    }

    return consistentInAnyScope(kept, job);
  }

  const rest = name.slice("ci/".length);
  const keyStart = rest.lastIndexOf("/");

  if (keyStart < 0) {
    return false;
  }

  // The key is the last segment, and the job is the one before it.
  const head = rest.slice(0, keyStart);

  if (scope !== undefined) {
    return head === `${scope}/${job}`;
  }

  if (!head.endsWith(`/${job}`) || head.length <= job.length + 1) {
    return false;
  }

  // `b` also ends the name of job `a/b`; that name belongs to the longer job.
  return !siblings.some((id) => {
    return head.endsWith(`/${id}`);
  });
};

/**
 * Delete every cached snapshot of a job. The function does nothing if the job
 * isn't registered on this client, because apps that share an environment all
 * receive the event.
 */
export const invalidateFunction = ({
  client,
  jobs,
}: {
  client: Inngest.Any;
  jobs: Map<string, RegisteredJob>;
}): InngestFunction.Any => {
  return client.createFunction(
    {
      id: invalidateFunctionId,
      name: "invalidate",
      triggers: [{ event: invalidateEventName }],
    },
    // biome-ignore lint/suspicious/noExplicitAny: SDK ctx
    async ({ event, step }: any) => {
      const { job, scope } = event.data as Partial<InvalidateData>;

      if (typeof job !== "string" || job === "") {
        throw new NonRetriableError(
          `${invalidateEventName} needs a "job" in its data.`,
        );
      }

      if (scope !== undefined && (typeof scope !== "string" || scope === "")) {
        throw new NonRetriableError(
          `The "scope" of ${invalidateEventName} must be a non-empty string.`,
        );
      }

      if (!jobs.has(job)) {
        return { outcome: "unknown-job", job };
      }

      const snapshots = clientSnapshots(client);

      const siblings = longerSiblings(job, [...jobs.keys()]);

      const found: Named[] = await step.run(
        ciStep("list-snapshots", "List cached snapshots"),
        () => {
          return withNotes(
            { ci: {} },
            {
              intent: `List the cached snapshots of \`${job}\`${scope ? ` in \`${scope}\`` : ""}`,
            },
            async (note) => {
              const matched: Named[] = [];
              let cursor: string | undefined;

              // The list can't filter by prefix, so read every page.
              do {
                const page = await snapshots.list({
                  limit: 250,
                  ...(cursor ? { cursor } : {}),
                });

                for (const item of page.items as Named[]) {
                  if (
                    isJobsSnapshot({ name: item.name, job, scope, siblings })
                  ) {
                    matched.push({
                      id: item.id,
                      name: item.name,
                      status: item.status,
                    });
                  }
                }

                cursor = page.page?.hasMore ? page.page.cursor : undefined;
              } while (cursor);

              note.outcome({ found: matched.length });

              return matched;
            },
          );
        },
      );

      const result: { deleted: number; skipped: number; names: string[] } =
        await step.run(
          ciStep("delete-snapshots", "Delete cached snapshots"),
          () => {
            return withNotes(
              { ci: {} },
              { intent: `Delete the cached snapshots of \`${job}\`` },
              async (note) => {
                const names: string[] = [];
                let deleted = 0;
                let skipped = 0;

                for (const { id, name, status } of found) {
                  // One still being made is in use; leave it.
                  if (status === "CREATING") {
                    skipped++;

                    continue;
                  }

                  try {
                    // A retried step may meet snapshots that are already gone.
                    const snapshot = await snapshots.get(id);

                    if (!snapshot) {
                      continue;
                    }

                    if (snapshot.status === "CREATING") {
                      skipped++;

                      continue;
                    }

                    await snapshot.delete();
                  } catch (error) {
                    if (isSnapshotNotFound(error)) {
                      continue;
                    }

                    throw error;
                  }

                  deleted++;

                  if (names.length < maxListedNames) {
                    names.push(name ?? id);
                  }
                }

                note.outcome({ deleted, skipped });

                return { deleted, skipped, names };
              },
            );
          },
        );

      return { outcome: "invalidated", job, ...result };
    },
  );
};
