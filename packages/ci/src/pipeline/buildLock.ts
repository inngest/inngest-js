/**
 * The build lock: how concurrent runs that miss the same cached job build it
 * once, and every one of them gets the snapshot the moment it exists.
 *
 * A run that needs a cached job's snapshot does not build it, or invoke a build
 * and sit in its queue. It listens for `ci/build.done` for the entry's lock,
 * looks the snapshot up, and on a miss sends `ci/build.requested`. The
 * `ci/build` function that receives it tries to create a machine under the
 * lock's name (`ci-build-<hash>`, derived from the cache entry), owned by its
 * run. The platform refuses a name that is taken, so only one builder wins: the
 * others end at once, with nothing to wait for or to poll. The winner builds,
 * snapshots, and when its run ends destroys its machine and sends
 * `ci/build.done`, which carries what the build gave back, to everyone
 * listening on that lock, whichever run's request it was that started the
 * build.
 *
 * Why no wake-up is missed. The requester saves its wait before it looks, and
 * looks before it sends its request. The builder takes its snapshot, which is
 * findable by name once taken (it checks), before it sends `ci/build.done`. So
 * a build that finishes after the wait was saved reaches the wait, and one that
 * finished before it is found by the look. A wait only misses events from
 * before it was saved (there is no lookback), and a look that misses means the
 * snapshot was taken after it, so after the wait was saved too, and its event
 * comes later still. The executor saves a `waitForEvent` before it enqueues the
 * other steps planned with it, which is what puts the wait before the look.
 *
 * What is left to chance, a builder that died without a trace or an event that
 * was not sent, ends in the wait's timeout: the requester then checks whether
 * the lock's machine still exists. If it does it waits again, because a long
 * build is still going, and if it is gone it asks again. A builder that dies is
 * also noticed by the `ci/build` cleanup function, which releases its lock and
 * sends a `failed` `ci/build.done`.
 *
 * A wait that nobody ends keeps its run open, so a requester that found the
 * snapshot by its look sends the event its wait is for, with that snapshot.
 *
 * @module
 */

import { group, NonRetriableError } from "inngest";
import type { CachedSnapshot, CacheTarget } from "../cache/cache.ts";
import { lookupBeforeBuild } from "../cache/cache.ts";
import type { NamePolicy } from "../cache/namePolicy.ts";
import { lockMachineAlive, lockMachineName } from "../machine/machine.ts";
import type { JobConfig } from "../types.ts";
import { errorMessage } from "../util.ts";
import type { CacheBuildData, CacheBuildResult } from "./cacheBuild.ts";
import { ciRun } from "./metadata.ts";
import { ciStep, steps, traceName } from "./names.ts";
import type { CiJobScope, CiRunScope } from "./scope.ts";
import { joinId, rootRunIdOf } from "./scope.ts";

/** The event a run sends to ask for a cache entry to be built. */
export const buildRequestedEvent = "ci/build.requested";

/** The event whoever let go of a build lock sends, for those waiting on it. */
export const buildDoneEvent = "ci/build.done";

/** What a build sends when it lets go of its lock. */
export type BuildDone = { name: string } & (
  | {
      status: "ready";
      /** The pipeline run whose request the build answered, which built it. */
      builtFor?: string;
      /** What the build gave back, as an invoked build would have. */
      result: CacheBuildResult;
    }
  | { status: "failed"; reason: string }
);

/**
 * Whether a build of this job takes the lock. A job that starts `from`
 * another can't: a machine created from a snapshot takes no environment, so
 * nothing on it could say who owns it. A build that takes no name, or replaces
 * a bad snapshot, is not for sharing, and a job without a `cache` is only for
 * its own pipeline run.
 */
export const takesBuildLock = (
  config: JobConfig,
  name: NamePolicy,
): boolean => {
  return (
    config.cache !== undefined &&
    config.from === undefined &&
    name.kind === "take"
  );
};

/**
 * Get a cached job's snapshot from whichever run builds it, asking for a build
 * if none is under way. Every wait and look is a step of its own, so a
 * replayed run goes through the same rounds and finds the same answers.
 */
