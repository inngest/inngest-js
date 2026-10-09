/**
 * The build lock: how concurrent runs that miss the same cached job avoid
 * building it twice.
 *
 * A build already boots a machine, so that machine is the lock. It is created
 * under a name derived from the cache entry and owned by the run that builds
 * (`OWNER` in its environment). The first run to create it builds. Every other
 * run's create is refused with `sandbox_name_taken`, since its owner differs,
 * so it waits to be woken: a hit is adopted, and a miss claims the lock again,
 * which succeeds once the owner has destroyed its machine or been cleaned up
 * after. The winner destroys the machine as soon as its snapshot is taken, or
 * the build failed, so the lock lasts as long as the build does.
 *
 * A run waits for the `ci/build.done` event that whoever lets go of the lock
 * sends, and saves that wait before it claims. The lock then orders the two: a
 * claim that is refused means the holder had not let go yet, so its event comes
 * after the wait was saved, and a wait only misses events from before it was
 * saved. A wait that nothing wakes, for a holder that died without a trace,
 * times out and looks again, so no silence lasts longer than that.
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
 * With `lockWaitSeconds`, about half an hour if nothing ever wakes it.
 */
const maxClaims = 15;

/**
 * How long a refused build waits to be woken before it looks for itself. Only a
 * holder that died without a trace leaves a build waiting this long.
 */
export const lockWaitSeconds = 120;

/** The event whoever lets go of a build lock sends, for those waiting on it. */
export const buildDoneEvent = "ci/build.done";

/** What a build lock's holder sends when it lets go. */
export interface BuildDone {
  /** The lock's name. */
  name: string;
  /** Whether the holder left a snapshot to adopt, or none. */
  status: "ready" | "failed";
}

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

    // Saved before the claim and left unawaited until the claim is refused. A
    // claim that is won leaves it to time out unwatched.
    const wake = run.step.waitForEvent(
      {
        id: `${scope.path}${scopeSeparator}lock:wake (${attempt + 1})`,
        name: "lock:wake",
      },
      {
        event: buildDoneEvent,
        if: `async.data.name == '${name}'`,
        timeout: `${lockWaitSeconds}s`,
      },
    );

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

      // A holder that died after its snapshot but before it let go.
      const present = await look();

      if (present) {
        // The wait is still open, and a run doesn't end while a step it found
        // is, so this sends what the wait is for. It is also true.
        await announceBuildDone(scope, name, "ready");

        scope.buildLock = undefined;

        return { kind: "adopted", snapshot: present };
      }

      const done = await wake;

      // A failed build left nothing to find.
      const snapshot =
        done?.data?.status === "failed" ? undefined : await look();

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
      await releaseBuildLock(scope, "ready");

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
 * Let go of the lock by destroying the machine that holds it, then wake the
 * runs waiting on it. The machine is destroyed whether the build passed or not,
 * and the cleanup function does the same for a build that never got here. The
 * event comes last, so a run it wakes finds the lock free.
 */
export const releaseBuildLock = async (
  scope: CiJobScope,
  status: BuildDone["status"],
): Promise<void> => {
  const name = scope.buildLock?.name;

  await destroyMachine(scope, `${scope.path}${scopeSeparator}lock:release`);

  scope.machine = undefined;

  if (name) {
    await announceBuildDone(scope, name, status);
  }
};

/**
 * Send that a lock was let go. A send that fails only costs the waiting runs
 * the rest of their wait, so it never fails the build.
 */
const announceBuildDone = async (
  scope: CiJobScope,
  name: string,
  status: BuildDone["status"],
): Promise<void> => {
  const { run } = scope;

  try {
    await run.step.sendEvent(
      {
        id: `${scope.path}${scopeSeparator}lock:done`,
        name: "lock:done",
      },
      { name: buildDoneEvent, data: { name, status } satisfies BuildDone },
    );
  } catch {
    run.warnings.push(
      `couldn't tell runs waiting on \`${scope.path}\` that its build ended`,
    );
  }
};

/** The code a create gets when another machine holds the name. */
const nameTakenCode = "sandbox_name_taken";
