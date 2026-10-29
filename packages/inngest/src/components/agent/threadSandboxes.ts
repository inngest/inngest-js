/**
 * @module
 * EXPERIMENTAL: sandboxes that belong to a thread. A thread's sandbox
 * survives across its runs as a snapshot:
 *
 * - the first thing in a run that needs the sandbox restores it from the
 *   thread's newest snapshot, or creates a fresh one when there is none (never
 *   saved, expired, or the name was refused). A run that never touches the
 *   sandbox restores nothing;
 * - when the run ends, a sandbox the run used is snapshotted, then destroyed.
 *   A run that is cancelled or times out cannot do that itself, so the
 *   cleanup defer it registered when the sandbox was created does it by
 *   sandbox ID.
 *
 * A snapshot is named `thread/<agent>/<sandbox>/<hash of the thread key>/<run
 * ID>`: the run that took it is its generation. A run ID cannot collide with
 * another run's. The generations that saved are a sorted index in the
 * thread's KV scope, scored by when the run started, and the newest is the
 * highest score: adding a member is atomic and removes no other, so a cleanup
 * that saves late never moves the newest generation back. A save deletes the
 * generations older than itself by name. Expiry is the platform's.
 *
 * Only files survive, not running processes. A restored sandbox is created
 * from the snapshot alone: the definition's `environment` and `secrets` are
 * not applied to it, because the platform forbids them together with a
 * `snapshotId` (platform ask: accept them, so a restored sandbox gets the
 * current values). Probed against the platform on 2026-10-28 with the
 * client's validation bypassed: `secrets` is rejected ("snapshot launches
 * cannot select secrets"), `environment` is accepted but a command in the
 * sandbox does not see it, and `vcpu` and `memoryMb` are accepted only
 * when they equal the snapshot's own size. What a run wrote to disk, a token for instance, is in every
 * later run's sandbox.
 *
 * Known gaps, by design: a cancelled run's cleanup can still be running when
 * the thread's next run starts, and that run then restores the previous
 * snapshot (the cancelled run's work is saved a moment later, for the run
 * after); an interrupted command can be mid-write in a cancelled run's
 * snapshot.
 */

import hashjs from "hash.js";
import type { DeferHandle } from "../../types.ts";
import { StepError } from "../StepError.ts";
import {
  type SnapshotCacheClient,
  type SnapshotEntry,
  snapshotCache,
} from "../sandbox/snapshotCache.ts";
import type { DurableSandbox, SandboxDuration } from "../sandbox/types.ts";
import { type KvScopeInstance, kvKey } from "./kv.ts";
import {
  generationScore,
  newestSandboxGeneration,
  recordSandboxGeneration,
  runScore,
  sandboxGenerations,
  sandboxReadyKey,
} from "./threadState.ts";

const { sha256 } = hashjs;

/**
 * The scope of every thread snapshot.
 */
export const threadSnapshotScope = "thread";

/**
 * The generation a snapshot is saved as. A run's first snapshot of a sandbox
 * is the run ID. A sandbox recycled mid-run saves again, and each save is a
 * later generation of the same run (`<run ID>.000001`, `.000002`), which sorts after
 * the one before it.
 */
export const sandboxGeneration = (
  /**
   * The run.
   */
  runId: string,

  /**
   * How many times the run has recycled the sandbox before this snapshot.
   */
  epoch = 0,
): string => {
  return epoch > 0 ? `${runId}.${String(epoch).padStart(6, "0")}` : runId;
};

/**
 * What the cleanup defer is told about a sandbox its run created.
 */
export interface ThreadSandboxCleanup {
  /**
   * The name in the agent's `sandboxes`, such as `work`.
   */
  name: string;
  sandboxId: string;

  /**
   * How many times the run had recycled the sandbox when this one was
   * created. Absent: none.
   */
  epoch?: number;
}

/**
 * What an agent's sandboxes ask of their thread.
 */
