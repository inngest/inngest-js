/**
 * The safety net on the way out: any run the session's events started that is
 * still going is cancelled, and its cleanup gets a bounded time to destroy the
 * run's Sandboxes before the Dev Server and the app are stopped.
 *
 * @module
 */

import type { ActiveRun } from "./devServerApi.ts";

/** The suffix of a pipeline's generated cleanup function. */
const cleanupSuffix = "/cleanup";

export interface StrayDeps {
  listActive(): Promise<ActiveRun[]>;
  cancel(runId: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/**
 * Cancel every unfinished run that `eventIds` started, then wait until no
 * cleanup run is going either, for at most `graceMs`. Returns the IDs of the
 * runs it cancelled. Never throws: this runs while shutting down.
 */
export const cancelStrays = async (opts: {
  eventIds: string[];
  graceMs: number;
  pollMs: number;
  deps: StrayDeps;
}): Promise<string[]> => {
  const { eventIds, graceMs, pollMs, deps } = opts;
  const cancelled: string[] = [];
  const deadline = deps.now() + graceMs;

  const active = async (): Promise<ActiveRun[]> => {
    return deps.listActive().catch(() => {
      return [];
    });
  };

  const strays = (await active()).filter((run) => {
    return (
      !run.functionId.endsWith(cleanupSuffix) &&
      run.eventIds.some((id) => {
        return eventIds.includes(id);
      })
    );
  });

  for (const run of strays) {
    await deps.cancel(run.id).catch(() => undefined);

    cancelled.push(run.id);
  }

  if (cancelled.length === 0) {
    return cancelled;
  }

  // The cancel starts each pipeline's cleanup function, which destroys its
  // machines. Give those, and the cancelled runs, time to end.
  while (deps.now() < deadline) {
    await deps.sleep(pollMs);

    const left = (await active()).filter((run) => {
      return (
        cancelled.includes(run.id) || run.functionId.endsWith(cleanupSuffix)
      );
    });

    if (left.length === 0) {
      break;
    }
  }

  return cancelled;
};
