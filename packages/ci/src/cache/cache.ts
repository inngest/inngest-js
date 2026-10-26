/**
 * The machinery behind a job's `cache` option: keys, the names cached
 * snapshots are found by, looking them up, checking what they were built from,
 * and the `files()` key helper.
 *
 * A cached job is the snapshot of its machine, named after the job's key. There
 * is no other record of it: a run works out the key and name itself, and what
 * a job started from it needs to know travels in the build's result.
 *
 * @module
 */

import { NonRetriableError } from "inngest";
import { CiUsageError } from "../errors.ts";
import { mapGitHubError, rest } from "../github/rest.ts";
import type { ResolvedSource } from "../github/source.ts";
import {
  octokitForSource,
  resolveSource,
  targetsRunRepo,
} from "../github/source.ts";
import { ciRun } from "../pipeline/metadata.ts";
import type { StepSpec } from "../pipeline/names.ts";
import { steps } from "../pipeline/names.ts";
import type { CiJobScope, CiRunScope } from "../pipeline/scope.ts";
import { countApi, joinId, localRepo, rootRunIdOf } from "../pipeline/scope.ts";
import type {
  CacheConfig,
  CacheKey,
  CacheKeyPart,
  CacheKeyValue,
  FilesOptions,
  JobConfig,
  RepoContext,
} from "../types.ts";
import {
  durationToMs,
  filterPaths,
  formatRelative,
  hash,
  isSnapshotNotFound,
  parseRepo,
  stableStringify,
} from "../util.ts";
import { formatName } from "./names.ts";

/**
 * Check a static `cache` when the job is defined, so a mistake fails
 * when the app boots rather than mid-pipeline.
 *
 * @throws {CiUsageError} When the key is empty.
 */
export const checkCache = (id: string, cache?: CacheConfig): void => {
  if (cache?.key === "" || (cache?.key && !keyParts(cache.key).length)) {
    throw new CiUsageError(`The \`cache.key\` of "${id}" can't be empty.`);
  }
};

/** Where a run's snapshots go. */
export type CacheLane = "shared" | "pr" | "local" | "run";

/**
 * Where a run's snapshots go: `shared` is the cache every run reads, named
 * only by job and key, which only the default branch writes; `pr` is a pull
 * request's own, shared by every run of that pull request, for a key the default
 * branch doesn't have; `local` is what a local run writes; `run` is a snapshot
 * only this pipeline run has, deleted when it ends, as for a push to any other
 * branch.
 *
 * A snapshot is whatever its build left on the machine, and the run that reads
 * it trusts it. A pull request runs code the default branch hasn't taken, so it
 * reads the shared cache and never writes it (see `defaultBranchRepo`).
 *
 * A local run, from `inngest-ci`, writes only to `local`, whatever its event
 * says: its fixtures look like real pull requests and pushes, and a working
 * tree must never stand in for one. It still reads what CI built.
 */