export interface ThreadSandboxOwner {
  /**
   * The snapshots to create the sandbox `name` from, newest first: the
   * thread's newest generation and the one before it, whichever of them still
   * exist. Empty for a fresh sandbox. The sandbox is created from the first, and
   * from the next when the platform says that one is gone (a save deletes
   * older generations, and snapshots expire). Keeping the extra generation
   * costs a second snapshot per thread and sandbox name against the
   * environment's snapshot limit.
   */
  restore(
    /**
     * The sandbox's name in the agent's `sandboxes`.
     */
    name: string,
  ): Promise<string[]>;

  /**
   * Snapshots a sandbox of this run for the thread's next run. A failed
   * snapshot is a warning on the trace and changes nothing about the run.
   * Returns `false` when nothing was saved, so a caller that is about to
   * destroy the sandbox can keep it instead.
   */
  save(
    /**
     * The sandbox's name in the agent's `sandboxes`.
     */
    name: string,
    /**
     * The sandbox, still running.
     */
    sandbox: DurableSandbox,

    /**
     * The counter of the run's saves and recycles of this sandbox, which names
     * the generation. Default 0.
     */
    epoch?: number,
  ): Promise<boolean | undefined | void>;

  /**
   * Leaves a `keepAlive` sandbox running for the thread's next run instead of
   * saving and destroying it, and returns whether it did. Optional: with no
   * `keep`, or one that returns false, the run saves and destroys the
   * sandbox as usual. Nothing implements it yet, because stopping the sandbox
   * after `idle` needs an idle timeout on the platform's sandbox, which does
   * not exist (platform ask). It will have to stop the sandbox on every
   * terminal state of the thread's run, with no sweeper.
   */
  keep?(
    /**
     * The sandbox's name in the agent's `sandboxes`.
     */
    name: string,

    /**
     * The sandbox, still running.
     */
    sandbox: DurableSandbox,

    /**
     * The binding's `keepAlive`.
     */
    keepAlive: { idle: SandboxDuration },

    /**
     * The cleanup defer of the sandbox. Returning `true` is a promise that the sandbox will be stopped on every way the thread's run can end: the hook registers its own stop defer first, and only then aborts `guard`, because nothing else will stop a sandbox left running. Anything but a `true`, and any throw, makes the run save and destroy as usual.
     */
    guard: DeferHandle,
  ): Promise<boolean> | boolean;

  /**
   * Called when `keep` threw.
   */
  keepFailed?(
    /**
     * The sandbox's name in the agent's `sandboxes`.
     */
    name: string,
    /**
     * What it threw.
     */
    error: unknown,
  ): void;

  /**
   * Called when creating a sandbox from the thread's snapshot failed (for
   * instance the snapshot was deleted meanwhile) and a fresh one is created
   * instead.
   */
  restoreFailed?(
    /**
     * The sandbox's name in the agent's `sandboxes`.
     */
    name: string,
    /**
     * What the create failed with.
     */
    error: unknown,
  ): void;

  /**
   * Registers the defer that saves and destroys the sandbox if the run ends
   * without doing it. Abort the handle once the sandbox is destroyed. It
   * saves only a sandbox the run has marked ready.
   */
  guard(
    /**
     * The sandbox's name in the agent's `sandboxes`.
     */
    name: string,
    /**
     * The sandbox the run just created.
     */
    sandbox: DurableSandbox,

    /**
     * The counter of the run's saves and recycles of this sandbox. Default 0.
     */
    epoch?: number,
  ): DeferHandle;

  /**
   * Forgets the run's ready mark of the sandbox, once the run is done with it.
   */
  release(
    /**
     * The sandbox's name in the agent's `sandboxes`.
     */
    name: string,
  ): Promise<void>;

  /**
   * Marks the sandbox as finished with its skills and setup, so the cleanup
   * may snapshot it: a half set-up sandbox must never become the thread's
   * next one.
   */
  ready(
    /**
     * The sandbox's name in the agent's `sandboxes`.
     */
    name: string,
  ): Promise<void>;
}

export interface ThreadSandboxOptions {
  client: SnapshotCacheClient;

  /**
   * The agent, as `"appId/functionId"`. Part of every snapshot name, so two
   * agents never share one.
   */
  ref: string;

  /**
   * The thread key.
   */
  thread: string;

  /**
   * The run. It is the generation of every snapshot the run takes.
   */
  runId: string;

  /**
   * The thread's KV scope, which holds the generations of each sandbox.
   */
  scope: KvScopeInstance;

