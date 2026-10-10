/**
 * What a run warns about, in the words it uses for it. A warning that also
 * shows on a step's row has its text written once here, as a `message` for the
 * row and a `line` for the run's warnings, so the two can't drift apart.
 *
 * This is where the run's other warnings belong too (the `run.warnings.push`
 * sites that are spread over the machine, job and cache code), one entry each.
 *
 * @module
 */

import type { CacheConfig } from "../types.ts";
import type { CiRunScope } from "./scope.ts";

/** Add a line to the run's warnings, unless it already has it. */
export const warnOnce = (
  run: Pick<CiRunScope, "warnings">,
  line: string,
): void => {
  if (!run.warnings.includes(line)) {
    run.warnings.push(line);
  }
};

/**
 * What a cached job that a pipeline run had to build while the jobs that start
 * from it waited says, on the row of its lookup (`message`) and in the run's
 * warnings (`line`).
 *
 * A miss is more than "never built": the lookup also comes back empty on an
 * API error, a snapshot about to expire or still being made, or one that isn't
 * ready. The wording is true for all of them, and only advises `cache.refresh`
 * when the job has none.
 */
export const builtJustInTime = (
  jobId: string,
  cache: CacheConfig,
): { message: string; line: string } => {
  const refreshed = Boolean(cache.refresh?.length);

  return {
    message: `\`${jobId}\` had no usable cached snapshot for these inputs, so it was built while the jobs that start from it waited. ${
      refreshed
        ? "Its `cache.refresh` triggers hadn't built a usable snapshot for these inputs yet."
        : "Add `cache.refresh` to build it ahead of time."
    }`,
    line: `built just in time: \`${jobId}\` (${
      refreshed
        ? "not refreshed for these inputs yet"
        : "add `cache.refresh` to build it ahead of time"
    })`,
  };
};