export const cacheLane = (repo: RepoContext | undefined): CacheLane => {
  if (repo?.local) {
    return "local";
  }

  if (repo?.pullRequest) {
    return "pr";
  }

  const branch = repo?.ref?.replace(/^refs\/heads\//, "");

  return repo?.defaultBranch && branch && branch !== repo.defaultBranch
    ? "run"
    : "shared";
};

/**
 * The pull request's repository as the default branch has it: the commit the
 * pull request is based on, with none of the pull request in it. A build run
 * given this checks out that commit and writes the shared cache, so what is
 * cached was built from the default branch's code.
 */
export const defaultBranchRepo = (
  repo: RepoContext,
): RepoContext | undefined => {
  // A pull request into another branch has no default branch's cache to use.
  if (
    !repo.pullRequest ||
    !repo.baseSha ||
    !repo.baseRef ||
    (repo.defaultBranch && repo.defaultBranch !== repo.baseRef)
  ) {
    return undefined;
  }

  const { pullRequest: _pullRequest, mergeSha: _mergeSha, ...rest } = repo;

  return { ...rest, sha: repo.baseSha, ref: `refs/heads/${repo.baseRef}` };
};

const unresolvedAtDefaultBranch = "\0unresolved";

/**
 * Resolve the parts of a cache key: a single hash of all of them, and the
 * named ones as strings, for the job's handler.
 *
 * `files()` parts are resolved against the repository: the git tree for the
 * run's commit on GitHub (or for the commit its `repo` and `ref` resolved to),
 * or the working tree locally, so a key changes exactly when the matched files
 * do. A function part is called once, here, and its value is what the hash and
 * the handler both get.
 */
export const resolveCacheKey = async (
  run: CiRunScope,
  key: CacheKey | undefined,
  /** Also resolve the `files()` parts as this repository has them. */
  at?: RepoContext,
): Promise<{
  hash: string;
  named: Record<string, string>;
  hashAt?: string;
}> => {
  const resolved: string[] = [];
  const resolvedAt: string[] = [];
  const named: Record<string, string> = {};

  for (const [name, part] of keyParts(key)) {
    let value: string;
    let valueAt: string | undefined;

    if (typeof part === "function") {
      value = await part();
    } else if (typeof part === "string") {
      value = part;
    } else {
      value = await resolveFilesPart(run, part);

      // A key that can't be worked out there is not the same as this one.
      valueAt = at
        ? await resolveFilesPart({ ...run, repo: at }, part).catch(() => {
            return unresolvedAtDefaultBranch;
          })
        : undefined;
    }

    if (name === undefined) {
      resolved.push(value);
      resolvedAt.push(valueAt ?? value);
    } else {
      resolved.push(`${name}=${value}`);
      resolvedAt.push(`${name}=${valueAt ?? value}`);
      named[name] = value;
    }
  }

  return {
    hash: hash(resolved.join("\0")),
    named,
    ...(at ? { hashAt: hash(resolvedAt.join("\0")) } : {}),
  };
};

const isFilesPart = (value: object): value is CacheKeyPart => {
  return (value as CacheKeyPart).kind === "inngest/ci.cacheKeyPart";
};

/** The parts of a cache key, each with its name if the key is an object of them. */
const keyParts = (
  key: CacheKey | undefined,
): [name: string | undefined, part: CacheKeyValue][] => {
  if (key === undefined) {
    return [];
  }

  if (Array.isArray(key)) {
    return key.map((part) => {
      return [undefined, part];
    });
  }

  if (typeof key !== "object" || isFilesPart(key)) {
    return [[undefined, key as CacheKeyValue]];
  }

  return Object.entries(key);
};

/**
 * Resolve the repository and ref of every `files()` part that reads another
 * commit than the run's own, each in a memoized step. A key is worked out
 * inside a step, which can't start another, so this runs just before it.
 */
export const resolveKeySources = async (
  run: CiRunScope,
  key: CacheKey | undefined,
): Promise<void> => {
  for (const [, part] of keyParts(key)) {
    if (typeof part === "object" && !targetsRunRepo(run, part)) {
      await resolveSource(run, part);
    }
  }
};

const resolveFilesPart = async (
  run: CiRunScope,
  part: CacheKeyPart,
): Promise<string> => {
  if (!targetsRunRepo(run, part)) {
    return hashRemoteFiles(run, await resolveSource(run, part), part);
  }

  const local = localRepo(run);

  if (local) {
    const { hashLocalFiles } = await import("./localCache.ts");

    return hashLocalFiles(local.path, part.patterns);
  }

  const repo = run.repo;

  if (!repo) {
    return `files:${part.patterns.join(",")}`;
  }

  const tree = await rest.git.getTree({
    tree_sha: repo.mergeSha ?? repo.sha,
    recursive: "1",
  });

  return hashTree(tree, part.patterns, repo.fullName);
};

/**
 * Hash the matched files of another repository or ref, at the commit it
 * resolved to, with a client for the installation that can read it.
 */
const hashRemoteFiles = async (
  run: CiRunScope,
  source: ResolvedSource,
  part: CacheKeyPart,
): Promise<string> => {
  const octokit = await octokitForSource(run, source);

  try {
    const { data } = await octokit.rest.git.getTree({
      owner: source.owner,
      repo: source.name,
      tree_sha: source.sha,
      recursive: "1",
    });

    return hashTree(data, part.patterns, source.fullName);
  } catch (error) {
    throw mapGitHubError(error) ?? error;
  }
};

/** A hash of the blobs in a git tree that match the patterns. */
const hashTree = (
  listing: {
    tree?: { type?: string; path?: string; sha?: string }[];
    truncated?: boolean;
  },
  patterns: string[],
  fullName: string,
): string => {
  // A truncated listing would hash only some of the files, and a key that
  // ignores the rest never changes when they do.
  if (listing.truncated) {
    throw new NonRetriableError(
      `\`${fullName}\` is too large to hash \`files()\` from GitHub's tree API, which cut the file listing short. Key the job on a string instead.`,
    );
  }

  const entries = (listing.tree ?? [])
    .filter((entry) => {
      return entry.type === "blob" && entry.path;
    })
    .map((entry) => {
      return { path: entry.path as string, sha: entry.sha ?? "" };
    });

  const matched = filterPaths(
    entries.map((entry) => {
      return entry.path;
    }),
    { include: patterns },
  );

  const byPath = new Map(
    entries.map((entry) => {
      return [entry.path, entry.sha];
    }),
  );

  return hash(
    matched
      .sort()
      .map((path) => {
        return `${path}:${byPath.get(path) ?? ""}`;
      })
      .join("\n"),
  );
};

/**
 * A job's own cache key: its resolved key, with the repository, the input it
 * was called with and the snapshot it starts from folded in, since any of
 * them changing makes it a different job. The key's named parts come back
 * beside it. The app's ID is always part of it,
 * so two apps in one repository never share a snapshot, and the repository
 * is too when the run has one (a cron with no `repo` set has none). Names and
 * lookups both go through this, so they always agree.
 */
export const jobCacheKey = async (
  run: CiRunScope,
  cache: CacheConfig,
  input: unknown,
  /** What the job starts from. */
  base?: BaseIdentity,
  /** Also work out the key at the default branch, for a pull request. */
  atDefaultBranch = false,
): Promise<{
  ownKey: string;
  key: Record<string, string>;
  defaultBranchKey?: string;
}> => {
  const defaultBranch =
    atDefaultBranch && run.repo ? defaultBranchRepo(run.repo) : undefined;

  const {
    hash: resolved,
    named,
    hashAt,
  } = await resolveCacheKey(run, cache.key, defaultBranch);

  // Repositories and apps can share a Sandbox environment, so the same
  // job and key in two of them are still two names.
  const app = `app:${run.ci.client?.id ?? ""}`;
  const owner = run.repo ? `repo:${run.repo.fullName}\0${app}` : app;

  // Ahead of the key, so the entries of one app, repository and input share a
  // name up to it, and a new key can replace the old one among them.
  const slot = hash(
    `${owner}\0${input === undefined ? "" : stableStringify(input)}`,
    8,
  );

  return {
    ownKey: `${slot}/${identityKey(hash(`${resolved}\0${owner}`), input, base)}`,
    key: named,
    ...(hashAt
      ? {
          defaultBranchKey: `${slot}/${identityKey(hash(`${hashAt}\0${owner}`), input, base)}`,
        }
      : {}),
  };
};

/**
 * Fold a job's input and the snapshot it starts from into a key. A key with
 * neither stays as it is.
 */
const identityKey = (
  key: string,
  input: unknown,
  base: BaseIdentity | undefined,
): string => {
  const parts = [key];

  if (input !== undefined) {
    parts.push(`input:${stableStringify(input)}`);
  }

  if (base) {
    parts.push(`from:${base.from}@${base.snapshotId ?? ""}`);
  }

  return parts.length === 1 ? key : hash(parts.join("\0"));
};

/**
 * The base a job starts from, as its key sees it: what it is and its snapshot,
 * which is missing when there was none to take. A base rebuilt with any
 * change has a new snapshot, so every job below it gets a new name and misses
 * on lookup, without a machine starting to find out.
 */
export interface BaseIdentity {
  /** The parent's job ID, or `image:<name>` for an image. */
  from: string;
  snapshotId?: string;
}

/** A cached job's snapshot, as found by its name. */
export interface CachedSnapshot {
  snapshotId: string;
  /** The name it has: the shared cache's, or a local run's or this run's own. */
  name: string;
  /** When it was taken, as an ISO timestamp. */
  createdAt: string;
}

/** Where a job's cached snapshot is written. */
export interface CacheTarget {
  /**
   * Set for a pull request whose key is the default branch's, so its snapshot
   * is the shared one. A miss is built from the default branch's commit.
   */
  asDefaultBranch?: true;
  /** The job's resolved key. */
  ownKey: string;
  /** The named parts of the job's `cache.key`, resolved: what its handler gets as `key`. */
  key: Record<string, string>;
  /** The name a build gives the snapshot, where the run writes. */
  name: string;
}

/**
 * Compute a job's key and the name its snapshot is written under, as a
 * memoized step. What a pipeline needs to ask a build function for it.
 */
export const cacheTarget = async (
  run: CiRunScope,
  job: {
    /** The job's ID, which its snapshot's name has. */
    id: string;
    /** Where the job's steps go: its own path, or the one its build is asked under. */
    path: string;
  },
  cache: CacheConfig,
  /** The input the job was called with, which is part of its identity. */
  input?: unknown,
  /** What the job starts from, which is part of its identity too. */
  base?: BaseIdentity,
): Promise<CacheTarget> => {
  const jobId = job.id;

  countApi("cache");

  await resolveKeySources(run, cache.key);

  const lane = cacheLane(run.repo);

  const { ownKey, key, defaultBranchKey } = await ciRun(
    run,
    steps.cacheKey(job.path),
    () => {
      return jobCacheKey(run, cache, input, base, lane === "pr");
    },
  );

  if (lane === "run") {
    return {
      ownKey,
      key,
      name: formatName({
        kind: "run",
        rootRunId: rootRunIdOf(run),
        jobId,
        ownKey,
      }),
    };
  }

  if (lane === "pr" && defaultBranchKey !== ownKey) {
    return {
      ownKey,
      key,
      name: formatName({
        kind: "cache",
        jobId,
        ownKey,
        pullRequest: {
          repo: run.repo?.fullName ?? "",
          number: run.repo?.pullRequest?.number ?? 0,
        },
      }),
    };
  }

  return {
    ownKey,
    key,
    name: formatName({ kind: "cache", jobId, ownKey, local: lane === "local" }),
    ...(lane === "pr" ? { asDefaultBranch: true as const } : {}),
  };
};

/**
 * A target as the pull request's own, for a job that builds in the pull
 * request's run and so can't write the shared cache, though its key is the
 * default branch's.
 */
export const pullRequestTarget = (
  run: CiRunScope,
  jobId: string,
  target: CacheTarget,
): CacheTarget => {
  const { repo } = run;

  if (!target.asDefaultBranch || !repo?.pullRequest) {
    return target;
  }

  const { asDefaultBranch: _asDefaultBranch, ...rest } = target;

  return {
    ...rest,
    name: formatName({
      kind: "cache",
      jobId,
      ownKey: target.ownKey,
      pullRequest: { repo: repo.fullName, number: repo.pullRequest.number },
    }),
  };
};

/**
 * Where a job without a `cache` has its snapshot for `from`: a name that
 * belongs to the pipeline run at the root, so another run never starts from
 * it, and that a second build anywhere in that pipeline finds rather than
 * builds again.
 */
export const runTarget = (
  run: CiRunScope,
  jobId: string,
  input?: unknown,
  /** What the job starts from. */
  base?: BaseIdentity,
) => {
  const ownKey = identityKey("", input, base);

  return {
    ownKey,
    key: {},
    name: formatName({
      kind: "run",
      rootRunId: rootRunIdOf(run),
      jobId,
      ownKey,
    }),
  };
};

/**
 * The target of a job the pipeline calls itself, which nothing starts from.
 * It takes no snapshot, so the name only keeps one call's steps from queueing
 * behind another's in the build function's per-name concurrency.
 */
export const directTarget = (run: CiRunScope, path: string): CacheTarget => {
  return {
    ownKey: "",
    key: {},
    name: formatName({
      kind: "run",
      rootRunId: rootRunIdOf(run),
      jobId: path,
      ownKey: "direct",
    }),
  };
};

/**
 * How long before its `expiresAt` a snapshot stops being reused: long enough
 * for the jobs that start from it to get their machines.
 */
const expiryMarginMs = 15 * 60 * 1000;

/** Whether a snapshot expires within the margin, or already has. */
const isExpiring = (expiresAt: string | undefined): boolean => {
  if (!expiresAt) {
    return false;
  }

  const at = Date.parse(expiresAt);

  return Number.isFinite(at) && at - Date.now() < expiryMarginMs;
};

/** The parts of a snapshot that decide whether a job may use it. */
export interface SnapshotInfo {
  id: string;
  status: string;
  createdAt: string;
  expiresAt?: string;
}

/** Whether a job may use a snapshot. */
export type Usable = (snapshot: SnapshotInfo) => boolean;

/**
 * What makes a snapshot usable: ready, not the one to avoid, not about to
 * expire, and not older than the job's `cache.maxAge`. A new freshness rule is
 * one more clause here. `defineJob` has already checked that `maxAge` parses.
 */
export const usableFor = (
  cache: CacheConfig | undefined,
  /** A snapshot that must not be used, though it may still hold the name. */
  exclude?: string,
): Usable => {
  const maxAgeMs =
    cache?.maxAge === undefined
      ? undefined
      : durationToMs(cache.maxAge, "cache.maxAge");

  return (snapshot) => {
    const createdAt = Date.parse(snapshot.createdAt);
    const tooOld =
      maxAgeMs !== undefined &&
      Number.isFinite(createdAt) &&
      Date.now() - createdAt > maxAgeMs;

    return (
      snapshot.status === "READY" &&
      snapshot.id !== exclude &&
      !isExpiring(snapshot.expiresAt) &&
      !tooOld
    );
  };
};

/** How long a lookup waits for a snapshot another build is still taking. */
const readyWaitMs = 2 * 60 * 1000;
const readyPollMs = 1000;

interface SnapshotResource {
  id: string;
  name?: string;
  status: string;
  createdAt: string;
  expiresAt?: string;
}

/** The direct snapshots client, for CI's own steps. */
// biome-ignore lint/suspicious/noExplicitAny: SandboxClient["snapshots"], kept loose
const snapshotsClient = (run: CiRunScope): any => {
  return run.ci.client.sandboxes.snapshots;
};

/**
 * Wait for a snapshot that is still being created, for a while. `undefined`
 * if it never became ready.
 */
const waitUntilReady = async (
  run: CiRunScope,
  snapshotId: string,
): Promise<SnapshotResource | undefined> => {
  const deadline = Date.now() + readyWaitMs;

  while (true) {
    const snapshot = (await snapshotsClient(run).get(snapshotId)) as
      | SnapshotResource
      | null
      | undefined;

    if (!snapshot || snapshot.status !== "CREATING") {
      return snapshot ?? undefined;
    }

    if (Date.now() >= deadline) {
      return undefined;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, readyPollMs);
    });
  }
};

