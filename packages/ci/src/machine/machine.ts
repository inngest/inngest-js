/**
 * A job's machines: creating them lazily, pausing, snapshotting and
 * destroying them.
 *
 * @module
 */

import type { CacheTarget } from "../cache/cache.ts";
import {
  deleteSnapshot,
  resolveTakenName,
  staleParentOf,
} from "../cache/cache.ts";
import { CiUsageError } from "../errors.ts";
import type {
  CiJobScope,
  CiRunScope,
  MachineHandle,
} from "../pipeline/scope.ts";
import { defaultCwd, scopeSeparator } from "../pipeline/scope.ts";
import type { MachineConfig } from "../types.ts";
import {
  boundedName,
  errorMessage,
  isSandboxNotFound,
  isSnapshotNotFound,
  slug,
} from "../util.ts";
import type { SnapshotMeta, SnapshotParent } from "./snapshotMeta.ts";
import {
  parseSnapshotMeta,
  snapshotMetaPath,
  writeSnapshotMetaCommand,
} from "./snapshotMeta.ts";

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
  // brought to where the snapshot would have been. The commands that does
  // run call back here, and must not wait on it.
  if (scope.restoreFallback && !scope.restoringFallback) {
    scope.fallbackRan ??= (async () => {
      const rebuild = scope.restoreFallback;

      scope.restoringFallback = true;
      scope.restoreFallback = undefined;

      try {
        await rebuild?.();
      } finally {
        scope.restoringFallback = false;
      }
    })();

    await scope.fallbackRan;
  }

  return handle;
};

/**
 * Run once on every machine before its first command. It prints the
 * snapshot's metadata, which a machine started from a snapshot has.
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
export const machineSetupScript = `mkdir -p ${defaultCwd} && (ip link set lo up 2>/dev/null || true) && (cat ${snapshotMetaPath} 2>/dev/null || true)`;

/** A machine that has started and been set up. */
interface Started {
  // biome-ignore lint/suspicious/noExplicitAny: DurableSandbox
  sandbox: any;
  /** The snapshot it started from, if any. */
  from?: string;
  /** What that snapshot says about itself, if it says anything. */
  meta?: SnapshotMeta;
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

    run.sandboxes.add(sandbox.id);

    const setup = await sandbox.commands.run(
      `${createStepId}${scopeSeparator}setup`,
      ["/bin/sh", "-c", machineSetupScript],
    );

    if (!options.snapshotId) {
      return { sandbox };
    }

    const meta = parseSnapshotMeta(setup?.stdout ?? "");

    return {
      sandbox,
      from: options.snapshotId,
      ...(meta ? { meta } : {}),
    };
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

    // A cached snapshot is checked against what its parents' jobs would use
    // now, which only the metadata inside it can say.
    const cachedParent = scope.fromCached[parentId]?.snapshotId === snapshotId;

    if (probed?.meta && cachedParent) {
      const stale = await staleParentOf(
        run,
        `${scope.path}${scopeSeparator}cache:verify`,
        scope.path,
        probed.meta,
      );

      if (stale) {
        bad = `was built from an older \`${stale}\``;

        await discardStale(stepId, probed);
      }
    }

    if (probed && !bad) {
      started = probed;
    } else {
      run.warnings.push(
        `fell back: snapshot of \`${parentId}\` ${bad}, so \`${scope.path}\` rebuilt it`,
      );

      const note = `rebuilding ${parentId} · ${probed ? "stale snapshot" : "bad snapshot"}`;

      await deleteSnapshot(
        run,
        `${scope.path}${scopeSeparator}cache:delete`,
        snapshotId,
      );

      started = await startFresh(note);
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
    parents: parentsOf(scope, started),
  };

  run.machines.set(scope.path, Promise.resolve(handle));

  return handle;
};

/**
 * The cached snapshots a machine was built from: those its snapshot was built
 * from, plus the snapshot itself if it is a cached job's. A cached parent this
 * machine didn't start from, because the parent re-ran here instead, is
 * recorded with no snapshot, so a restore never trusts it.
 */