  /**
   * Runs a lookup once per run, such as `step.run`.
   */
  run: <T>(id: string, fn: () => Promise<T>) => Promise<T>;

  /**
   * Logs a warning, pino style (`logger.warn(data, message)`).
   */
  warn?: (data: Record<string, unknown>, message: string) => void;

  /**
   * Registers the cleanup defer with a sandbox's details.
   */
  defer: (id: string, sandbox: ThreadSandboxCleanup) => DeferHandle;
}

/**
 * The cache entry of a thread's sandbox at one generation.
 */
export const threadSnapshotEntry = (
  /**
   * The agent, as `"appId/functionId"`.
   */
  ref: string,

  /**
   * The thread key.
   */
  thread: string,

  /**
   * The sandbox's name in the agent's `sandboxes`.
   */
  name: string,

  /**
   * The run that took the snapshot.
   */
  generation: string,
): SnapshotEntry => {
  // A thread key is free text, so the name carries its hash: bounded, made of
  // safe characters, and long enough (128 bits) that two threads never share
  // a snapshot.
  const hash = sha256().update(thread).digest("hex").slice(0, 32);

  return {
    scope: threadSnapshotScope,
    key: `${ref}/${name}/${hash}`,
    generation,
  };
};

/**
 * Deletes the ready key. It is housekeeping: its failure must not fail the run
 * or the cleanup, and it is done only once the snapshot is recorded, so a
 * failed save leaves the cleanup able to save.
 */
const forget = async (
  /**
   * The thread's KV scope.
   */
  scope: KvScopeInstance,
  /**
   * The ready key.
   */
  key: string,
): Promise<void> => {
  try {
    await scope.delete(key);
  } catch (error) {
    if (!(error instanceof StepError)) {
      throw error;
    }
  }
};

/**
 * EXPERIMENTAL: The owner of one run's sandboxes for its thread.
 */
export const threadSandboxOwner = (
  /**
   * The run, its thread and what it uses to remember.
   */
  options: ThreadSandboxOptions,
): ThreadSandboxOwner => {
  const { client, ref, thread, runId, scope } = options;

  return {
    restore: async (name) => {
      // The index range is a KV step, memoized in call order: a replay reads
      // the candidates the first attempt did, even though this run's own saves
      // are in the index by then.
      const newest = await sandboxGenerations(scope, ref, name).range({
        order: "desc",
        limit: 2,
      });
      const cache = snapshotCache(client, { memo: options.run });
      const found: string[] = [];

      for (const { member } of newest) {
        const snapshot = await cache.find(
          threadSnapshotEntry(ref, thread, name, member),
          { stepId: `${name}:thread:restore:${member}` },
        );

        if (snapshot) {
          found.push(snapshot.snapshotId);
        }
      }

      return found;
    },

    save: async (name, sandbox, epoch = 0) => {
      const generation = sandboxGeneration(runId, epoch);
      const suffix = epoch > 0 ? `:g${epoch}` : "";

      try {
        // The older generations are deleted by name below, not by listing
        // every snapshot of the environment.
        const taken = await snapshotCache(client, { memo: options.run }).take(
          threadSnapshotEntry(ref, thread, name, generation),
          (snapshotName, n) => {
            return sandbox.snapshot(
              `${name}:thread:save${suffix}:${n}`,
              snapshotName ? { name: snapshotName } : {},
            );
          },
          { stepId: `${name}:thread:save${suffix}`, replace: false },
        );

        // A snapshot without its name can't be found again.
        if (!taken.named) {
          return false;
        }

        await recordSandboxGeneration(scope, ref, name, generation);
      } catch (error) {
        if (!(error instanceof StepError)) {
          throw error;
        }

        return false;
      }

      // The snapshot is taken and recorded; pruning the older ones is
      // housekeeping, and its failure does not make the save one.
      try {
        const generations = sandboxGenerations(scope, ref, name);
        // Generations of earlier runs, and earlier generations of this run.
        const previous = (
          await generations.range({ max: generationScore(generation) })
        ).filter((entry) => {
          return entry.member < generation;
        });

        // The newest of the older generations stays as a spare: a run that
        // restored it a moment ago may still be creating from it.
        const older = previous.slice(0, -1);

        if (older.length === 0) {
          return true;
        }

        await options.run(`${name}:thread:replace${suffix}`, async () => {
          const cache = snapshotCache(client);

          for (const { member } of older) {
            const found = await cache.find(
              threadSnapshotEntry(ref, thread, name, member),
            );

            if (found) {
              await cache.remove(found.snapshotId);
            }
          }

          return null;
        });

        for (const { member } of older) {
          await generations.remove(member);
        }

        return true;
      } catch (error) {
        if (!(error instanceof StepError)) {
          throw error;
        }

        return true;
      }
    },

    restoreFailed: (name, error) => {
      options.warn?.(
        { ref, thread, sandbox: name, error: String(error) },
        "Restoring the thread's sandbox from its snapshot failed; starting a fresh one",
      );
    },

    guard: (name, sandbox, epoch = 0) => {
      // A defer ID may be used once per run, so a recycled sandbox's cleanup
      // has an ID of its own.
      return options.defer(
        epoch > 0
          ? `${name}:thread:cleanup:g${epoch}`
          : `${name}:thread:cleanup`,
        {
          name,
          sandboxId: sandbox.id,
          ...(epoch > 0 && { epoch }),
        },
      );
    },

    release: async (name) => {
      await forget(scope, sandboxReadyKey(ref, name, runId));
    },

    keepFailed: (name, error) => {
      options.warn?.(
        { ref, thread, sandbox: name, error: String(error) },
        "keepAlive failed; the sandbox is saved and destroyed instead",
      );
    },

    ready: async (name) => {
      await scope.set(sandboxReadyKey(ref, name, runId), true);
    },
  };
};