/**
 * The newest snapshot with exactly this name, if it can be used: ready, or
 * ready after waiting for the build taking it, not about to expire, and not
 * older than the job's max age.
 *
 * Any error is a miss, and only an exact name counts, since a server that
 * doesn't know names ignores the filter and lists every snapshot.
 */
const findNamed = async (
  run: CiRunScope,
  name: string,
  usable: Usable,
): Promise<CachedSnapshot | undefined> => {
  try {
    const page = (await snapshotsClient(run).list({ name, limit: 10 })) as {
      items: SnapshotResource[];
    };

    const newest = page.items.find((snapshot) => {
      return snapshot.name === name;
    });

    // Waiting is only worth it for a snapshot that would be usable once ready.
    if (!newest || !usable({ ...newest, status: "READY" })) {
      return undefined;
    }

    const ready =
      newest.status === "CREATING"
        ? await waitUntilReady(run, newest.id)
        : newest;

    if (!ready || !usable(ready)) {
      return undefined;
    }

    return { snapshotId: ready.id, name, createdAt: ready.createdAt };
  } catch {
    return undefined;
  }
};

/**
 * Look a cached job's snapshot up where it may be: what a local run wrote,
 * then the shared cache, then where this run writes, such as its pull request's
 * own cache.
 */
const findInNames = async (
  run: CiRunScope,
  jobId: string,
  cache: CacheConfig,
  target: CacheTarget,
  exclude?: string,
): Promise<CachedSnapshot | undefined> => {
  const usable = usableFor(cache, exclude);

  const lane = cacheLane(run.repo);

  const names = new Set([
    ...(lane === "local"
      ? [
          formatName({
            kind: "cache",
            jobId,
            ownKey: target.ownKey,
            local: true,
          }),
        ]
      : []),
    formatName({ kind: "cache", jobId, ownKey: target.ownKey }),
    target.name,
  ]);

  for (const name of names) {
    const found = await findNamed(run, name, usable);

    if (found) {
      return found;
    }
  }

  return undefined;
};

