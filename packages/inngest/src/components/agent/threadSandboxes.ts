/**
 * @module
 * EXPERIMENTAL: sandboxes that belong to a thread. A thread's sandbox
 * survives across its runs as a snapshot:
 *
 * - the first thing in a run that needs the sandbox restores it from the
 *   thread's newest snapshot, or creates a fresh one when there is none (never
 *   saved, expired, or the name was refused). A run that never touches the
 *   sandbox restores nothing;
 * - when the run ends, a sandbox the run started is snapshotted, then
 *   destroyed. A run that is cancelled or times out cannot do that itself, so
 *   the cleanup defer it registered when the sandbox was created does it by
 *   sandbox ID.
 *
 * A snapshot is named `thread/<agent>/<sandbox>/<hash of the thread key>/<run
 * ID>`: the run that took it is its generation. A run ID cannot collide with
 * another run's, and it sorts by time, so the pointer to the newest snapshot
 * (a thread KV key, see `recordSandboxGeneration()`) never moves back. Older
 * generations are replaced when a new one is saved; expiry is the platform's.
 * Only files survive, not running processes.
 */

import type { DeferHandle } from "../../types.ts";
import { StepError } from "../StepError.ts";
import {
  type SnapshotCacheClient,
  type SnapshotEntry,
  snapshotCache,
  snapshotKey,
} from "../sandbox/snapshotCache.ts";
import type { DurableSandbox } from "../sandbox/types.ts";
import type { KvScopeInstance } from "./kv.ts";
import {
  recordSandboxGeneration,
  sandboxGenerationKey,
} from "./threadState.ts";

/**
 * The scope of every thread snapshot.
 */
export const threadSnapshotScope = "thread";

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
   * Whether the sandbox may be snapshotted: false until its setup has
   * finished, because a half set-up sandbox must never become the thread's
   * next one.
   */
  save: boolean;
}

/**
 * What an agent's sandboxes ask of their thread.
 */
export interface ThreadSandboxOwner {
  /**
   * The snapshot to create the sandbox `name` from: the thread's newest, or
   * `undefined` for a fresh sandbox.
   * @param name The sandbox's name in the agent's `sandboxes`.
   */
  restore(name: string): Promise<string | undefined>;

  /**
   * Snapshots a sandbox of this run for the thread's next run. A failed
   * snapshot is a warning on the trace and changes nothing about the run.
   * @param name The sandbox's name in the agent's `sandboxes`.
   * @param sandbox The sandbox, still running.
   */
  save(name: string, sandbox: DurableSandbox): Promise<void>;

  /**
   * Registers the defer that saves and destroys the sandbox if the run ends
   * without doing it. Abort the handle once the sandbox is destroyed.
   * @param name The sandbox's name in the agent's `sandboxes`.
   * @param sandbox The sandbox the run just created.
   * @param save Whether the cleanup may snapshot it. Register with `false`
   * while setup runs, then replace the guard with a `true` one.
   */
  guard(name: string, sandbox: DurableSandbox, save: boolean): DeferHandle;
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
   * The thread's KV scope, which holds the pointer to the newest snapshot of
   * each sandbox.
   */
  scope: KvScopeInstance;

  /**
   * Runs a lookup once per run, such as `step.run`.
   */
  run: <T>(id: string, fn: () => Promise<T>) => Promise<T>;

  /**
   * Registers the cleanup defer with a sandbox's details.
   */
  defer: (id: string, sandbox: ThreadSandboxCleanup) => DeferHandle;
}

/**
 * The cache entry of a thread's sandbox at one generation.
 * @param ref The agent, as `"appId/functionId"`.
 * @param thread The thread key.
 * @param name The sandbox's name in the agent's `sandboxes`.
 * @param generation The run that took the snapshot.
 */
export const threadSnapshotEntry = async (
  ref: string,
  thread: string,
  name: string,
  generation: string,
): Promise<SnapshotEntry> => {
  // A thread key is free text, so the name carries its hash: bounded, and
  // made of safe characters.
  const { hash } = await snapshotKey([thread]);

  return {
    scope: threadSnapshotScope,
    key: `${ref}/${name}/${hash}`,
    generation,
  };
};

/**
 * EXPERIMENTAL: The owner of one run's sandboxes for its thread.
 * @param options The run, its thread and what it uses to remember.
 */
export const threadSandboxOwner = (
  options: ThreadSandboxOptions,
): ThreadSandboxOwner => {
  const { client, ref, thread, runId, scope } = options;

  return {
    restore: async (name) => {
      const generation = await scope.get<string>(
        sandboxGenerationKey(ref, name),
      );

      if (!generation) {
        return undefined;
      }

      const found = await snapshotCache(client, {
        memo: options.run,
      }).find(await threadSnapshotEntry(ref, thread, name, generation), {
        stepId: `${name}:thread:restore`,
      });

      return found?.snapshotId;
    },

    save: async (name, sandbox) => {
      try {
        const taken = await snapshotCache(client, { memo: options.run }).take(
          await threadSnapshotEntry(ref, thread, name, runId),
          (snapshotName, n) => {
            return sandbox.snapshot(
              `${name}:thread:save:${n}`,
              snapshotName ? { name: snapshotName } : {},
            );
          },
          { stepId: `${name}:thread:save` },
        );

        // A snapshot without its name can't be found again.
        if (taken.named) {
          await recordSandboxGeneration(scope, ref, name, runId);
        }
      } catch (error) {
        if (!(error instanceof StepError)) {
          throw error;
        }
      }
    },

    guard: (name, sandbox, save) => {
      return options.defer(`${name}:thread:cleanup${save ? ":save" : ""}`, {
        name,
        sandboxId: sandbox.id,
        save,
      });
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
 * timed out, or a destroy that failed). It saves nothing when the thread
 * already has a snapshot from this run or a newer one, and destroys the
 * sandbox in every case.
 * @param options The ended run, its thread and the sandbox.
 */
export const cleanupThreadSandbox = async (
  options: CleanupThreadSandboxOptions,
): Promise<void> => {
  const { client, ref, thread, runId, scope, sandbox } = options;
  const known = await scope.get<string>(
    sandboxGenerationKey(ref, sandbox.name),
  );

  if (sandbox.save && (!known || known < runId)) {
    try {
      const named = await options.run(
        `${sandbox.name}:thread:snapshot`,
        async () => {
          const found = await client.sandboxes.get(sandbox.sandboxId);

          if (!found) {
            return false;
          }

          const taken = await snapshotCache(client).take(
            await threadSnapshotEntry(ref, thread, sandbox.name, runId),
            (snapshotName) => {
              return found.snapshot(snapshotName ? { name: snapshotName } : {});
            },
            // A newer run may have saved meanwhile; deleting "older" snapshots
            // by creation time would delete its snapshot, not this one's elders.
            { replace: false },
          );

          return taken.named;
        },
      );

      if (named) {
        await recordSandboxGeneration(scope, ref, sandbox.name, runId);
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
};
