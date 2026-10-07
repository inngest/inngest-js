/**
 * A job's machines: creating them lazily, snapshotting them and destroying
 * them.
 *
 * @module
 */

import type { Inngest } from "inngest";
import type { CachedSnapshot, CacheTarget } from "../cache/cache.ts";
import {
  deleteSnapshot,
  resolveTakenName,
  staleParentOf,
} from "../cache/cache.ts";
import { CiUsageError } from "../errors.ts";
import { ciSpan, ciStep, traceName } from "../pipeline/names.ts";
import type {
  CiJobScope,
  CiRunScope,
  MachineHandle,
} from "../pipeline/scope.ts";
import {
  defaultCwd,
  inJobSpan,
  recordTiming,
  scopeSeparator,
} from "../pipeline/scope.ts";
import { inSpan } from "../pipeline/spans.ts";
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
 * concurrent first commands share a single creation promise. Its steps are in
 * a span of its own, in its job's span rather than the first command's.
 */
export const ensureMachine = async (
  scope: CiJobScope,
): Promise<MachineHandle> => {
  scope.machine ??= inJobSpan(scope.run, scope.jobPath, () => {
    return inMachineSpan(scope, () => {
      const stepId = `${scope.path}${scopeSeparator}machine`;

      // Everything in it is CI's work, including falling back from a
      // snapshot that won't start.
      const span = ciSpan(stepId, traceName.startMachine(scope.fromJobIds[0]));

      return inSpan(span, () => {
        return createMachine(scope, stepId);
      });
    });
  });

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
 * Run `fn` in an extra machine's span, so its commands sit apart from the
 * job's own. A job's own machine has none: the job's span is its span.
 */
export const inMachineSpan = <R>(scope: CiJobScope, fn: () => R): R => {
  if (scope.path === scope.jobPath) {
    return fn();
  }

  const span = {
    id: scope.path,
    name: traceName.extraMachine(scope.path, scope.jobPath),
  };

  return inSpan(span, fn);
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

const createMachine = async (
  scope: CiJobScope,
  /** The create step's ID, which other steps for the machine build on. */
  stepId: string,
): Promise<MachineHandle> => {
  const { run } = scope;
  const tools = run.sandboxTools;

  if (!tools) {
    throw new CiUsageError(
      "This pipeline has no `step.sandbox` tools. `createCi` adds `sandboxMiddleware()` to the functions it creates, so this usually means the function was created another way.",
    );
  }

  const name = machineName(run.runId, scope.path);
  const create = { id: stepId, name: traceName.createMachine };

  const machineConfig = resolveMachineConfig(
    scope.config.machine ?? run.machine ?? run.ci.defaultMachine,
  );

  /** Create a machine, from a snapshot if one is given, and set it up. */
  const start = async (
    createStep: { id: string; name: string },
    options: { name: string; snapshotId?: string },
  ): Promise<Started> => {
    const began = Date.now();

    const sandbox = options.snapshotId
      ? await tools.create(createStep, {
          name: options.name,
          snapshotId: options.snapshotId,
        })
      : await tools.create(createStep, {
          name: options.name,
          ...machineConfig,
        });

    if (options.snapshotId) {
      recordTiming(run, {
        kind: "start",
        path: scope.path,
        durationMs: Date.now() - began,
      });
    }

    const setup = await sandbox.commands.run(
      {
        id: `${createStep.id}${scopeSeparator}setup`,
        name: traceName.prepareWorkspace,
      },
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

    run.ci.reporter.activity(run, scope.jobPath, note);

    return start(
      {
        id: `${stepId}${scopeSeparator}fresh`,
        name: traceName.createFreshMachine,
      },
      { name: machineName(run.runId, `${scope.path} fresh`) },
    );
  };

  const parentId = scope.fromJobIds[0] ?? "the parent";
  const snapshotId = scope.fromSnapshotId;

  let started: Started;

  if (snapshotId) {
    // Every job starting from a snapshot checks it for itself, so what a job
    // does never depends on whether a sibling got there first. Only the
    // rebuild of the parent, which each of them awaits, is shared.
    run.ci.reporter.activity(
      run,
      scope.jobPath,
      scope.startNote ?? "creating machine…",
    );

    let probed: Started | undefined;

    /** Why the snapshot can't be used, if it can't. */
    let bad: string | undefined;

    try {
      probed = await start(create, { name, snapshotId });
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
    const cachedParent =
      scope.fromBuilt[parentId]?.cached?.snapshotId === snapshotId;

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

      scope.startNote = note;

      run.ci.reporter.activity(run, scope.jobPath, note);

      await deleteSnapshot(
        run,
        `${scope.path}${scopeSeparator}cache:delete`,
        snapshotId,
      );

      // Shared: jobs that found the same bad snapshot wait for one rebuild.
      const replacement = await scope.rebuildSnapshot?.();

      if (replacement) {
        scope.startNote = `starting ${parentId}`;

        run.ci.reporter.activity(run, scope.jobPath, scope.startNote);

        started = await start(
          {
            id: `${stepId}${scopeSeparator}retry`,
            name: traceName.retryCreate,
          },
          {
            name: machineName(run.runId, `${scope.path} retry`),
            snapshotId: replacement,
          },
        );
      } else {
        started = await startFresh(note);
      }
    }
  } else {
    run.ci.reporter.activity(
      run,
      scope.jobPath,
      scope.startNote ?? "creating machine…",
    );

    started = await start(create, { name });
  }

  const handle: MachineHandle = {
    sandbox: started.sandbox,
    name,
    id: started.sandbox.id,
    parents: parentsOf(scope, started),
  };

  // A machine from a snapshot has the working tree that snapshot was taken
  // with, which is what lets `checkout()` upload only what changed since.
  if (started.meta?.treeId) {
    handle.treeId = started.meta.treeId;
  }

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
    const cached = scope.fromBuilt[jobId]?.cached;

    if (!cached) {
      continue;
    }

    const input = scope.parentInputs[jobId];

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
    await started.sandbox.destroy({
      id: `${stepId}${scopeSeparator}stale`,
      name: traceName.discardStaleMachine,
    });
  } catch {
    // Best effort only.
  }
};

/**
 * Best-effort cleanup of a machine that failed to start. The platform keeps
 * such a machine (stuck in STARTING) and its name, so it is destroyed here, and
 * the end of the run finds it by its name if this couldn't.
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
        name: traceName.discardMachine,
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
          // The run's cleanup finds it again by its name.
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

/** Run `fn` in a job's "Save sandbox" span, which holds snapshotting it. */
const inSaveSpan = <R>(jobPath: string, fn: () => R): R => {
  return inSpan(
    ciSpan(`${jobPath}${scopeSeparator}save`, traceName.saveMachine),
    fn,
  );
};

/** How a job's snapshot is named. */
export interface SnapshotCache {
  target: CacheTarget;
  /** A bad snapshot that may still hold the name, which must not be used. */
  exclude?: string;
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

/** A snapshot step: its ID is the step's, its name reads as an action. */
const snapshotStep = (id: string) => {
  return { id, name: traceName.snapshotMachine };
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

  return inSaveSpan(scope.path, () => {
    return takeSnapshot(run, scope.path, handle, cache);
  });
};

const takeSnapshot = async (
  run: CiRunScope,
  jobPath: string,
  handle: MachineHandle,
  cache: SnapshotCache | undefined,
): Promise<TakenSnapshot | undefined> => {
  run.ci.reporter.activity(run, jobPath, "snapshotting machine…");

  const meta: SnapshotMeta = {
    ...(handle.treeId ? { treeId: handle.treeId } : {}),
    parents: handle.parents,
  };

  await handle.sandbox.commands.run(
    ciStep(
      `${jobPath}${scopeSeparator}snapshot:meta`,
      traceName.recordSnapshotContents,
    ),
    writeSnapshotMetaCommand(meta),
  );

  const stepId = `${jobPath}${scopeSeparator}snapshot`;

  try {
    const began = Date.now();

    const taken = cache
      ? await createNamedSnapshot(run, handle, jobPath, stepId, cache)
      : await createRunSnapshot(handle, stepId);

    recordTiming(run, {
      kind: "snapshot",
      path: jobPath,
      durationMs: Date.now() - began,
    });

    return taken;
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
  { target, exclude, ephemeral }: SnapshotCache,
): Promise<TakenSnapshot> => {
  const name = target.name;

  const attempt = async (id: string): Promise<TakenSnapshot> => {
    const snapshot = await handle.sandbox.snapshot(snapshotStep(id), { name });

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
    snapshotStep(`${stepId} (unnamed)`),
  );

  // Today's Cloud rejects snapshot names, so a job's snapshot falls back to an
  // unnamed one that no later run can find. The run that invoked the build
  // deletes it at its own end, like any run-only snapshot: the build's own
  // cleanup would delete it while that run still starts jobs from it. Remove
  // this once every Cloud environment has snapshot names
  // (inngest/inngest jack/snapshot-names, monorepo jack/snapshot-names).
  return { snapshotId: unnamed.id, reused: false };
};

/**
 * Snapshot a machine that is kept for a person to look at, so no run's
 * cleanup deletes it.
 */
const createRunSnapshot = async (
  handle: MachineHandle,
  stepId: string,
): Promise<TakenSnapshot> => {
  const snapshot = await handle.sandbox.snapshot(snapshotStep(stepId));

  return { snapshotId: snapshot.id, reused: false };
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
 * over: those of `from()` parents without a cache, and unnamed fallbacks.
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