/**
 * Look a job's cached snapshot up, as a memoized step. Its parents need no
 * check: they are part of its name.
 */
export const lookupCache = async (
  scope: CiJobScope,
  /** The job's `cache`, or none for a job whose snapshot is only for this run. */
  cache: CacheConfig | undefined,
  target: CacheTarget,
  /** A snapshot found to be bad, which a rebuild must not find again. */
  exclude?: string,
): Promise<CachedSnapshot | undefined> => {
  return lookUp(
    scope.run,
    steps.lookUpCache(joinId(scope.path, "cache:lookup"), scope.path),
    scope.config.id,
    cache,
    target,
    exclude,
  );
};

/** A lookup as a memoized step: a hit is returned, a miss is `null` in the step. */
const lookUp = async (
  run: CiRunScope,
  spec: StepSpec,
  jobId: string,
  cache: CacheConfig | undefined,
  target: CacheTarget,
  exclude?: string,
): Promise<CachedSnapshot | undefined> => {
  const found = await ciRun(run, spec, async () => {
    return (await findCached(run, jobId, cache, target, exclude)) ?? null;
  });

  return found ?? undefined;
};

/** A job's usable snapshot: in the names it reads if cached, else by its run's name. */
const findCached = (
  run: CiRunScope,
  jobId: string,
  cache: CacheConfig | undefined,
  target: CacheTarget,
  exclude?: string,
): Promise<CachedSnapshot | undefined> => {
  return cache
    ? findInNames(run, jobId, cache, target, exclude)
    : findNamed(run, target.name, usableFor(undefined, exclude));
};

