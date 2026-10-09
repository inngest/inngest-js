/**
 * The build lock: how concurrent runs that miss the same cached job avoid
 * building it twice.
 *
 * A build already boots a machine, so that machine is the lock. It is created
 * under a name derived from the cache entry and owned by the run that builds
 * (`OWNER` in its environment). The first run to create it builds. Every other
 * run's create is refused with `sandbox_name_taken`, since its owner differs,
 * so it sleeps and then looks the snapshot up again: a hit is adopted, and a
 * miss claims the lock again, which succeeds once the owner has destroyed its
 * machine or been cleaned up after. The winner destroys the machine as soon as
 * its snapshot is taken, or the build failed, so the lock lasts as long as the
 * build does.
 *
 * Creating a machine again with the same name and settings gives the existing
 * one back, so a run that retries an ambiguous create finds its own lock.
 *
 * @module
 */

import type { CachedSnapshot, CacheTarget } from "../cache/cache.ts";
import { lookupCache } from "../cache/cache.ts";
import { destroyMachine, ensureMachine } from "../machine/machine.ts";
import type { CacheConfig } from "../types.ts";
import { hasErrorCode, hash } from "../util.ts";
import type { CiJobScope } from "./scope.ts";
import { scopeSeparator } from "./scope.ts";

/**
 * The name of the machine that holds a cache entry's lock. The entry's name
 * already carries its scope, job and key, which include the app and the
 * repository, so apps and repositories never block each other.
 */
export const buildLockName = (cacheKey: string): string => {
  return `ci-build-${hash(cacheKey, 32)}`;
};

/**
 * How many times a build tries to claim the lock before it builds without it.
 * With `lockWaitSeconds`, about twenty minutes in all.
 */
const maxClaims = 60;

/** How long to wait after the nth refused claim, counting from 0. */
export const lockWaitSeconds = (refused: number): number => {
  return Math.min(5 + refused * 5, 30);
};

/** What claiming the lock came to. */
export type LockClaim =
  /** This build holds the lock, on its machine, and builds. */
  | { kind: "held" }
  /** Another build took the snapshot while this one waited, so it is adopted. */
  | { kind: "adopted"; snapshot: CachedSnapshot }
  /** The lock stayed held for too long, so this build goes ahead without it. */
  | { kind: "unlocked" };

/**
 * Claim the lock for a build's cache entry by creating its machine under the
 * lock's name, waiting while another run holds it.
 *
 * Every wait and every look is a step of its own, so a replayed run goes
 * through the same claims and finds the same answers.
 */
export const claimBuildLock = async ({
  scope,
  cache,
  target,
  exclude,
}: {
  scope: CiJobScope;
  cache: CacheConfig;
  target: CacheTarget;
  /** A snapshot found to be bad, which counts as a miss. */
  exclude?: string;
}): Promise<LockClaim> => {
  const { run } = scope;
  const name = buildLockName(target.name);

  let looks = 0;

  const look = (): Promise<CachedSnapshot | undefined> => {
    looks++;

    return lookupCache(scope, cache, target, exclude, looks);
  };

  for (let attempt = 0; attempt < maxClaims; attempt++) {
    scope.buildLock = { name, attempt };

    try {
      await ensureMachine(scope);
    } catch (error) {
      scope.machine = undefined;

      if (!hasErrorCode(error, nameTakenCode)) {
        scope.buildLock = undefined;

        throw error;
      }

      run.ci.hooks.activity(
        run,
        scope.jobPath,
        "waiting for another run's build of this…",
      );

      await run.step.sleep(
        {
          id: `${scope.path}${scopeSeparator}lock:wait (${attempt + 1})`,
          name: "lock:wait",
        },
        `${lockWaitSeconds(attempt)}s`,
      );

      const snapshot = await look();

      if (snapshot) {
        scope.buildLock = undefined;

        return { kind: "adopted", snapshot };
      }

      continue;
    }

    // The lock was free, but its owner may have finished since this build
    // looked: its snapshot is taken before it lets go.
    const snapshot = await look();

    if (snapshot) {
      await releaseBuildLock(scope);

      scope.buildLock = undefined;

      return { kind: "adopted", snapshot };
    }

    return { kind: "held" };
  }

  run.warnings.push(
    `built without the lock: another run's build of \`${scope.path}\` held it for too long`,
  );

  scope.buildLock = undefined;

  return { kind: "unlocked" };
};

/**
 * Let go of the lock by destroying the machine that holds it. The machine is
 * destroyed whether the build passed or not, and the cleanup function does the
 * same for a build that never got here.
 */
export const releaseBuildLock = async (scope: CiJobScope): Promise<void> => {
  await destroyMachine(scope, `${scope.path}${scopeSeparator}lock:release`);

  scope.machine = undefined;
};

/** The code a create gets when another machine holds the name. */
const nameTakenCode = "sandbox_name_taken";