export const requestBuild = async ({
  run,
  path,
  stepPath,
  config,
  target,
  data,
  reused,
}: {
  run: CiRunScope;
  /** The job's path here, which is where the activity goes. */
  path: string;
  /** What the steps' IDs are built on. */
  stepPath: string;
  config: JobConfig;
  target: CacheTarget;
  /** What the builder needs, which it can't work out from the lock. */
  data: CacheBuildData;
  /** What a build gives back for a snapshot that is found. */
  reused: (cached: CachedSnapshot) => CacheBuildResult;
}): Promise<CacheBuildResult> => {
  const name = lockMachineName(target.name);

  // The function that takes the request is made once per client, whether or
  // not `functions()` has been called to serve it.
  run.ci.cacheBuild();

  const id = (what: string): string => {
    return joinId(stepPath, `build:${what}`);
  };

  /**
   * What a build that passed gives this run. The run whose request was built
   * gets what the build gave back, which includes what only it can use: the
   * snapshots to delete when it ends, and the report for its check. Every
   * other run adopts the cache entry.
   */
  const adopt = (
    done: Extract<BuildDone, { status: "ready" }>,
  ): CacheBuildResult => {
    const { result } = done;

    if (done.builtFor === rootRunIdOf(run)) {
      return result;
    }

    if (result.cached) {
      return reused(result.cached);
    }

    return {
      reused: false,
      target,
      hadMachine: result.hadMachine,
      createdSnapshots: [],
      warnings: [],
      summary: {
        path: config.id,
        conclusion: "success",
        title: "Built in another run",
        durationMs: 0,
      },
    };
  };

  let failures = 0;
  let requests = 0;
  let ask = true;

  for (let round = 0; ; round++) {
    const label = round === 0 ? "" : ` (round ${round})`;
    const { result, wake, woken } = await waitAndLook({
      run,
      path,
      config,
      target,
      name,
      label,
      stepPath,
      reused,
    });

    if (result) {
      return result;
    }

    // A build that ended while the look ran has already answered.
    if (ask && !woken()) {
      run.ci.hooks.activity(run, path, "asking for a build…");

      await run.step.sendEvent(
        ciStep(
          joinId(stepPath, `build${requests > 0 ? ` (${requests})` : ""}`),
          traceName.askForBuild(path),
        ),
        {
          name: buildRequestedEvent,
          data: {
            ...data,
            locked: true,
            app: run.ci.client.id,
            slot: requests === 0 ? name : `${name}:${requests}`,
          },
        },
      );
    }

    ask = false;

    const done = await wake;

    if (done) {
      const finished = done.data as BuildDone;

      if (finished.status === "ready") {
        return adopt(finished);
      }

      // One more try, since a builder can die for reasons that are not the
      // job's. A second failure is the job's.
      if (++failures > 1) {
        throw new NonRetriableError(
          `The build of \`${config.id}\` failed: ${finished.reason}`,
        );
      }

      run.ci.hooks.activity(run, path, "the build failed, asking again…");

      requests++;
      ask = true;

      continue;
    }

    // Nothing came in time. A lock that is still held is a build still going,
    // however long it takes, and one that is gone left nothing to wait for.
    const alive = await ciRun(
      run,
      steps.checkBuildLock(id(`alive${label}`), name),
      () => {
        return lockMachineAlive(run.ci.client, name);
      },
    );

    if (!alive) {
      requests++;
      ask = true;
    }
  }
};

/**
 * Check that a snapshot the build took can be found by its name, before the
 * build says it is there: a run that looked a moment ago and saw nothing relies
 * on it. A snapshot that is not kept under the name is not shared, so there is
 * nothing to check.
 */
export const confirmBuilt = async (
  scope: CiJobScope,
  target: CacheTarget,
): Promise<void> => {
  const { run, config } = scope;

  if (!run.buildLock || !scope.request?.sink.outcome?.cached) {
    return;
  }

  const found = await lookupBeforeBuild(
    run,
    {
      id: config.id,
      path: scope.path,
      stepPath: joinId(scope.path, "built"),
    },
    config.cache,
    target,
  );

  if (!found) {
    throw new NonRetriableError(
      "The snapshot could not be found by its name after the build.",
    );
  }
};