/**
 * Look a snapshot up before asking a build function for it, as a memoized step
 * in the run that needs it. A hit saves the invoke and its place in the queue
 * behind any build still taking the name. A miss, or a snapshot that is about
 * to expire or is the bad one, is for the build function to settle, which
 * looks again when it starts.
 */
export const lookupBeforeBuild = async (
  run: CiRunScope,
  job: {
    id: string;
    /** The job's path, where its activity goes. */
    path: string;
    /** What the step's ID is built on. */
    stepPath: string;
  },
  cache: CacheConfig | undefined,
  target: CacheTarget,
  /** A snapshot found to be bad, which a rebuild must not find again. */
  exclude?: string,
): Promise<CachedSnapshot | undefined> => {
  return lookUp(
    run,
    steps.lookUpCache(joinId(job.stepPath, "lookup"), job.path),
    job.id,
    cache,
    target,
    exclude,
  );
};

/**
 * Find the snapshot that holds a name a build couldn't take, as a memoized
 * step. If it can't be used, because it is about to expire, is older than the
 * job's max age or is the bad one the build replaces, it is deleted so the
 * build can take the name after all.
 */
export const resolveTakenName = async (
  run: CiRunScope,
  stepId: string,
  name: string,
  /** The job's `cache`, whose `maxAge` a holder may be past. */
  cache?: CacheConfig,
  exclude?: string,
  /**
   * Whether `exclude` was decided to be broken, which is the only case where
   * it is deleted. A snapshot that merely failed to start once may be a
   * shared one, in the cache every run reads, that other runs still use.
   */
  broken?: boolean,
): Promise<{ winner?: CachedSnapshot; cleared: boolean }> => {
  return ciRun(
    run,
    steps.resolveCacheName(stepId),
    async (): Promise<{ winner?: CachedSnapshot; cleared: boolean }> => {
      const winner = await findNamed(run, name, usableFor(cache, exclude));

      if (winner) {
        return { winner, cleared: false };
      }

      let cleared = false;

      try {
        const page = (await snapshotsClient(run).list({ name, limit: 10 })) as {
          items: SnapshotResource[];
        };

        const usable = usableFor(cache);

        for (const holder of page.items) {
          const unusable = (broken && holder.id === exclude) || !usable(holder);

          if (holder.name !== name || holder.status !== "READY" || !unusable) {
            continue;
          }

          const snapshot = await snapshotsClient(run).get(holder.id);

          await snapshot?.delete();

          cleared = true;
        }
      } catch {
        // Nothing more to try: the build keeps its snapshot without a name.
      }

      return { cleared };
    },
  );
};

