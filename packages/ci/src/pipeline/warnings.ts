/**
 * What a run warns about, in the words it uses for it. A warning that shows on
 * a step's row and in the run's warnings has its text written once here, as a
 * `message` for the row and a `line` for the run. A new warning is one function
 * here that returns both.
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
 * A cached job that was built while the jobs that start from it waited. A miss
 * is more than "never built": the lookup also comes back empty on an API error
 * or a snapshot that is expiring or still being made, so the wording is true
 * for all of them and only advises `cache.refresh` when the job has none.
 */
export const builtJustInTime = (
  jobId: string,
  cache: CacheConfig,
): { message: string; line: string } => {
  const refreshed = Boolean(cache.refresh?.length);

  const hint = refreshed
    ? "not refreshed for these inputs yet"
    : "add `cache.refresh` to build it ahead of time";

  return {
    message: `\`${jobId}\` had no usable cached snapshot for these inputs, so it was built while the jobs that start from it waited (${hint}).`,
    line: `built just in time: \`${jobId}\` (${hint})`,
  };
};
