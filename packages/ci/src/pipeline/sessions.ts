/**
 * The Inngest Sessions CI puts on the runs and events it starts, so a pull
 * request, a commit, a pipeline run and a built image each show up as one
 * session in the dashboard.
 *
 * The webhook transform sets `pull_request` and `commit` on the trigger
 * event, and the SDK passes a run's sessions on to every event and invoke it
 * makes. This file adds the two that are CI's own: `ci_run`, the pipeline
 * run at the root, and `image`, a cached job's build. An event carries five
 * sessions and the manual ones are kept first, so the sessions here (two at
 * most) are never the ones dropped.
 *
 * @module
 */

import type { CacheTarget } from "../cache/cache.ts";
import { boundedName } from "../util.ts";
import type { CiRunScope } from "./scope.ts";
import { rootRunIdOf } from "./scope.ts";

/** Session IDs are limited to 512 bytes. */
const maxSessionId = 512;

/**
 * The `meta` of an event or invoke CI starts for a run: the run's root
 * pipeline run, and the image when the request is for a cached job's build.
 */
export const sessionsMeta = (
  run: CiRunScope,
  /** The cached job a build request is for. */
  image?: { jobId: string; target: CacheTarget },
): { sessions: Record<string, string> } => {
  return {
    sessions: {
      ci_run: rootRunIdOf(run),
      ...(image?.target.ownKey
        ? {
            image: boundedName(
              `${image.jobId}@${image.target.ownKey}`,
              maxSessionId,
            ),
          }
        : {}),
    },
  };
};
