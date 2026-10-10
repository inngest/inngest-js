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
import { matchesJob } from "../cache/names.ts";
import type { ListedSnapshot } from "../machine/admin.ts";
import { deleteSnapshots, findSnapshots } from "../machine/admin.ts";
import type { AnyJob } from "../types.ts";
import type { RegisteredJob } from "./job.ts";
import { ciStepOptions } from "./metadata.ts";
import { steps } from "./names.ts";

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

/** The most names an outcome lists, so it stays small however many go. */
const maxListedNames = 20;

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

      const found: ListedSnapshot[] = await step.run(
        ciStepOptions(steps.listCachedSnapshots(job, scope)),
        () => {
          return findSnapshots(client, ({ name }) => {
            return matchesJob(name, { job, scope, jobIds: [...jobs.keys()] });
          });
        },
      );

      const result: { deleted: number; skipped: number; names: string[] } =
        await step.run(
          ciStepOptions(steps.deleteCachedSnapshots(job)),
          async () => {
            // One still being made is in use; leave it.
            const ready = found.filter(({ status }) => {
              return status !== "CREATING";
            });

            let failure: unknown;

            // A retried step may meet snapshots that are already gone.
            const { deleted } = await deleteSnapshots(
              client,
              ready.map(({ id }) => {
                return id;
              }),
              (_id, error) => {
                failure ??= error;
              },
            );

            if (failure) {
              throw failure;
            }

            return {
              deleted: deleted.length,
              skipped: found.length - ready.length,
              names: found
                .filter(({ id }) => {
                  return deleted.includes(id);
                })
                .slice(0, maxListedNames)
                .map(({ id, name }) => {
                  return name ?? id;
                }),
            };
          },
        );

      return { outcome: "invalidated", job, ...result };
    },
  );
};