const parentsOf = (
  scope: CiJobScope,
  started: Started,
): Record<string, SnapshotParent> => {
  const parents = started.from ? { ...started.meta?.parents } : {};

  for (const jobId of scope.fromJobIds) {
    const cached = scope.fromCached[jobId];

    if (!cached) {
      continue;
    }

    const input = scope.fromInputs[jobId];

    parents[jobId] = {
      name: cached.name,
      snapshotId: started.from === cached.snapshotId ? cached.snapshotId : "",
      ...(input === undefined ? {} : { input }),
    };
  }

  return parents;
};

/**
 * Best-effort cleanup of a machine that started from a stale snapshot, so it
 * isn't kept running while the parent is rebuilt. It is destroyed with the
 * run's machines anyway.
 */
const discardStale = async (
  stepId: string,
  started: Started,
): Promise<void> => {
  try {
    await started.sandbox.destroy(`${stepId}${scopeSeparator}stale`);
  } catch {
    // Best effort only.
  }
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

/**
 * How long a pause may wait for the sandbox to report PAUSED. The SDK's
 * default is 5 minutes, and a pause the platform accepts but never completes
 * (the sandbox goes back to STARTING) would hold the whole pipeline that long
 * for what is only an optimisation. A healthy pause takes about 10 seconds.
 */
export const pauseTimeoutMs = 30_000;

/**
 * Pause a finished job's machine rather than destroying it, so a later
 * `from()` can still snapshot it. Everything is destroyed at the end of the
 * run.
 */
export const pauseMachine = async (scope: CiJobScope): Promise<void> => {
  if (!scope.machine) {
    return;
  }

  try {
    const machine = await scope.machine;

    await machine.sandbox.pause(`${scope.path}${scopeSeparator}pause`, {
      timeout: pauseTimeoutMs,
    });
  } catch (error) {
    // Pausing is an optimisation; a machine that can't pause is still
    // destroyed at the end of the run.
    scope.run.warnings.push(
      `Could not pause \`${scope.path}\`: ${errorMessage(error)}`,
    );
  }
};

/** How a job's snapshot is named. */
export interface SnapshotCache {
  target: CacheTarget;
}

/**
 * Snapshot a job's machine, once per job per run. With a cache, the snapshot
 * is named after the job's key and outlives the run. Without, it is deleted
 * when the run ends.
 *
 * Returns `undefined` when the job had no machine, or when snapshots aren't
 * available in this environment, in which case callers fall back to a fresh
 * machine.
 */
export const snapshotJob = (
  run: CiRunScope,
  jobPath: string,
  cache?: SnapshotCache,
): Promise<string | undefined> => {
  const existing = run.snapshots.get(jobPath);

  if (existing) {
    return existing;
  }

  const created = createSnapshot(run, jobPath, cache);

  run.snapshots.set(jobPath, created);

  return created;
};

const createSnapshot = async (
  run: CiRunScope,
  jobPath: string,
  cache: SnapshotCache | undefined,
): Promise<string | undefined> => {
  const cached = run.cachedSnapshots.get(jobPath);

  if (cached) {
    return cached.snapshotId;
  }

  const handle = await run.machines.get(jobPath);

  if (!handle) {
    return undefined;
  }

  // Already found to be unavailable earlier in this run.
  if (run.snapshotsUnavailable) {
    return undefined;
  }

  try {
    // A paused machine has to be running again before it can be snapshotted.
    await handle.sandbox.resume(`${jobPath}${scopeSeparator}resume`);
  } catch {
    // Already running, or resume isn't supported here. The snapshot below
    // decides whether this actually mattered.
  }

  run.ci.hooks.activity(run, jobPath, "snapshotting machine…");

  await handle.sandbox.commands.run(
    `${jobPath}${scopeSeparator}snapshot:meta`,
    writeSnapshotMetaCommand({ parents: handle.parents }),
  );

  const stepId = `${jobPath}${scopeSeparator}snapshot`;

  try {
    if (!cache) {
      const snapshot = await handle.sandbox.snapshot(stepId);

      run.createdSnapshots.add(snapshot.id);

      return snapshot.id;
    }

    return await createNamedSnapshot(run, handle, jobPath, stepId, cache);
  } catch (error) {
    if (!isSnapshotUnavailable(error)) {
      throw error;
    }

    run.snapshotsUnavailable = true;

    run.warnings.push(
      `fell back: snapshots unavailable (\`${jobPath}\`), so jobs started from it re-ran it on their own machines`,
    );

    return undefined;
  }
};

/**
 * Snapshot a job's machine under its name. A named snapshot is never added to
 * `run.createdSnapshots`: it is left for later runs.
 *
 * If another run holds the name, its snapshot is used instead. If the name is
 * refused, as by a server without snapshot names, the snapshot is taken
 * without one: jobs in this run still start from it, but nothing is cached.
 */
const createNamedSnapshot = async (
  run: CiRunScope,
  handle: MachineHandle,
  jobPath: string,
  stepId: string,
  { target }: SnapshotCache,
): Promise<string> => {
  const name = target.name;

  const attempt = async (id: string): Promise<string> => {
    const snapshot = await handle.sandbox.snapshot(id, { name });

    run.cachedSnapshots.set(jobPath, {
      snapshotId: snapshot.id,
      name,
      createdAt: snapshot.createdAt,
    });

    return snapshot.id;
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
    );

    if (taken.winner) {
      // Another run got there first, with the same key, so its snapshot is as
      // good as this one.
      run.cachedSnapshots.set(jobPath, taken.winner);

      return taken.winner.snapshotId;
    }

    if (taken.cleared) {
      try {
        return await attempt(`${stepId} (retry)`);
      } catch (error) {
        refusal = error;
      }
    }
  }

  run.warnings.push(
    `not cached: the snapshot of \`${jobPath}\` couldn't be named${refusal ? ` (${errorMessage(refusal)})` : ""}, so later runs build it again`,
  );

  const unnamed = await handle.sandbox.snapshot(`${stepId} (unnamed)`);

  // Today's Cloud rejects snapshot names, so a job's snapshot falls back to an
  // unnamed one that no later run can find. It is deleted when the run ends,
  // like any run-only snapshot. Remove this once every Cloud environment has
  // snapshot names.
  run.createdSnapshots.add(unnamed.id);

  return unnamed.id;
};

