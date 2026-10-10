/**
 * Starting a job's machine: creating it, setting it up, and falling back when
 * the snapshot it restores won't start.
 *
 * @module
 */

import { snapshotState } from "../cache/cache.ts";
import { CiUsageError } from "../errors.ts";
import { traceName } from "../pipeline/names.ts";
import type {
  CiJobScope,
  CiRunScope,
  MachineHandle,
} from "../pipeline/scope.ts";
import { defaultCwd, joinId } from "../pipeline/scope.ts";
import type { MachineConfig } from "../types.ts";
import { boundedName, errorMessage, slug } from "../util.ts";
import { isStartFailure } from "./sandboxErrors.ts";

/**
 * Memory is paired with vCPU count, so a job only picks one number.
 */
const memoryForVcpu = { 1: 1024, 2: 2048, 4: 4096 } as const;

const resolveMachineConfig = (
  config: MachineConfig | undefined,
): { vcpu: 1 | 2 | 4; memoryMb: number } => {
  const vcpu = config?.vcpu ?? 2;

  return { vcpu, memoryMb: memoryForVcpu[vcpu] };
};

/**
 * The name a machine is created with. It carries the run ID so orphaned
 * machines can be found and destroyed by the cleanup function.
 */
const machineName = (runId: string, path: string): string => {
  return boundedName(`ci-${runId}-${slug(path)}`);
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

/**
 * The stages a machine is started in. Only the first is tried every time:
 * the rest follow a snapshot that won't start. Each has its own step ID,
 * machine name and trace name, all derived from the key.
 */
const stages = {
  first: traceName.createMachine,
  restart: traceName.restartMachine,
  retry: traceName.retryCreate,
  fresh: traceName.createFreshMachine,
};

type Stage = keyof typeof stages;

type Sandbox = MachineHandle["sandbox"];

/**
 * Create this scope's machine, from the snapshot it starts from if it has one.
 *
 * A snapshot that won't start is retried once, and a second failure makes it
 * broken. Either way the job doesn't fail: the parent is rebuilt for it to
 * start from, and a fresh machine is the last resort.
 */
export const startMachine = async (
  scope: CiJobScope,
  /** The first stage's step ID, which the other stages build on. */
  stepId: string,
): Promise<MachineHandle> => {
  const sandbox = await startSandbox(scope, stepId);

  return {
    sandbox,
    name: machineName(scope.run.runId, scope.path),
    id: sandbox.id,
  };
};

const startSandbox = async (
  scope: CiJobScope,
  stepId: string,
): Promise<Sandbox> => {
  const { run } = scope;
  const tools = run.sandboxTools;

  if (!tools) {
    throw new CiUsageError(
      "This pipeline has no `step.sandbox` tools. `createCi` adds `sandboxMiddleware()` to the functions it creates, so this usually means the function was created another way.",
    );
  }

  const machineConfig = resolveMachineConfig(
    scope.config.machine ?? run.machine ?? run.ci.defaultMachine,
  );

  const idOf = (stage: Stage): string => {
    return stage === "first" ? stepId : joinId(stepId, stage);
  };

  const nameOf = (stage: Stage): string => {
    return machineName(
      run.runId,
      stage === "first" ? scope.path : `${scope.path} ${stage}`,
    );
  };

  /** Create a machine at a stage, from a snapshot if one is given, and set it up. */
  const start = async (stage: Stage, snapshotId?: string): Promise<Sandbox> => {
    const step = { id: idOf(stage), name: stages[stage] };
    const name = nameOf(stage);

    const sandbox = await tools.create(
      step,
      snapshotId ? { name, snapshotId } : { name, ...machineConfig },
    );

    await sandbox.commands.run(
      { id: joinId(step.id, "setup"), name: traceName.prepareWorkspace },
      ["/bin/sh", "-c", machineSetupScript],
    );

    return sandbox;
  };

  /**
   * Start from a snapshot, or the start failure that says it won't. The failed
   * start still holds its name, so what follows gets another, and the stuck
   * machine is cleared away meanwhile.
   */
  const restore = async (
    stage: Stage,
    snapshotId: string,
  ): Promise<{ started: Sandbox } | { failure: unknown }> => {
    try {
      return { started: await start(stage, snapshotId) };
    } catch (failure) {
      if (!isStartFailure(failure)) {
        throw failure;
      }

      await discardFailedStart(run, idOf(stage), nameOf(stage), failure);

      return { failure };
    }
  };

  const startFresh = (note: string): Promise<Sandbox> => {
    scope.fromSnapshotId = undefined;
    scope.startNote = note;
    scope.restoreFallback = scope.rebuildParent;

    run.ci.hooks.activity(run, scope.jobPath, note);

    return start("fresh");
  };

  run.ci.hooks.activity(
    run,
    scope.jobPath,
    scope.startNote ?? "creating machine…",
  );

  const snapshotId = scope.fromSnapshotId;

  if (!snapshotId) {
    return start("first");
  }

  const parentId = scope.fromJobIds[0] ?? "the parent";

  // Every job starting from a snapshot checks it for itself, so what a job
  // does never depends on whether a sibling got there first. Only the
  // rebuild of the parent, which each of them awaits, is shared.
  const first = await restore("first", snapshotId);

  if ("started" in first) {
    return first.started;
  }

  /** Why the snapshot can't be used. */
  let bad = `wouldn't start (${errorMessage(first.failure)})`;

  /** How to replace it. */
  let rebuild = { broken: false, unnamed: false };

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
    joinId(stepId, "snapshot-state"),
    snapshotId,
  );

  if (state === "creating") {
    // Another build is still taking it and may yet finish, so this
    // run rebuilds without contending for its name.
    rebuild = { broken: false, unnamed: true };
  } else if (state === "ready") {
    // With the default wait, the same as the first try's: a shorter one
    // would make a slow node more likely to fail the retry, and a second
    // failure deletes the snapshot.
    const second = await restore("restart", snapshotId);

    if ("started" in second) {
      run.warnings.push(
        `retried: snapshot of \`${parentId}\` needed a retry to start (${errorMessage(first.failure)}), so \`${scope.path}\` started it on the second try`,
      );

      return second.started;
    }

    bad = `wouldn't start twice (${errorMessage(second.failure)})`;

    rebuild = { broken: true, unnamed: false };
  }

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

    // Restores may still be broken while fresh machines work, which is where
    // this job went before there was a replacement to try.
    const retried = await restore("retry", replacement);

    if ("started" in retried) {
      return retried.started;
    }
  }

  return startFresh(note);
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
        id: joinId(stepId, "discard"),
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