export interface CleanupThreadSandboxOptions {
  client: SnapshotCacheClient & {
    sandboxes: {
      get(sandboxId: string): Promise<{
        snapshot(options: { name?: string }): Promise<{
          id: string;
          createdAt: string;
        }>;
        destroy(): Promise<unknown>;
      } | null>;
    };
  };
  ref: string;
  thread: string;

  /**
   * The run that ended.
   */
  runId: string;
  scope: KvScopeInstance;
  sandbox: ThreadSandboxCleanup;

  /**
   * Runs `fn` as a step of the cleanup function.
   */
  run: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
}

/**
 * Saves and destroys a sandbox whose run ended without doing it (cancelled,
 * timed out, or a destroy that failed). It saves nothing when the sandbox was
 * not marked ready, or when the thread already has a snapshot from this run or
 * a newer one, and destroys the sandbox in every case.
 */
export const cleanupThreadSandbox = async (
  /**
   * The ended run, its thread and the sandbox.
   */
  options: CleanupThreadSandboxOptions,
): Promise<void> => {
  const { client, ref, thread, runId, scope, sandbox } = options;
  const readyKey = sandboxReadyKey(ref, sandbox.name, runId);
  const generation = sandboxGeneration(runId, sandbox.epoch);
  const ready = (await scope.get(kvKey<boolean>(readyKey))) === true;
  const newest = ready
    ? await newestSandboxGeneration(scope, ref, sandbox.name)
    : undefined;

  if (ready && (!newest || newest < generation)) {
    try {
      const named = await options.run(
        `${sandbox.name}:thread:snapshot`,
        async () => {
          const found = await client.sandboxes.get(sandbox.sandboxId);

          if (!found) {
            return false;
          }

          const taken = await snapshotCache(client).take(
            threadSnapshotEntry(ref, thread, sandbox.name, generation),
            (snapshotName) => {
              return found.snapshot(snapshotName ? { name: snapshotName } : {});
            },
            { replace: false },
          );

          return taken.named;
        },
      );

      if (named) {
        await recordSandboxGeneration(scope, ref, sandbox.name, generation);
      }
    } catch (error) {
      if (!(error instanceof StepError)) {
        throw error;
      }
    }
  }

  await options.run(`${sandbox.name}:thread:destroy`, async () => {
    await (await client.sandboxes.get(sandbox.sandboxId))?.destroy();
  });

  // The sandbox is gone, so nothing will read the ready key again.
  await forget(scope, readyKey);
};