/** The code a create gets when another snapshot holds the name. */
const nameTakenCode = "sandbox_snapshot_name_taken";

/**
 * Whether a named snapshot was refused for its name, so taking it without one
 * may work.
 *
 * WORKAROUND (Sandboxes API): Cloud doesn't have snapshot names yet, and
 * refuses a create with a body as a bad request. Delete this once it does.
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
 * Destroy every machine this run created. Tolerates machines that are already
 * gone, because cleanup also runs after failures.
 */
export const destroyRunMachines = async (
  run: CiRunScope,
  attempt = 0,
): Promise<void> => {
  const ids = [...run.sandboxes];

  if (ids.length === 0) {
    return;
  }

  await run.step.run(
    {
      id: `pipeline${scopeSeparator}cleanup${attempt > 0 ? ` (attempt ${attempt})` : ""}`,
      name: "cleanup",
    },
    async () => {
      const destroyed: string[] = [];

      for (const id of ids) {
        try {
          const sandbox = await run.ci.client.sandboxes.get(id);

          if (sandbox) {
            await sandbox.destroy();

            destroyed.push(id);
          }
        } catch (error) {
          // Anything but "not found" fails the step so it retries; ignoring it
          // would leave a billable machine running.
          if (!isSandboxNotFound(error)) {
            throw error;
          }
        }
      }

      return { destroyed };
    },
  );
};

/**
 * Delete the snapshots this run took for `from()`, once the run is over.
 * Cache entries and `keepOnFailure` snapshots aren't in the set, and one the
 * run only restored never was.
 *
 * Best effort, in one step: a snapshot that can't be deleted is logged and
 * left to expire, and never fails the run.
 */
export const deleteRunSnapshots = async (
  run: CiRunScope,
  attempt = 0,
): Promise<void> => {
  const ids = [...run.createdSnapshots];

  if (ids.length === 0) {
    return;
  }

  await run.step.run(
    {
      id: `pipeline${scopeSeparator}cleanup:snapshots${attempt > 0 ? ` (attempt ${attempt})` : ""}`,
      name: "cleanup:snapshots",
    },
    async () => {
      const deleted: string[] = [];
      const failed: string[] = [];

      for (const id of ids) {
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
