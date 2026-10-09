/**
 * A job's machines: creating them lazily, snapshotting them and destroying
 * them.
 *
 * @module
 */

import type { Inngest } from "inngest";
import { NonRetriableError } from "inngest";
import type { CachedSnapshot, CacheTarget } from "../cache/cache.ts";
import { deleteSnapshot, resolveTakenName } from "../cache/cache.ts";
import { CiUsageError } from "../errors.ts";
import type {
  CiJobScope,
  CiRunScope,
  MachineHandle,
} from "../pipeline/scope.ts";
import {
  defaultCwd,
  isRestoring,
  runInScope,
  scopeSeparator,
} from "../pipeline/scope.ts";
import type { MachineConfig } from "../types.ts";
import {
  boundedName,
  errorMessage,
  isSandboxNotFound,
  isSnapshotNotFound,
  slug,
} from "../util.ts";

/**
 * Memory is paired with vCPU count, so a job only picks one number.
 */
const memoryForVcpu = { 1: 1024, 2: 2048, 4: 4096 } as const;

export const resolveMachineConfig = (
  config: MachineConfig | undefined,
): { vcpu: 1 | 2 | 4; memoryMb: number } => {
  const vcpu = config?.vcpu ?? 2;

  return { vcpu, memoryMb: memoryForVcpu[vcpu] };
};

/**
 * The name a machine is created with. It carries the run ID so orphaned
 * machines can be found and destroyed by the cleanup function.
 */
export const machineName = (runId: string, path: string): string => {
  return boundedName(`ci-${runId}-${slug(path)}`);
};

/**
 * Create this scope's machine if it doesn't have one yet.
 *
 * Machines are lazy: a job that never runs a command never gets one, and
 * concurrent first commands share a single creation promise.
 */
