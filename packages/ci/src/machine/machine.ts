/**
 * A job's machines: creating them lazily, snapshotting them and destroying
 * them.
 *
 * @module
 */

import type { Inngest } from "inngest";
import type { CachedSnapshot, CacheTarget } from "../cache/cache.ts";
import { resolveTakenName } from "../cache/cache.ts";
import { ciStep, spans, traceName } from "../pipeline/names.ts";
import type {
  CiJobScope,
  CiRunScope,
  MachineHandle,
} from "../pipeline/scope.ts";
import {
  inJobSpan,
  isRestoring,
  joinId,
  runInScope,
  scopeSeparator,
} from "../pipeline/scope.ts";
import {
  inSnapshotSpan,
  inSpan,
  snapshotSpanOption,
} from "../pipeline/spans.ts";
import {
  errorMessage,
  isSandboxNotFound,
  isSnapshotNotFound,
} from "../util.ts";
import { errorStatus, hasCode } from "./sandboxErrors.ts";
import { startMachine } from "./start.ts";

/**
 * Create this scope's machine if it doesn't have one yet.
 *
 * Machines are lazy: a job that never runs a command never gets one, and
 * concurrent first commands share a single creation promise. Its steps are in
 * a span of its own, in its job's span rather than the first command's.
 */
export const ensureMachine = async (
  scope: CiJobScope,
): Promise<MachineHandle> => {
  scope.machine ??= inJobSpan(scope.run, scope.jobPath, () => {
    return inMachineSpan(scope, () => {
      const stepId = joinId(scope.path, "machine");

      // Everything in it is CI's work, including falling back from a
      // snapshot that won't start.
      const span = spans.startMachine(stepId, scope.fromJobIds[0]);

      return inSpan(span, () => {
        return startMachine(scope, stepId);
      });
    });
  });

  const handle = await scope.machine;

  // A snapshot that wouldn't start left a fresh machine that still has to be
  // brought to where the snapshot would have been. Every command waits for
  // that, except the ones it runs itself, which call back here.
  const rebuild = scope.restoreFallback;

  if (rebuild) {
    scope.restoreFallback = undefined;

    scope.fallbackRan = runInScope(
      { run: scope.run, job: scope, restoring: scope },
      rebuild,
    );
  }

  if (scope.fallbackRan && !isRestoring(scope)) {
    await scope.fallbackRan;
  }

  return handle;
};

/**
 * Run `fn` in an extra machine's span, so its commands sit apart from the
 * job's own. A job's own machine has none: the job's span is its span.
 */
export const inMachineSpan = <R>(scope: CiJobScope, fn: () => R): R => {
  if (scope.path === scope.jobPath) {
    return fn();
  }

  return inSpan(spans.extraMachine(scope.path, scope.jobPath), fn);
};
/** How a job's snapshot is named. */
export interface SnapshotCache {
  target: CacheTarget;
  /** A snapshot that may still hold the name, which must not be used. */
  exclude?: string;
  /** Whether `exclude` was decided to be broken, so it may be deleted. */
  broken?: boolean;
  /**
   * Take the snapshot without the name, which another build may be taking or a
   * snapshot that can't be deleted still holds. It belongs to this run, which
   * deletes it at its end.
   */
  unnamed?: boolean;
  /**
   * Set when the job has no `cache` and the name is only for this run, so
   * failing to name it isn't worth a warning.
   */
  ephemeral?: boolean;
}

/** A snapshot of a job's machine. */
export interface TakenSnapshot {
  snapshotId: string;
  /** Set when the snapshot is held under a name. */
  named?: CachedSnapshot;
  /** Whether another build had already taken it. */
  reused: boolean;
}

/**
 * A snapshot step: its ID is the step's, its name reads as an action. Saving
 * a job's sandbox is one statement, so its row is the job's "Save sandbox"
 * span, which the SDK is told of where it can take it.
 */
const snapshotStep = (jobPath: string, id: string) => {
  return {
    id,
    name: traceName.snapshotMachine,
    ...snapshotSpanOption(spans.save(jobPath)),
  };
};

/**
 * Snapshot a job's own machine, which is the end of a build or a failed job
 * that keeps its machine. With a cache, the snapshot is named after the job's
 * key.
 *
 * Returns `undefined` when the job had no machine, or when snapshots aren't
 * available in this environment, in which case callers fall back to a fresh
 * machine.
 */