/**
 * Delete the snapshots that hold a name the build has just taken, as a
 * memoized step. A name is held only by an unexpired snapshot, so an expired
 * one doesn't stop the build taking the name, and nothing else would remove it:
 * the platform keeps it, and counts it, until it is deleted. They are found by
 * the exact name and deleted by ID, and never the one just taken.
 *
 * Best effort: a snapshot that can't be deleted is left, as it was.
 */
export const deleteExpiredHolders = async (
  run: CiRunScope,
  stepId: string,
  name: string,
  /** The snapshot the build took, which stays. */
  keep: string,
): Promise<void> => {
  await ciRun(run, steps.deleteExpiredSnapshots(stepId), async () => {
    try {
      const page = (await snapshotsClient(run).list({ name, limit: 10 })) as {
        items: SnapshotResource[];
      };

      for (const holder of page.items) {
        const expired =
          holder.expiresAt !== undefined &&
          Date.parse(holder.expiresAt) <= Date.now();

        if (
          holder.name === name &&
          holder.id !== keep &&
          holder.status === "READY" &&
          expired
        ) {
          await (await snapshotsClient(run).get(holder.id))?.delete();
        }
      }
    } catch {
      // Left to the platform, which keeps it until it is deleted.
    }

    return null;
  });
};

/**
 * What a snapshot is now, as a memoized step: `gone` if it doesn't exist or
 * is being deleted, `creating` while it is being taken, and `ready` otherwise.
 * `ready` is also what an unreadable answer gives, since that is the case
 * where the snapshot has to be assumed usable.
 */
