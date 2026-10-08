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
import type { AnyJob } from "../types.ts";
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
}

/** The snapshot names `ci/<scope>/<job>/<key>` that are this job's, in this scope or any. */
const isJobsSnapshot = (
  name: string | undefined,
  job: string,
  scope: string | undefined,
): boolean => {
  if (!name?.startsWith("ci/")) {
    return false;
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

  return head.endsWith(`/${job}`) && head.length > job.length + 1;
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

      // biome-ignore lint/suspicious/noExplicitAny: the SDK's snapshots client
      const snapshots = (client as any).sandboxes.snapshots;

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
                  if (isJobsSnapshot(item.name, job, scope)) {
                    matched.push({ id: item.id, name: item.name });
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

      const deleted: string[] = await step.run(
        ciStep("delete-snapshots", "Delete cached snapshots"),
        () => {
          return withNotes(
            { ci: {} },
            { intent: `Delete the cached snapshots of \`${job}\`` },
            async (note) => {
              const names: string[] = [];

              for (const { id, name } of found) {
                // A retried step may meet snapshots that are already gone.
                const snapshot = await snapshots.get(id);

                if (!snapshot) {
                  continue;
                }

                await snapshot.delete();

                names.push(name ?? id);
              }

              note.outcome({ deleted: names.length, names });

              return names;
            },
          );
        },
      );

      return {
        outcome: "invalidated",
        job,
        deleted: deleted.length,
        names: deleted,
      };
    },
  );
};
