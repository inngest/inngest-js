/**
 * The safety net on the way out: any run the session's event started that is
 * still going is cancelled, and its cleanup gets a bounded time to destroy the
 * run's Sandboxes before the Dev Server and the app are stopped.
 *
 * @module
 */

import { setTimeout as sleep } from "node:timers/promises";

import type { RunInfo } from "./devServer.ts";

/** The suffix of a pipeline's generated cleanup function. */
const cleanupSuffix = "/cleanup";

/**
 * Cancel every unfinished run that `eventIds` started, then wait until no
 * cancelled or cleanup run is going either, for at most `graceMs`. Returns the
 * IDs of the runs it cancelled. Never throws: this runs while shutting down.
 */
export const cancelStrays = async (opts: {
  eventIds: string[];
  graceMs: number;
  pollMs: number;
  listRuns(): Promise<RunInfo[]>;
  cancel(runId: string): Promise<void>;
}): Promise<string[]> => {
  const active = async (): Promise<RunInfo[]> => {
    const runs = await opts.listRuns().catch(() => {
      return [];
    });

    return runs.filter((run) => {
      return !run.terminal;
    });
  };

  const cancelled: string[] = [];

  for (const run of await active()) {
    const started = run.eventIds.some((id) => {
      return opts.eventIds.includes(id);
    });

    if (started && !run.functionId.endsWith(cleanupSuffix)) {
      await opts.cancel(run.id).catch(() => {});

      cancelled.push(run.id);
    }
  }

  // The cancel starts each pipeline's cleanup function, which destroys its
  // machines. Give those, and the cancelled runs, time to end.
  const deadline = Date.now() + opts.graceMs;

  while (cancelled.length > 0 && Date.now() < deadline) {
    await sleep(opts.pollMs);

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
