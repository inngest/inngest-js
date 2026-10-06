/**
 * A job's machines: creating them lazily, pausing, snapshotting and
 * destroying them.
 *
 * @module
 */

import { CiUsageError } from "../errors.ts";
import type {
  CiJobScope,
  CiRunScope,
  MachineHandle,
} from "../pipeline/scope.ts";
import { defaultCwd, scopeSeparator } from "../pipeline/scope.ts";
import type { MachineConfig } from "../types.ts";
import { boundedName, errorMessage, isSandboxNotFound, slug } from "../util.ts";

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

  run.badSnapshots ??= new Set();

  const startFresh = (note: string) => {
    scope.fromSnapshotId = undefined;
    scope.startNote = note;
    scope.restoreFallback = scope.rebuildParent;

    run.ci.reporter.activity(run, scope.jobPath, note);

    return tools.create(`${stepId}${scopeSeparator}fresh`, {
      name: machineName(run.runId, `${scope.path} fresh`),
      ...machineConfig,
    });
  };

  run.ci.reporter.activity(
    run,
    scope.jobPath,
    scope.startNote ?? "creating machine…",
  );

  const parentId = scope.fromJobIds[0] ?? "the parent";
  const snapshotId = scope.fromSnapshotId;

  let sandbox: Awaited<ReturnType<typeof tools.create>>;

  if (snapshotId && run.badSnapshots.has(snapshotId)) {
    sandbox = await startFresh(`rebuilding ${parentId} · bad snapshot`);
  } else if (snapshotId) {
    try {
      sandbox = await tools.create(stepId, { name, snapshotId });
    } catch (error) {
      if (!isStartFailure(error)) {
        throw error;
      }

      run.badSnapshots.add(snapshotId);

      run.warnings.push(
        `fell back: snapshot of \`${parentId}\` wouldn't start (${errorMessage(error)}), so \`${scope.path}\` re-ran it on its own machine`,
      );

      await invalidateCached(run, snapshotId);

      sandbox = await startFresh(`rebuilding ${parentId} · bad snapshot`);
    }
  } else {
    sandbox = await tools.create(stepId, { name, ...machineConfig });
  }

  run.sandboxes.add(sandbox.id);

  await sandbox.commands.run(`${stepId}${scopeSeparator}setup`, [
    "/bin/sh",
    "-c",
    machineSetupScript,
  ]);

  const handle: MachineHandle = { sandbox, name, id: sandbox.id };

  run.machines.set(scope.path, Promise.resolve(handle));

  return handle;
};

/**
 * Whether a machine failed to start, as opposed to a request that was refused.
 * Only a snapshot restore falls back on it: a plain machine that won't start
 * fails the job with its reason.
 */
const isStartFailure = (error: unknown): boolean => {
  const codes = ["sandbox_start_timed_out", "sandbox_start_failed"];
  const seen = error as
    | { code?: string; cause?: { code?: string } }
    | undefined;

  return (
    codes.includes(seen?.code ?? "") ||
    codes.includes(seen?.cause?.code ?? "") ||
    /did not reach RUNNING/i.test(errorMessage(error))
  );
};

/**
 * Mark the cache entry of a snapshot that wouldn't start, so the next run
 * rebuilds it instead of restoring it again.
 */
const invalidateCached = async (
  run: CiRunScope,
  snapshotId: string,
): Promise<void> => {
  for (const [jobId, entry] of run.cacheEntries) {
    const writeKey = run.cacheWriteKeys?.get(jobId);

    if (entry?.snapshotId !== snapshotId || !writeKey) {
      continue;
    }

    await run.step.run(
      {
        id: `${jobId}${scopeSeparator}cache:invalidate`,
        name: "cache:invalidate",
      },
      async () => {
        await run.ci.cacheStore.set(writeKey, { ...entry, invalid: true });

        return { key: writeKey };
      },
    );
  }
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

    scope.run.ci.reporter.activity(
      scope.run,
      scope.jobPath,
      "pausing machine…",
    );

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

/**
 * Snapshot a job's machine, once per parent per run.
 *
 * Returns `undefined` when the job had no machine, or when snapshots aren't
 * available in this environment, in which case callers fall back to a fresh
 * machine.
 */
export const snapshotJob = (
  run: CiRunScope,
  jobPath: string,
): Promise<string | undefined> => {
  const existing = run.snapshots.get(jobPath);

  if (existing) {
    return existing;
  }

  const created = createSnapshot(run, jobPath);

  run.snapshots.set(jobPath, created);

  return created;
};

const createSnapshot = async (
  run: CiRunScope,
  jobPath: string,
): Promise<string | undefined> => {
  const cached = run.cacheEntries.get(jobPath);

  if (cached?.snapshotId) {
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

  run.ci.reporter.activity(run, jobPath, "snapshotting machine…");

  try {
    // A paused machine has to be running again before it can be snapshotted.
    await handle.sandbox.resume(`${jobPath}${scopeSeparator}resume`);
  } catch {
    // Already running, or resume isn't supported here. The snapshot below
    // decides whether this actually mattered.
  }

  try {
    const snapshot = await handle.sandbox.snapshot(
      `${jobPath}${scopeSeparator}snapshot`,
    );

    return snapshot.id;
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
