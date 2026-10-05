/**
 * Asking what a run changed: `changed()` and the file list behind it, read
 * from the pull request, the push range, or local git.
 *
 * @module
 */

import { CiUsageError } from "../errors.ts";
import { nextStepId } from "../pipeline/scope.ts";
import type { RepoContext } from "../types.ts";
import { filterPaths } from "../util.ts";

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Whether any of the run's changed files match the given patterns.
 *
 * This runs in your app rather than on a machine, so a pipeline can decide
 * there's nothing to do before paying for one:
 *
 * ```ts
 * if (!(await changed("src/**", "package.json"))) {
 *   return ci.skip("nothing that affects the build changed");
 * }
 *
 * if (await changed({ include: ["docs/**"], ignore: ["docs/**\/*.png"] })) {
 *   await docsSite();
 * }
 * ```
 *
 * Patterns support `**`, `*`, `?`, and `{a,b}`. The changed files come from
 * the pull request or the push range on GitHub, and from git locally.
 *
 * When the change can't be read — no credentials, say — this answers `true`
 * and notes it on the check, so work runs rather than being skipped wrongly.
 *
 * @throws {CiUsageError} When called outside a pipeline run.
 */
export function changed(...patterns: string[]): Promise<boolean>;
export function changed(opts: {
  include?: string[];
  ignore?: string[];
}): Promise<boolean>;
export async function changed(
  ...args: [{ include?: string[]; ignore?: string[] }] | string[]
): Promise<boolean> {
  const first = args[0];
  const opts =
    typeof first === "object" && first !== null
      ? first
      : { include: args as string[] };

  const files = await changedFiles();

  // Without a way to read the change, the safe answer is "something might
  // have", so a pipeline runs rather than silently skipping.
  if (files === null) {
    return true;
  }

  return filterPaths(files, opts).length > 0;
}

/**
 * The paths changed by whatever triggered this run, or `null` when they can't
 * be read — a cron with no repository, or a run with no GitHub credentials.
 */
export const changedFiles = async (): Promise<string[] | null> => {
  const { getRunScope } = await import("../pipeline/scope.ts");
  const run = getRunScope();

  if (!run) {
    throw new CiUsageError(
      "`changed()` was called outside a pipeline run. Call it from inside `ci.pipeline()`.",
    );
  }

  const cached = run.changedFiles;
  if (cached) {
    return cached;
  }

  const { getJobScope } = await import("../pipeline/scope.ts");
  const scopePath = getJobScope()?.path;
  const id = nextStepId(run, scopePath, "changed");

  const files = (await run.step.run({ id, name: id }, async () => {
    try {
      return await listChangedFiles(run.repo);
    } catch (error) {
      if (!(error instanceof CiUsageError)) {
        throw error;
      }

      // No credentials, so the change can't be read. The caller assumes
      // everything changed rather than skipping work it shouldn't.
      return { unknown: true as const, reason: error.message };
    }
  })) as string[] | { unknown: true; reason: string };

  if (!Array.isArray(files)) {
    run.warnings.push(
      `\`changed()\` assumed everything changed: ${files.reason}`,
    );
    return null;
  }

  run.changedFiles = files;
  return files;
};

const listChangedFiles = async (
  repo: RepoContext | undefined,
): Promise<string[]> => {
  if (!repo) {
    return [];
  }

  if (repo.local && process.env.INNGEST_CI_GITHUB !== "live") {
    const { localChangedFiles } = await import("./checkout.ts");
    return localChangedFiles(repo.local.path, repo.local.baseRef);
  }

  const { paginate } = await import("../github/helpers.ts");
  const { rest } = await import("../github/rest.ts");

  if (repo.pullRequest) {
    const files = await paginate(rest.pulls.listFiles, {
      pull_number: repo.pullRequest.number,
      per_page: 100,
    });

    // Pull requests list at most 3000 files, which is also where this stops
    // being a useful signal.
    return files.slice(0, 3000).map((file) => file.filename);
  }

  if (repo.baseSha && repo.sha) {
    const comparison = await rest.repos.compareCommitsWithBasehead({
      basehead: `${repo.baseSha}...${repo.sha}`,
    });

    return (comparison.files ?? []).map((file) => file.filename);
  }

  return [];
};