export const snapshotState = async (
  run: CiRunScope,
  stepId: string,
  snapshotId: string,
): Promise<"gone" | "creating" | "ready"> => {
  return ciRun(
    run,
    steps.checkSnapshotState(stepId),
    async (): Promise<"gone" | "creating" | "ready"> => {
      try {
        const snapshot = (await snapshotsClient(run).get(snapshotId)) as
          | SnapshotResource
          | null
          | undefined;

        if (!snapshot || /^DELET/.test(snapshot.status)) {
          return "gone";
        }

        return snapshot.status === "CREATING" ? "creating" : "ready";
      } catch {
        return "ready";
      }
    },
  );
};

/**
 * Delete a snapshot that is no use, so no run finds it again. Whether it is
 * gone afterwards: `false` when it can't be deleted (as Cloud refuses some),
 * which leaves it to expire and must not be reused.
 */
export const deleteSnapshot = async (
  run: CiRunScope,
  stepId: string,
  snapshotId: string,
): Promise<boolean> => {
  try {
    const result = await ciRun(
      run,
      steps.deleteBadSnapshot(stepId),
      async () => {
        try {
          const snapshot = await snapshotsClient(run).get(snapshotId);

          await snapshot?.delete();

          return { deleted: Boolean(snapshot), gone: true };
        } catch (error) {
          // Deleted meanwhile by someone else, which is as good.
          return { deleted: false, gone: isSnapshotNotFound(error) };
        }
      },
    );

    // Outside the step, which a replay doesn't run: the set is rebuilt on
    // every replay, so a snapshot gone now must leave it on each of them.
    if (result.gone) {
      run.createdSnapshots.delete(snapshotId);
    }

    return result.gone;
  } catch {
    // Best effort only.
    return false;
  }
};

