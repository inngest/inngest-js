/**
 * Layer snapshots: a parent snapshot plus a large uploaded change, taken once
 * so the jobs that would each have uploaded that change start from it instead.
 *
 * A layer lives for one run. The tree changes with every edit, so it's never
 * cached, and it's deleted when the run ends.
 *
 * @module
 */

import type {
  CiJobScope,
  CiRunScope,
  MachineHandle,
} from "../pipeline/scope.ts";
import { recordTiming, scopeSeparator } from "../pipeline/scope.ts";
import { errorMessage } from "../util.ts";
import { isSnapshotUnavailable, resolveMachineConfig } from "./machine.ts";

/**
 * The upload size from which a layer pays for itself. Internal, not an option.
 *
 * Measured against the Dev Server: a snapshot takes about 16s whatever its
 * size, a machine starts from one in about 1.5s, and an upload costs about
 * 0.6s per MB, up to twice that with four at once. A layer costs the leader
 * one upload plus the snapshot, so the first wave of jobs only breaks even at
 * around 30 MB, and later jobs gain what they'd have uploaded. Under this
 * size, each job uploading its own delta is as fast or faster.
 */
export const layerThresholdBytes = 32 * 1024 * 1024;

/** The key of a layer: parent snapshot, tree ID and machine size. */
export const layerKey = (
  scope: CiJobScope,
  parentSnapshotId: string,
  treeId: string,
): string => {
  const { vcpu } = resolveMachineConfig(
    scope.config.machine ?? scope.run.machine ?? scope.run.ci.defaultMachine,
  );

  return [parentSnapshotId, treeId, vcpu].join("|");
};

/** The role a job takes in making a layer. */
export type LayerRole =
  | { kind: "leader"; finish: (snapshotId: string | undefined) => void }
  | { kind: "peer"; snapshot: Promise<string | undefined>; leader: string };

/**
 * Take part in the layer for this key. The first job to ask is the leader:
 * it uploads the change, snapshots its machine and settles the layer. Every
 * later one is a peer and waits for that.
 */
export const joinLayer = (scope: CiJobScope, key: string): LayerRole => {
  const { run } = scope;
  const existing = run.layers.get(key);

  if (existing) {
    return {
      kind: "peer",
      snapshot: existing.snapshot,
      leader: existing.leader,
    };
  }

  let finish!: (snapshotId: string | undefined) => void;

  const snapshot = new Promise<string | undefined>((resolve) => {
    finish = resolve;
  });

  run.layers.set(key, { leader: scope.path, snapshot });

  return { kind: "leader", finish };
};

/**
 * Snapshot the leader's machine, right after it took the change. Never
 * throws: a layer is an optimisation, and without one every job uploads the
 * change itself.
 */
export const snapshotLayer = async (
  scope: CiJobScope,
  machine: MachineHandle,
  treeId: string,
): Promise<string | undefined> => {
  const { run } = scope;
  const began = Date.now();

  run.ci.reporter.activity(run, scope.jobPath, "snapshotting changes…");

  try {
    const snapshot = await machine.sandbox.snapshot(
      `${scope.path}${scopeSeparator}layer`,
    );

    run.layerSnapshots.add(snapshot.id);
    run.snapshotTrees.set(snapshot.id, treeId);

    recordTiming(run, {
      kind: "layer",
      path: scope.path,
      durationMs: Date.now() - began,
    });

    return snapshot.id;
  } catch (error) {
    if (isSnapshotUnavailable(error)) {
      run.snapshotsUnavailable = true;
    }

    run.warnings.push(
      `fell back: couldn't snapshot the changes of \`${scope.path}\` (${errorMessage(error)}), so jobs uploaded them themselves`,
    );

    return undefined;
  }
};

/**
 * Delete the layers this run made. Tolerates ones that are already gone,
 * because cleanup also runs after failures.
 */
export const deleteRunLayers = async (
  run: CiRunScope,
  attempt = 0,
): Promise<void> => {
  const ids = [...run.layerSnapshots];

  if (ids.length === 0) {
    return;
  }

  await run.step.run(
    {
      id: `pipeline${scopeSeparator}cleanup layers${attempt > 0 ? ` (attempt ${attempt})` : ""}`,
      name: "cleanup layers",
    },
    async () => {
      const deleted: string[] = [];

      for (const id of ids) {
        try {
          const snapshot = await run.ci.client.sandboxes.snapshots.get(id);

          if (snapshot) {
            await snapshot.delete();

            deleted.push(id);
          }
        } catch (error) {
          // Anything but "not found" fails the step so it retries; ignoring
          // it would leave a snapshot counting against the account's quota.
          const code = (error as { code?: string; cause?: { code?: string } })
            ?.code;

          const causeCode = (error as { cause?: { code?: string } })?.cause
            ?.code;

          if (
            code !== "sandbox_snapshot_not_found" &&
            causeCode !== "sandbox_snapshot_not_found"
          ) {
            throw error;
          }
        }
      }

      return { deleted };
    },
  );
};