export const snapshotMachine = async (
  scope: CiJobScope,
  cache?: SnapshotCache,
): Promise<TakenSnapshot | undefined> => {
  const { run } = scope;

  if (!scope.machine) {
    return undefined;
  }

  const handle = await scope.machine;

  return inSnapshotSpan(spans.save(scope.path), () => {
    return takeSnapshot(run, scope.path, handle, cache);
  });
};

const takeSnapshot = async (
  run: CiRunScope,
  jobPath: string,
  handle: MachineHandle,
  cache: SnapshotCache | undefined,
): Promise<TakenSnapshot | undefined> => {
  run.ci.hooks.activity(run, jobPath, "snapshotting machine…");

  const stepId = joinId(jobPath, "snapshot");

  try {
    return cache && !cache.unnamed
      ? await createNamedSnapshot(run, handle, jobPath, stepId, cache)
      : await createRunSnapshot(handle, jobPath, stepId);
  } catch (error) {
    if (!isSnapshotUnavailable(error)) {
      throw error;
    }

    run.warnings.push(
      `fell back: snapshots unavailable (\`${jobPath}\`), so jobs started from it re-ran it on their own machines`,
    );

    return undefined;
  }
};

/**
 * Snapshot a job's machine under its name. A named snapshot is never added to
 * `run.createdSnapshots`: the run that invoked the build adds one that isn't
 * the job's cache, and a cached one is left for later runs, as is one adopted
 * from a name race winner.
 *
 * If another build holds the name, its snapshot is used instead. If the name
 * is refused, as by a server without snapshot names, the snapshot is taken
 * without one: the invoking run still starts from it, but nothing is cached.
 */
const createNamedSnapshot = async (
  run: CiRunScope,
  handle: MachineHandle,
  jobPath: string,
  stepId: string,
  { target, exclude, broken, ephemeral }: SnapshotCache,
): Promise<TakenSnapshot> => {
  const name = target.name;

  const attempt = async (id: string): Promise<TakenSnapshot> => {
    const snapshot = await handle.sandbox.snapshot(snapshotStep(jobPath, id), {
      name,
    });

    return {
      snapshotId: snapshot.id,
      named: { snapshotId: snapshot.id, name, createdAt: snapshot.createdAt },
      reused: false,
    };
  };

  let refusal: unknown;

  try {
    return await attempt(stepId);
  } catch (error) {
    if (!hasCode(error, nameTakenCode)) {
      if (!isNameRefused(error)) {
        throw error;
      }

      refusal = error;
    }
  }

  if (!refusal) {
    const taken = await resolveTakenName(
      run,
      `${stepId}${scopeSeparator}name-taken`,
      name,
      exclude,
      broken,
    );

    if (taken.winner) {
      // Another build got there first, with the same key, so its snapshot is
      // as good as this one.
      return {
        snapshotId: taken.winner.snapshotId,
        named: taken.winner,
        reused: true,
      };
    }

    if (taken.cleared) {
      try {
        return await attempt(`${stepId} (retry)`);
      } catch (error) {
        refusal = error;
      }
    }
  }

  if (!ephemeral) {
    run.warnings.push(
      `not cached: the snapshot of \`${jobPath}\` couldn't be named${refusal ? ` (${errorMessage(refusal)})` : ""}, so later runs build it again`,
    );
  }

  const unnamed = await handle.sandbox.snapshot(
    snapshotStep(jobPath, `${stepId} (unnamed)`),
  );

  // The name was refused or couldn't be freed, so the job's snapshot falls
  // back to an unnamed one that no later run can find. The run that invoked
  // the build deletes it at its own end, like any run-only snapshot: the
  // build's own cleanup would delete it while that run still starts jobs from
  // it.
  return { snapshotId: unnamed.id, reused: false };
};

/**
 * Snapshot a machine that is kept for a person to look at, so no run's
 * cleanup deletes it.
 */
const createRunSnapshot = async (
  handle: MachineHandle,
  jobPath: string,
  stepId: string,
): Promise<TakenSnapshot> => {
  const snapshot = await handle.sandbox.snapshot(snapshotStep(jobPath, stepId));

  return { snapshotId: snapshot.id, reused: false };
};

/** The code a create gets when another snapshot holds the name. */
const nameTakenCode = "sandbox_snapshot_name_taken";

/**
 * Whether a named snapshot was refused for its name, so taking it without one
 * may work.
 *
 * WORKAROUND (Sandboxes API): a server without snapshot names, such as an
 * older Dev Server, refuses a create with a name as a bad request. Delete this
 * once none is left.
 */
const isNameRefused = (error: unknown): boolean => {
  const status = errorStatus(error);

  return (
    status === 400 ||
    status === 422 ||
    (error as { name?: string } | undefined)?.name === "SandboxValidationError"
  );
};