/**
 * Tell the runs waiting on a lock how its build ended, once the run has
 * destroyed the machine that held it, so a run the event wakes finds the lock
 * free. A build that did not take the lock has nobody to tell.
 */
export const endBuild = async (
  run: CiRunScope,
  outcome: { kind: string; result?: unknown; error?: unknown },
): Promise<void> => {
  const lock = run.buildLock;

  if (!lock) {
    return;
  }

  const result = outcome.result as CacheBuildResult | undefined;

  await announce(
    run,
    joinId("pipeline", "lock:done"),
    outcome.kind === "ran" && result
      ? {
          name: lock.name,
          status: "ready",
          builtFor: rootRunIdOf(run),
          result: fitsInEvent(result)
            ? result
            : { ...result, report: undefined },
        }
      : {
          name: lock.name,
          status: "failed",
          reason:
            outcome.error === undefined
              ? "the build ended without a result"
              : errorMessage(outcome.error),
        },
  );
};

/**
 * Whether a value is small enough to ride on `ci/build.done`, which the
 * platform limits in size. The report of a job that does not fit is left out,
 * and the job's own check goes without it.
 */
const fitsInEvent = (value: unknown): boolean => {
  return JSON.stringify(value).length < 100_000;
};

/**
 * Send that a build ended. A send that fails only costs the runs waiting the
 * rest of their wait, so it never fails the build.
 */
const announce = async (
  run: CiRunScope,
  id: string,
  done: BuildDone,
): Promise<void> => {
  try {
    await run.step.sendEvent(ciStep(id, traceName.announceBuild), {
      name: buildDoneEvent,
      data: done,
    });
  } catch {
    run.warnings.push(
      `couldn't tell the runs waiting on a build of \`${done.name}\` that it ended`,
    );
  }
};

/**
 * One round's start: save the wait for the lock's `ci/build.done`, look the
 * snapshot up, and say what the look found. The one place that holds the
 * wait-beside-look logic, so a change to how a round starts is a change here.
 * On a hit the result is returned (and announced, to end the wait); on a miss
 * `result` is undefined and the caller goes on with `wake`.
 */
const waitAndLook = async ({
  run,
  path,
  config,
  target,
  name,
  label,
  stepPath,
  reused,
}: {
  run: CiRunScope;
  path: string;
  config: JobConfig;
  target: CacheTarget;
  /** The lock's name. */
  name: string;
  /** Tells this round's steps from the others'. */
  label: string;
  stepPath: string;
  reused: (cached: CachedSnapshot) => CacheBuildResult;
}): Promise<{
  result?: CacheBuildResult;
  /** The wait: the build's event, or null when it ran out. */
  wake: Promise<{ data?: unknown } | null>;
  /** Whether the wait has already been answered. */
  woken: () => boolean;
}> => {
  let answered = false;
  let wake: Promise<{ data?: unknown } | null> | undefined;

  // The wait is planned beside the look, in a race so the run goes on when the
  // look is done instead of when the wait is: the executor saves the wait
  // first, and a wait nobody has ended does not hold the look back.
  const found = await group.parallel({ mode: "race" }, async () => {
    wake = run.step
      .waitForEvent(
        ciStep(
          joinId(stepPath, `build:wait${label}`),
          traceName.waitForBuild(path),
        ),
        {
          event: buildDoneEvent,
          if: `async.data.name == '${name}'`,
          timeout: run.ci.buildWait,
        },
      )
      .then((event: { data?: unknown } | null) => {
        answered = true;

        return event;
      });

    return lookupBeforeBuild(
      run,
      { id: config.id, path, stepPath: `${stepPath}${label}` },
      config.cache,
      target,
    );
  });

  if (!wake) {
    throw new Error("The wait for a build was not planned.");
  }

  const woken = () => {
    return answered;
  };

  if (!found) {
    return { wake, woken };
  }

  const result = reused(found);

  // Its wait keeps this run open until something ends it, so say what it is
  // for. It is also true, and others waiting are glad of it.
  await announce(run, joinId(stepPath, `build:found${label}`), {
    name,
    status: "ready",
    result,
  });

  return { result, wake, woken };
};
