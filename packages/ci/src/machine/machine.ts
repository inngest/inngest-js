/**
 * A job's machines: creating them lazily, snapshotting them and destroying
 * them.
 *
 * @module
 */

import type { Inngest } from "inngest";
import { NonRetriableError } from "inngest";
import type { CachedSnapshot, CacheTarget } from "../cache/cache.ts";
import { resolveTakenName, snapshotState } from "../cache/cache.ts";
import { CiUsageError } from "../errors.ts";
import { ciRun } from "../pipeline/metadata.ts";
import { ciSpan, ciStep, traceName } from "../pipeline/names.ts";
import type {
  CiJobScope,
  CiRunScope,
  MachineHandle,
} from "../pipeline/scope.ts";
import {
  defaultCwd,
  inJobSpan,
  isRestoring,
  runInScope,
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

  const span = {
    id: scope.path,
    name: traceName.extraMachine(scope.path, scope.jobPath),
  };

  return inSpan(span, fn);
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
    options: {
      name: string;
      snapshotId?: string;
    },
  ): Promise<Started> => {
    const sandbox = options.snapshotId
      ? await tools.create(createStep, {
          name: options.name,
          snapshotId: options.snapshotId,
        })
      : await tools.create(createStep, {
          name: options.name,
          ...machineConfig,
        });

    await sandbox.commands.run(
      {
        id: `${createStep.id}${scopeSeparator}setup`,
        name: traceName.prepareWorkspace,
      },
      ["/bin/sh", "-c", machineSetupScript],
    );

    return { sandbox };
  };

  const startFresh = (note: string) => {
    scope.fromSnapshotId = undefined;
    scope.startNote = note;
    scope.restoreFallback = scope.rebuildParent;

    run.ci.hooks.activity(run, scope.jobPath, note);

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
    run.ci.hooks.activity(
      run,
      scope.jobPath,
      scope.startNote ?? "creating machine…",
    );

    let probed: Started | undefined;

    /** Why the snapshot can't be used, if it can't. */
    let bad: string | undefined;

    /** How to replace it, when it can't be used. */
    let rebuild = { broken: false, unnamed: false };

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

      // WORKAROUND (Sandboxes API): a snapshot can't be told to be broken, so
      // it is retried before it is deleted. Delete this once snapshots or
      // images report their own health. Today a snapshot has only the
      // statuses `CREATING`, `READY`, `DELETING` and `DELETED`, and a broken
      // one still says `READY`. A start that times out says no more: the
      // machine may have been stuck, or the node busy, as easily as the
      // snapshot bad. Deleting on the first one would let a single blip
      // destroy a cache that is shared, since a pull request restores its
      // base branch's snapshots, and every run after it would build again. So
      // only a snapshot that fails to start a second time is broken enough to
      // delete. Capacity errors (`compute_unavailable`, 429 and 503) are not
      // start failures at all, and fail the job as any other would.
      const state = await snapshotState(
        run,
        `${stepId}${scopeSeparator}snapshot-state`,
        snapshotId,
      );

      if (state === "creating") {
        // Another build is still taking it and may yet finish, so this
        // run rebuilds without contending for its name.
        rebuild = { broken: false, unnamed: true };
      } else if (state === "ready") {
        const restartStepId = `${stepId}${scopeSeparator}restart`;
        const restartName = machineName(run.runId, `${scope.path} restart`);

        try {
          // With the default wait, the same as the first try's: a shorter one
          // would make a slow node more likely to fail the retry, and a second
          // failure deletes the snapshot.
          probed = await start(
            { id: restartStepId, name: traceName.restartMachine },
            {
              name: restartName,
              snapshotId,
            },
          );

          bad = undefined;

          run.warnings.push(
            `retried: snapshot of \`${parentId}\` needed a retry to start (${errorMessage(error)}), so \`${scope.path}\` started it on the second try`,
          );
        } catch (second) {
          if (!isStartFailure(second)) {
            throw second;
          }

          await discardFailedStart(run, restartStepId, restartName, second);

          bad = `wouldn't start twice (${errorMessage(second)})`;

          rebuild = { broken: true, unnamed: false };
        }
      }
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

      // Shared: jobs that had the same trouble wait for one rebuild, which
      // also deletes a broken snapshot once.
      const replacement = await scope.rebuildSnapshot?.(rebuild);

      if (replacement) {
        scope.startNote = `starting ${parentId}`;

        run.ci.hooks.activity(run, scope.jobPath, scope.startNote);

        const retryStepId = `${stepId}${scopeSeparator}retry`;
        const retryName = machineName(run.runId, `${scope.path} retry`);

        try {
          started = await start(
            { id: retryStepId, name: traceName.retryCreate },
            {
              name: retryName,
              snapshotId: replacement,
            },
          );
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

    started = await start(create, { name });
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
    await ciRun(
      run,
      {
        step: {
          id: `${stepId}${scopeSeparator}discard`,
          name: traceName.discardMachine,
        },
        intent: `Discard the sandbox \`${name}\` that failed to start`,
      },
      async (note): Promise<{ id?: string }> => {
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

        note.outcome({
          discarded: Boolean(id),
          ...(id ? { sandboxId: id } : {}),
        });

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

  // No capacity, or too many requests, says nothing about the snapshot.
  if (isRetryable(error)) {
    return false;
  }

  return (
    codes.some((code) => {
      return hasCode(error, code);
    }) || /did not reach RUNNING/i.test(errorMessage(error))
  );
};

/**
 * Whether the platform says to try again, as it does for no capacity
 * (`compute_unavailable`) and rate limits (429 and 503).
 */
const isRetryable = (error: unknown): boolean => {
  const seen = error as
    | { retryable?: boolean; cause?: { retryable?: boolean } }
    | undefined;
  const status = errorStatus(error);

  return (
    seen?.retryable === true ||
    seen?.cause?.retryable === true ||
    hasCode(error, "compute_unavailable") ||
    hasCode(error, "rate_limited") ||
    status === 429 ||
    status === 503
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
  run.ci.hooks.activity(run, jobPath, "snapshotting machine…");

  const stepId = `${jobPath}${scopeSeparator}snapshot`;

  try {
    return cache && !cache.unnamed
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
  { target, exclude, broken }: SnapshotCache,
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
    broken,
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
  const snapshot = await handle.sandbox.snapshot(snapshotStep(stepId));

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
  await ciRun(
    run,
    {
      step: ciStep(
        `pipeline${scopeSeparator}cleanup${attempt > 0 ? ` (attempt ${attempt})` : ""}`,
        traceName.cleanUpMachines,
      ),
      intent: "Destroy this run's sandboxes",
    },
    async (note) => {
      const result = await destroyOrphans(run.ci.client, run.runId);

      note.outcome(result);

      return result;
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
  await ciRun(
    run,
    {
      step: ciStep(
        `pipeline${scopeSeparator}cleanup:snapshots${attempt > 0 ? ` (attempt ${attempt})` : ""}`,
        traceName.cleanUpSnapshots,
      ),
      intent: "Delete the snapshots this run took",
    },
    async (note) => {
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

      note.outcome({ deleted: deleted.length, failed: failed.length });

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