/**
 * Whether a snapshot failed because snapshots can't be had here, as opposed
 * to a real failure. The caller falls back to re-running the parent rather
 * than failing the run.
 *
 * WORKAROUND (Sandboxes API): older Dev Servers have no snapshot endpoints
 * (404, 501 or an "unsupported" message), and an environment can run out of
 * snapshots (`sandbox_snapshot_limit_exceeded`). Delete this once neither
 * happens; a real failure should then always surface.
 */
const isSnapshotUnavailable = (error: unknown): boolean => {
  const cause = (error as { cause?: { code?: string; status?: number } })
    ?.cause;

  const limitCode = "sandbox_snapshot_limit_exceeded";

  if (cause?.status === 404 || cause?.status === 501) {
    return true;
  }

  if (
    cause?.code === limitCode ||
    (error as { code?: string })?.code === limitCode
  ) {
    return true;
  }

  const message = errorMessage(error).toLowerCase();

  return [
    "not implemented",
    "unsupported",
    "not supported",
    "404",
    "no route",
    "unknown action",
  ].some((text) => {
    return message.includes(text);
  });
};

/**
 * Destroy every machine this run created, which the Sandboxes API lists by the
 * run's name prefix. Tolerates machines that are already gone, because cleanup
 * also runs after failures.
 *
 * The step is always there and reads the list when it runs: how many machines
 * exist now depends on how far each sibling got in this request, so a request
 * that sees none must still plan what another found.
 */
export const destroyRunMachines = async (
  run: CiRunScope,
  attempt = 0,
): Promise<void> => {
  await run.step.run(
    ciStep(
      `pipeline${scopeSeparator}cleanup${attempt > 0 ? ` (attempt ${attempt})` : ""}`,
      traceName.cleanUpMachines,
    ),
    async () => {
      return destroyOrphans(run.ci.client, run.runId);
    },
  );
};

/**
 * Delete the snapshots the builds of this run left for it, once the run is
 * over: those of `from` parents without a cache, and unnamed fallbacks.
 * Cache entries and `keepOnFailure` snapshots aren't in the set, and one the
 * run only restored never was.
 *
 * A build run deletes none: other builds in the pipeline share its snapshots,
 * so it hands them to the run that invoked it, and the root run deletes them.
 *
 * Best effort, in one step: a snapshot that can't be deleted is logged and
 * left to expire, and never fails the run.
 */
export const deleteRunSnapshots = async (
  run: CiRunScope,
  attempt = 0,
): Promise<void> => {
  if (run.build) {
    return;
  }

  // Always there, and reads the set when it runs, for the reason cleaning up
  // machines is.
  await run.step.run(
    ciStep(
      `pipeline${scopeSeparator}cleanup:snapshots${attempt > 0 ? ` (attempt ${attempt})` : ""}`,
      traceName.cleanUpSnapshots,
    ),
    async () => {
      const deleted: string[] = [];
      const failed: string[] = [];

      for (const id of [...run.createdSnapshots]) {
        try {
          const snapshot = await run.ci.client.sandboxes.snapshots.get(id);

          if (snapshot) {
            await snapshot.delete();

            deleted.push(id);
          }
        } catch (error) {
          if (isSnapshotNotFound(error)) {
            continue;
          }

          failed.push(id);

          run.ci.logger?.warn(
            { snapshotId: id, error },
            "Couldn't delete a snapshot this run took; it will expire on its own",
          );
        }
      }

      return { deleted, failed };
    },
  );
};

/**
 * A run that ended permanently never reached its own cleanup step, so its
 * machines are found by name. Listing has no name filter, so the comparison
 * happens here.
 */
export const destroyOrphans = async (
  client: Inngest.Any,
  runId: string,
): Promise<{ destroyed: number }> => {
  const prefix = `ci-${runId}-`;
  let cursor: string | undefined;
  let destroyed = 0;

  do {
    const page = await client.sandboxes.list({
      ...(cursor ? { cursor } : {}),
      limit: 100,
    });

    for (const sandbox of page.items) {
      if (sandbox.name.startsWith(prefix)) {
        try {
          await sandbox.destroy();

          destroyed++;
        } catch (error) {
          // Anything but "not found" fails the step so it retries.
          if (!isSandboxNotFound(error)) {
            throw error;
          }
        }
      }
    }

    cursor = page.page.hasMore ? page.page.cursor : undefined;
  } while (cursor);

  return { destroyed };
};
