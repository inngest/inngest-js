/**
 * Asking what a run changed: `changed()` and the file list behind it, read
 * from the pull request, the push range, or local git.
 *
 * @module
 */

import { CiUsageError } from "../errors.ts";
import { ciRun } from "../pipeline/metadata.ts";
import { traceName } from "../pipeline/names.ts";
import type { CiRunScope } from "../pipeline/scope.ts";
import { countApi, getRunScope } from "../pipeline/scope.ts";
import type { RepoContext } from "../types.ts";
import { filterPaths, git } from "../util.ts";
import { parsePorcelainPaths } from "./porcelain.ts";

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
 * When the change can't be read (no credentials, say) this answers `true`
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

  countApi("changed");

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
 * be read, a cron with no repository, or a run with no GitHub credentials.
 */
export const changedFiles = async (): Promise<string[] | null> => {
  const run = getRunScope();

  if (!run) {
    throw new CiUsageError(
      "`changed()` was called outside a pipeline run. Call it from inside `ci.pipeline()`.",
    );
  }

  // The promise is stored before anything awaits, so concurrent callers share
  // one step with one ID whichever of them asks first. Which job asks first
  // differs between requests, and a step ID taken from the asker or a counter
  // would be found on one request and missing on the next.
  run.changedFiles ??= readChangedFiles(run);

  return run.changedFiles;
};

const readChangedFiles = async (run: CiRunScope): Promise<string[] | null> => {
  const files = await ciRun<string[] | { unknown: true; reason: string }>(
    run,
    {
      step: { id: "changed", name: traceName.findChangedFiles },
      intent: "Find the files this change touched",
    },
    async (note) => {
      try {
        const listed = await listChangedFiles(run.repo);

        note.outcome({ count: listed.length });

        return listed;
      } catch (error) {
        if (!(error instanceof CiUsageError)) {
          throw error;
        }

        note.outcome({ count: null, unknown: true });

        // No credentials, so the change can't be read. The caller assumes
        // everything changed rather than skipping work it shouldn't.
        return { unknown: true as const, reason: error.message };
      }
    },
  );

  if (!Array.isArray(files)) {
    run.warnings.push(
      `\`changed()\` assumed everything changed: ${files.reason}`,
    );

    return null;
  }

  return files;
};

const listChangedFiles = async (
  repo: RepoContext | undefined,
): Promise<string[]> => {
  // Without a repository there's nothing to compare, and an empty list would
  // skip work that may have changed, so say so and the caller assumes
  // everything changed.
  if (!repo) {
    throw new CiUsageError("this run has no repository to read changes from.");
  }

  if (repo.local && process.env.INNGEST_CI_GITHUB !== "live") {
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
    return files.slice(0, 3000).map((file) => {
      return file.filename;
    });
  }

  // A push that creates a branch has no previous commit (`before` is all
  // zeros), so there is no range to compare.
  if (repo.baseSha && /^0+$/.test(repo.baseSha)) {
    throw new CiUsageError(
      "this push created the branch, so there is no previous commit to compare against.",
    );
  }

  if (repo.baseSha && repo.sha) {
    const basehead = `${repo.baseSha}...${repo.sha}`;

    return collectComparedFiles(async (page) => {
      const comparison = await rest.repos.compareCommitsWithBasehead({
        basehead,
        per_page: comparePageSize,
        page,
      });

      return (comparison.files ?? []).map((file) => {
        return file.filename;
      });
    });
  }

  // No pull request and no push range (a cron, a manual run, a merge group):
  // an empty list would skip work that may have changed.
  throw new CiUsageError(
    "this run has no pull request or push range to read changes from.",
  );
};

/** GitHub's page size for a compare, and the most files it will list. */
const comparePageSize = 100;
const compareFileLimit = 300;

/**
 * Read a compare's files a page at a time. A compare lists at most 300 files
 * and doesn't say when it stopped there, so reaching the limit means the list
 * may be incomplete and the change is unknown.
 */
export const collectComparedFiles = async (
  fetchPage: (page: number) => Promise<string[]>,
): Promise<string[]> => {
  const files: string[] = [];

  for (let page = 1; files.length < compareFileLimit; page++) {
    const batch = await fetchPage(page);

    files.push(...batch);

    if (batch.length < comparePageSize) {
      return files;
    }
  }

  throw new CiUsageError(
    `the compare lists ${compareFileLimit} files, which is as many as GitHub returns, so some changed files may be missing.`,
  );
};

/**
 * Paths changed locally against a base ref, including untracked files. This is
 * what `changed()` uses when a run came from a local fixture.
 */
export const localChangedFiles = async (
  cwd: string,
  baseRef: string,
): Promise<string[]> => {
  let committed: string[] | undefined;

  for (const target of [`origin/${baseRef}`, baseRef]) {
    try {
      const diff = await git(cwd, [
        "diff",
        "--name-only",
        "-z",
        `${target}...HEAD`,
      ]);

      committed = diff.split("\0").filter(Boolean);

      break;
    } catch {
      // Try the next candidate; a fresh clone may have no origin.
    }
  }

  // Without the base there is nothing to compare against, and an empty diff
  // would skip work that may have changed. Say so, and the caller assumes
  // everything changed.
  if (!committed) {
    throw new CiUsageError(
      `\`changed()\` could not find \`${baseRef}\` in \`${cwd}\` to compare against.`,
    );
  }

  const status = await git(cwd, [
    "status",
    "--porcelain",
    "-z",
    "--untracked-files=all",
  ]);

  const uncommitted = parsePorcelainPaths(status);

  return [...new Set([...committed, ...uncommitted])];
};
