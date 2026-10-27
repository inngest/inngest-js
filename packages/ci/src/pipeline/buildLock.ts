/**
 * The build lock: how concurrent runs that miss the same cached job build it
 * once, and every one of them gets the snapshot the moment it exists.
 *
 * A run that needs a cached job's snapshot does not build it, or invoke a build
 * and sit in its queue. It listens for `ci/build.done` for the entry's lock,
 * looks the snapshot up, and on a miss sends `ci/build.requested`. The
 * `ci/build` function that receives it tries to create a machine under the
 * lock's name (`ci-build-<hash>`, derived from the cache entry). The platform
 * refuses a name that is taken, so only one builder wins: the
 * others end at once, with nothing to wait for or to poll. The winner builds,
 * snapshots, and when its run ends destroys its machine and sends
 * `ci/build.done`, which carries what the build gave back, to everyone
 * listening on that lock, whichever run's request it was that started the
 * build.
 *
 * Why no wake-up is missed. The requester saves its wait before it looks, and
 * looks before it sends its request. The builder takes its snapshot, which is
 * findable by name once taken, before it sends `ci/build.done`. So
 * a build that finishes after the wait was saved reaches the wait, and one that
 * finished before it is found by the look. A wait only misses events from
 * before it was saved (there is no lookback), and a look that misses means the
 * snapshot was taken after it, so after the wait was saved too, and its event
 * comes later still. The executor saves a `waitForEvent` before it enqueues the
 * other steps planned with it, which is what puts the wait before the look
 * (the pipeline functions turn off optimized parallelism, so the look is not
 * held until the wait ends).
 *
 * TODO: `@inngest/ci` needs the `inngest` release that completes a run on
 * return with `optimizeParallelism: false`. Set the exact version in the peer
 * dependency range once it is released.
 *
 * What is left to chance, a builder that died without a trace or an event that
 * was not sent, ends in the wait's timeout: the requester then looks and asks
 * again. A builder whose run ends sends a `failed` `ci/build.done` for its own
 * lock from its own cleanup.
 *
 * A requester that found the snapshot by its look leaves its wait unawaited and
 * returns: the run completes and the executor drops the wait with it.
 *
 * @module
 */

import { NonRetriableError } from "inngest";
import type { CachedSnapshot, CacheTarget } from "../cache/cache.ts";
import { lookupBeforeBuild } from "../cache/cache.ts";
import { lockMachineName } from "../machine/machine.ts";
import type { JobConfig } from "../types.ts";
import { errorMessage } from "../util.ts";
import type { CacheBuildData, CacheBuildResult } from "./cacheBuild.ts";
import { ciStep, traceName } from "./names.ts";
import type { CiRunScope } from "./scope.ts";
import { joinId, rootRunIdOf } from "./scope.ts";
import { sessionsMeta } from "./sessions.ts";

/** The event a run sends to ask for a cache entry to be built. */
export const buildRequestedEvent = "ci/build.requested";

/** The event whoever let go of a build lock sends, for those waiting on it. */
export const buildDoneEvent = "ci/build.done";

/**
 * How long a run waits for a build's event before it looks and asks again. A
 * request for a build that is still going is skipped, so this only bounds how
 * long a lost build goes unnoticed.
 */
const buildWait = "15m";

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
 * another doesn't: its machine starts from a snapshot, under a name of its
 * own. A build that takes no name, or replaces a bad snapshot, is not for
 * sharing, and a job without a `cache` is only for its own pipeline run.
 */
export const takesBuildLock = (
  config: JobConfig,
  request: { exclude?: string; unnamed?: boolean },
): boolean => {
  return (
    config.cache !== undefined &&
    config.from === undefined &&
    !request.exclude &&
    !request.unnamed
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
      ancestry: result.ancestry,
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

  for (let round = 0; ; round++) {
    const label = round === 0 ? "" : ` (round ${round})`;

    // Planned first and not awaited, so it is in the same batch as the look,
    // and the executor saves it before it runs the look. A hit leaves it
    // unawaited for the run to complete over.
    const wake: Promise<{ data?: unknown } | null> = run.step.waitForEvent(
      ciStep(
        joinId(stepPath, `build:wait${label}`),
        traceName.waitForBuild(path),
      ),
      {
        event: buildDoneEvent,
        if: `async.data.name == '${name}'`,
        timeout: buildWait,
      },
    );

    const found = await lookupBeforeBuild(
      run,
      { id: config.id, path, stepPath: `${stepPath}${label}` },
      config.cache,
      target,
    );

    if (found) {
      return reused(found);
    }

    run.ci.hooks.activity(run, path, "asking for a build…");

    // A request for a build that is still going is skipped, so asking again
    // after a wait that ran out is how a lost build is noticed.
    await run.step.sendEvent(
      ciStep(joinId(stepPath, `build${label}`), traceName.askForBuild(path)),
      {
        name: buildRequestedEvent,
        data: {
          ...data,
          locked: true,
          app: run.ci.client.id,
          slot: failures === 0 ? name : `${name}:${failures}`,
        },
        meta: sessionsMeta(run, { jobId: config.id, target }),
      },
    );

    const done = await wake;

    if (!done) {
      continue;
    }

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