export const ensureMachine = async (
  scope: CiJobScope,
): Promise<MachineHandle> => {
  scope.machine ??= createMachine(scope);

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
 * Run once on every machine before its first command.
 *
 * WORKAROUNDS (Sandboxes API), delete each part once the platform covers it:
 * - Commands run in `/work` by default, and a sandbox won't start a process in
 *   a directory that doesn't exist, so it's created here. `checkout()` also
 *   makes it, but a job doesn't have to check out.
 * - Sandboxes boot with the loopback interface down, so nothing can listen on
 *   or reach `127.0.0.1`, which breaks services started with `.background()`
 *   and `waitForHttp`/`waitForPort`. Bringing it up is a no-op once the
 *   platform does it itself.
 */
export const machineSetupScript = `mkdir -p ${defaultCwd} && (ip link set lo up 2>/dev/null || true)`;

/** A machine that has started and been set up. */
interface Started {
  // biome-ignore lint/suspicious/noExplicitAny: DurableSandbox
  sandbox: any;
}

const createMachine = async (scope: CiJobScope): Promise<MachineHandle> => {
  const { run } = scope;
  const tools = run.sandboxTools;

  if (!tools) {
    throw new CiUsageError(
      "This pipeline has no `step.sandbox` tools. `createCi` adds `sandboxMiddleware()` to the functions it creates, so this usually means the function was created another way.",
    );
  }

  const name = machineName(run.runId, scope.path);
  const stepId = `${scope.path}${scopeSeparator}machine`;

  const machineConfig = resolveMachineConfig(
    scope.config.machine ?? run.machine ?? run.ci.defaultMachine,
  );

  /** Create a machine, from a snapshot if one is given, and set it up. */
  const start = async (
    createStepId: string,
    options: { name: string; snapshotId?: string },
  ): Promise<Started> => {
    const sandbox = options.snapshotId
      ? await tools.create(createStepId, {
          name: options.name,
          snapshotId: options.snapshotId,
        })
      : await tools.create(createStepId, {
          name: options.name,
          ...machineConfig,
        });

    await sandbox.commands.run(`${createStepId}${scopeSeparator}setup`, [
      "/bin/sh",
      "-c",
      machineSetupScript,
    ]);

    return { sandbox };
  };

  const startFresh = (note: string) => {
    scope.fromSnapshotId = undefined;
    scope.startNote = note;
    scope.restoreFallback = scope.rebuildParent;

    run.ci.hooks.activity(run, scope.jobPath, note);

    return start(`${stepId}${scopeSeparator}fresh`, {
      name: machineName(run.runId, `${scope.path} fresh`),
    });
  };

  const parentId = scope.fromJobIds[0] ?? "the parent";
  const snapshotId = scope.fromSnapshotId;

  let started: Started;

  if (snapshotId) {
    run.ci.hooks.activity(
      run,
      scope.jobPath,
      scope.startNote ?? "creating machine…",
    );

    let probed: Started | undefined;

    /** Why the snapshot can't be used, if it can't. */
    let bad: string | undefined;

    try {
      probed = await start(stepId, { name, snapshotId });
    } catch (error) {
      if (!isStartFailure(error)) {
        throw error;
      }

      // The failed start still holds `name`, so what replaces it gets
      // another, and the stuck machine is cleared away meanwhile.
      await discardFailedStart(run, stepId, name, error);

      bad = `wouldn't start (${errorMessage(error)})`;
    }

    if (probed && !bad) {
      started = probed;
    } else {
      run.warnings.push(
        `fell back: snapshot of \`${parentId}\` ${bad}, so \`${scope.path}\` rebuilt it`,
      );

      const note = `rebuilding ${parentId} · bad snapshot`;

      scope.startNote = note;

      run.ci.hooks.activity(run, scope.jobPath, note);

      await deleteSnapshot(
        run,
        `${scope.path}${scopeSeparator}cache:delete`,
        snapshotId,
      );

      // Shared: jobs that found the same bad snapshot wait for one rebuild.
      const replacement = await scope.rebuildSnapshot?.();

      if (replacement) {
        scope.startNote = `starting ${parentId}`;

        run.ci.hooks.activity(run, scope.jobPath, scope.startNote);

        const retryStepId = `${stepId}${scopeSeparator}retry`;
        const retryName = machineName(run.runId, `${scope.path} retry`);

        try {
          started = await start(retryStepId, {
            name: retryName,
            snapshotId: replacement,
          });
        } catch (error) {
          if (!isStartFailure(error)) {
            throw error;
          }

          // Restores may still be broken while fresh machines work, which is
          // where this job went before there was a replacement to try.
          await discardFailedStart(run, retryStepId, retryName, error);

          started = await startFresh(note);
        }
      } else {
        started = await startFresh(note);
      }
    }
  } else {
    run.ci.hooks.activity(
      run,
      scope.jobPath,
      scope.startNote ?? "creating machine…",
    );

    started = await start(stepId, { name });
  }

  const handle: MachineHandle = {
    sandbox: started.sandbox,
    name,
    id: started.sandbox.id,
  };

  return handle;
};

/**
 * Best-effort cleanup of a machine that failed to start. The platform keeps
 * such a machine (stuck in STARTING) and its name, so it is destroyed here.
 *
 * Never throws: a machine that can't be cleaned up now must not fail the job.
 */
const discardFailedStart = async (
  run: CiRunScope,
  stepId: string,
  name: string,
  error: unknown,
): Promise<void> => {
  const knownId = (error as { cause?: { sandboxId?: string } })?.cause
    ?.sandboxId;

  try {
    await run.step.run(
      {
        id: `${stepId}${scopeSeparator}discard`,
        name: `${stepId}${scopeSeparator}discard`,
      },
      async (): Promise<{ id?: string }> => {
        // Errors are swallowed inside the step so it never retries.
        let id = knownId;

        try {
          let cursor: string | undefined;

          while (!id) {
            const page = await run.ci.client.sandboxes.list({
              ...(cursor ? { cursor } : {}),
              limit: 100,
            });

            id = page.items.find(
              (sandbox: { name: string; status: string }) => {
                return sandbox.name === name && sandbox.status !== "TERMINATED";
              },
            )?.id;

            if (id || !page.page.hasMore) {
              break;
            }

            cursor = page.page.cursor;
          }

          if (id) {
            const sandbox = await run.ci.client.sandboxes.get(id);

            await sandbox?.destroy();
          }
        } catch {
          // Left to expire with the rest of the run's machines.
        }

        return id ? { id } : {};
      },
    );
  } catch {
    // Best effort only.
  }
};

/**
 * Whether a machine failed to start, as opposed to a request that was refused.
 * Only a snapshot restore falls back on it: a plain machine that won't start
 * fails the job with its reason.
 */
const isStartFailure = (error: unknown): boolean => {
  const codes = ["sandbox_start_timed_out", "sandbox_start_failed"];

  return (
    codes.some((code) => {
      return hasCode(error, code);
    }) || /did not reach RUNNING/i.test(errorMessage(error))
  );
};

/** Whether a Sandboxes error has a code, on the error or the step error's cause. */
const hasCode = (error: unknown, code: string): boolean => {
  const seen = error as
    | { code?: string; cause?: { code?: string } }
    | undefined;

  return seen?.code === code || seen?.cause?.code === code;
};

/** A Sandboxes error's HTTP status, whether on the error or its cause. */
const errorStatus = (error: unknown): number | undefined => {
  const seen = error as
    | { status?: number; cause?: { status?: number } }
    | undefined;

  return seen?.status ?? seen?.cause?.status;
};

/** How a job's snapshot is named. */
export interface SnapshotCache {
  target: CacheTarget;
  /** A bad snapshot that may still hold the name, which must not be used. */
  exclude?: string;
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

  return takeSnapshot(run, scope.path, handle, cache);
};

const takeSnapshot = async (
  run: CiRunScope,
  jobPath: string,
  handle: MachineHandle,
  cache: SnapshotCache | undefined,
): Promise<TakenSnapshot | undefined> => {
  run.ci.hooks.activity(run, jobPath, "snapshotting machine…");

  const stepId = `${jobPath}${scopeSeparator}snapshot`;

  try {
    return cache
      ? await createNamedSnapshot(run, handle, stepId, cache)
      : await createRunSnapshot(handle, stepId);
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
 * If another build holds the name, its snapshot is used instead, or the
 * holder is deleted when it is about to expire or is the bad one being
 * replaced, and the create is tried again. Any other failure is the build's:
 * one the server refused as invalid is not retried.
 */
const createNamedSnapshot = async (
  run: CiRunScope,
  handle: MachineHandle,
  stepId: string,
  { target, exclude }: SnapshotCache,
): Promise<TakenSnapshot> => {
  const name = target.name;

  const attempt = async (id: string): Promise<TakenSnapshot> => {
    const snapshot = await handle.sandbox.snapshot(id, { name });

    return {
      snapshotId: snapshot.id,
      named: { snapshotId: snapshot.id, name, createdAt: snapshot.createdAt },
      reused: false,
    };
  };

  let taken: unknown;

  try {
    return await attempt(stepId);
  } catch (error) {
    if (!hasCode(error, nameTakenCode)) {
      throw refusedAsFatal(error, name);
    }

    taken = error;
  }

  const held = await resolveTakenName(
    run,
    `${stepId}${scopeSeparator}name-taken`,
    name,
    exclude,
  );

  if (held.winner) {
    // Another build got there first, with the same key, so its snapshot is
    // as good as this one.
    return {
      snapshotId: held.winner.snapshotId,
      named: held.winner,
      reused: true,
    };
  }

  if (!held.cleared) {
    throw taken;
  }

  try {
    return await attempt(`${stepId} (retry)`);
  } catch (error) {
    throw refusedAsFatal(error, name);
  }
};

/**
 * Make a create the server refused as invalid, such as a name it won't take,
 * fail the run for good: asking again gets the same answer. Anything else,
 * including the errors the caller treats as "snapshots unavailable", comes
 * back unchanged and takes the normal step retry.
 */
const refusedAsFatal = (error: unknown, name: string): unknown => {
  const status = errorStatus(error);

  const refused =
    status === 400 ||
    status === 422 ||
    (error as { name?: string } | undefined)?.name === "SandboxValidationError";

  if (!refused) {
    return error;
  }

  return new NonRetriableError(
    `the snapshot named \`${name}\` was refused (${errorMessage(error)})`,
    { cause: error },
  );
};

/**
 * Snapshot a machine that is kept for a person to look at, so no run's
 * cleanup deletes it.
 */
const createRunSnapshot = async (
  handle: MachineHandle,
  stepId: string,
): Promise<TakenSnapshot> => {
  const snapshot = await handle.sandbox.snapshot(stepId);

  return { snapshotId: snapshot.id, reused: false };
};

/** The code a create gets when another snapshot holds the name. */
const nameTakenCode = "sandbox_snapshot_name_taken";

/**
 * Whether a snapshot failed because snapshots can't be had here, as opposed
 * to a real failure. The caller falls back to re-running the parent rather
 * than failing the run.
 *
 * That is an environment that can't snapshot: an older Dev Server with no
 * snapshot endpoints (404, 501 or an "unsupported" message), or an account out
 * of snapshots (`sandbox_snapshot_limit_exceeded`). A refused or invalid
 * create is not one, and fails the build.
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
    {
      id: `pipeline${scopeSeparator}cleanup${attempt > 0 ? ` (attempt ${attempt})` : ""}`,
      name: "cleanup",
    },
    async () => {
      return destroyOrphans(run.ci.client, run.runId);
    },
  );
};

/**
 * Delete the snapshots the builds of this run left for it, once the run is
 * over: those of `from` parents without a cache.
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
    {
      id: `pipeline${scopeSeparator}cleanup:snapshots${attempt > 0 ? ` (attempt ${attempt})` : ""}`,
      name: "cleanup:snapshots",
    },
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