/**
 * What a cached job that starts from a job with no `cache` says in the run's
 * warnings. A job without a cache is built fresh in every run, and the cached
 * job's key holds that build's snapshot, so the cached job could never be
 * found again. It is built in every run, and its snapshot belongs to the run,
 * until the job above it has a `cache`.
 */
export const uncachedBaseNote = (
  /** The cached job. */
  jobId: string,
  /** The job it starts from, which has no cache. */
  baseId: string,
): { line: string } => {
  return {
    line: `never reused: \`${jobId}\` starts from \`${baseId}\`, which has no \`cache\` (give \`${baseId}\` a \`cache\`)`,
  };
};

/** Add a cached job's uncached-base line to the run's warnings, once. */
export const warnUncachedBase = (
  run: CiRunScope,
  jobId: string,
  baseId: string,
): void => {
  const { line } = uncachedBaseNote(jobId, baseId);

  if (!run.warnings.includes(line)) {
    run.warnings.push(line);
  }
};

/**
 * How a cached snapshot is described wherever it shows: `cached 10h ago`.
 */
export const describeCached = (
  /** When the snapshot was taken, as an ISO timestamp. */
  createdAt: string,
): string => {
  return `cached ${formatRelative(createdAt)}`;
};

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * A cache key part built from repository files. The key changes when any
 * matched file's contents change, so a job is reused until its inputs move.
 *
 * ```ts
 * cache: { key: files("pnpm-lock.yaml", ".nvmrc") }
 * cache: { key: files("migrations/**", "seeds/**") }
 * cache: { key: [files("go.mod", "go.sum"), "go1.25"] }
 * ```
 *
 * Contents are read from the git tree for the run's commit, or from the
 * working tree locally, so uncommitted changes change the key too.
 *
 * End with `{ repo, ref }` to read another repository or ref. `ref` is a
 * branch, tag or commit, and `repo` is `"owner/name"` with `ref` defaulting to
 * its default branch. The ref is resolved to a commit once per run, so a branch
 * that moves changes the key exactly when the matched files change. Locally,
 * this reads from GitHub too, unless it names the local repository with no
 * `ref`.
 *
 * ```ts
 * cache: {
 *   key: files("images/node-base/**", { repo: "acme/platform", ref: "main" }),
 * }
 * ```
 *
 * Patterns support `**`, `*`, `?`, and `{a,b}`.
 */
export const files = (
  /** Glob patterns for the files to hash, then optionally where to read them from. */
  ...args: string[] | [...patterns: string[], options: FilesOptions]
): CacheKeyPart => {
  const list: (string | FilesOptions)[] = args;
  const last = list.at(-1);
  const options = typeof last === "object" ? last : undefined;

  // Checked here, where the pipeline is defined, so a bad `repo` fails at boot.
  if (options?.repo !== undefined) {
    parseRepo(options.repo);
  }

  const patterns = list.filter((arg): arg is string => {
    return typeof arg === "string";
  });

  return {
    kind: "inngest/ci.cacheKeyPart",
    type: "files",
    patterns,
    ...(options?.repo === undefined ? {} : { repo: options.repo }),
    ...(options?.ref === undefined ? {} : { ref: options.ref }),
  };
};
