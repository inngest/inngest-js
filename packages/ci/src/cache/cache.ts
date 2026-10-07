/**
 * The machinery behind a job's `cache` option: keys, the names cached
 * snapshots are found by, looking them up, checking what they were built from,
 * and the `files()` key helper.
 *
 * A cached job is the snapshot of its machine, named after the job's key. There
 * is no other record of it: whatever a run needs to know about a snapshot is
 * either in its name or in the metadata file inside it.
 *
 * @module
 */

import type { SnapshotMeta } from "../machine/snapshotMeta.ts";
import { tagStep } from "../pipeline/metadata.ts";
import { ciStep, traceName } from "../pipeline/names.ts";
import type { CiJobScope, CiRunScope } from "../pipeline/scope.ts";
import { countApi, scopeSeparator } from "../pipeline/scope.ts";
import type {
  CacheConfig,
  CacheKey,
  CacheKeyPart,
  RepoContext,
} from "../types.ts";
import { boundedName, formatRelative, hash, stableStringify } from "../util.ts";

/**
 * Where a job reads and writes its cached snapshots.
 *
 * With the default `"branch"` scope, a pull request reads snapshots built on
 * the branch it targets and writes its own, so one PR can't poison another. A
 * pull request's scope has a `:`, which a branch name can't contain, so a
 * branch called `pr-4` never shares it.
 *
 * A local run, from `inngest-ci`, writes only to `local`, whatever its event
 * says: its fixtures look like real pull requests and pushes, and a working
 * tree must never stand in for one. It still reads what CI built.
 */
export const cacheScopes = (
  repo: RepoContext | undefined,
  scope: CacheConfig["scope"],
): { read: string[]; write: string } => {
  const shared = sharedScopes(repo, scope);

  if (!repo?.local) {
    return shared;
  }

  const read = shared.read.filter((name) => {
    return !name.startsWith("pr:");
  });

  return { read: [localScope, ...read], write: localScope };
};

/** The scope every local run writes to. */
const localScope = "local";

const sharedScopes = (
  repo: RepoContext | undefined,
  scope: CacheConfig["scope"],
): { read: string[]; write: string } => {
  if (scope === "global" || !repo) {
    return { read: ["global"], write: "global" };
  }

  const base = repo.baseRef ?? "default";

  if (repo.pullRequest) {
    const own = `pr:${repo.pullRequest.number}`;

    return { read: [own, base], write: own };
  }

  const branch = repo.ref?.replace(/^refs\/heads\//, "") ?? base;

  return { read: [branch], write: branch };
};

/**
 * The name a job's cached snapshot has in a scope: `ci/<scope>/<job>/<key>`.
 * A name too long for a snapshot keeps its start and gains a hash of the
 * whole, so it stays unique.
 */
export const snapshotName = (
  scope: string,
  jobId: string,
  ownKey: string,
): string => {
  return boundedName(`ci/${scope}/${jobId}/${ownKey}`);
};

/**
 * Resolve the parts of a cache key into a single hash.
 *
 * `files()` parts are resolved against the repository: the git tree for the
 * run's commit on GitHub, or the working tree locally, so a key changes
 * exactly when the matched files do.
 */
export const resolveCacheKey = async (
  run: CiRunScope,
  key: CacheKey | undefined,
): Promise<string> => {
  if (key === undefined) {
    return "";
  }

  if (typeof key === "function") {
    return hash(await key());
  }

  const parts = Array.isArray(key) ? key : [key];
  const resolved: string[] = [];

  for (const part of parts) {
    if (typeof part === "string") {
      resolved.push(part);

      continue;
    }

    resolved.push(await resolveFilesPart(run, part));
  }

  return hash(resolved.join("\0"));
};

const resolveFilesPart = async (
  run: CiRunScope,
  part: CacheKeyPart,
): Promise<string> => {
  const repo = run.repo;

  if (repo?.local && process.env.INNGEST_CI_GITHUB !== "live") {
    const { hashLocalFiles } = await import("./localCache.ts");

    return hashLocalFiles(repo.local.path, part.patterns);
  }

  if (!repo) {
    return `files:${part.patterns.join(",")}`;
  }

  const { rest } = await import("../github/rest.ts");
  const { filterPaths } = await import("../util.ts");

  const tree = await rest.git.getTree({
    tree_sha: repo.sha,
    recursive: "1",
  });

  const entries = (tree.tree ?? [])
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
    { include: part.patterns },
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
 * A job's own cache key: its resolved key, with the input it was called with
 * folded in, since the same key with a different input is a different job.
 * Names, lookups and parent checks all go through this, so they always agree.
 */
export const jobCacheKey = async (
  run: CiRunScope,
  cache: CacheConfig,
  input: unknown,
): Promise<string> => {
  const key = await resolveCacheKey(run, cache.key);

  return input === undefined
    ? key
    : hash(`${key}\0input:${stableStringify(input)}`);
};

/** A cached job's snapshot, as found by its name. */
export interface CachedSnapshot {
  snapshotId: string;
  /** The name it has, which may be another scope's, such as the base branch's. */
  name: string;
  /** When it was taken, as an ISO timestamp. */
  createdAt: string;
}

/** Where a job's cached snapshot is written. */
export interface CacheTarget {
  /** The job's resolved key. */
  ownKey: string;
  /** The name a build gives the snapshot, in the scope the job writes. */
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
    /** Where the job's steps go: its own path, or the one `from()` asks under. */
    path: string;
  },
  cache: CacheConfig,
  /** The input the job was called with, which is part of its identity. */
  input?: unknown,
): Promise<CacheTarget> => {
  const jobId = job.id;

  countApi("cache");

  // A build run was handed the name the run that invoked it concurrency-limits
  // on, so the two can't drift apart.
  const given = run.build?.jobId === jobId ? run.build : undefined;

  const ownKey =
    given?.ownKey ??
    ((await run.step.run(
      ciStep(`${job.path}${scopeSeparator}cache:key`, traceName.checkCache),
      async () => {
        await tagStep(run, { kind: "cache", job: job.path });

        return jobCacheKey(run, cache, input);
      },
    )) as string);

  return {
    ownKey,
    name:
      given?.cacheKey ??
      snapshotName(cacheScopes(run.repo, cache.scope).write, jobId, ownKey),
  };
};

/**
 * Where a job without a `cache` has its snapshot for `from()`: a name that
 * belongs to this pipeline run, so another run never starts from it, and that
 * a second build in this run finds rather than builds again.
 */
export const runTarget = (run: CiRunScope, jobId: string, input?: unknown) => {
  const ownKey = input === undefined ? "" : hash(stableStringify(input));

  return { ownKey, name: snapshotName(`run:${run.runId}`, jobId, ownKey) };
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
 * ready after waiting for the build taking it, and not about to expire.
 *
 * Any error is a miss, and only an exact name counts, since a server that
 * doesn't know names ignores the filter and lists every snapshot.
 */
const findNamed = async (
  run: CiRunScope,
  name: string,
  /** A snapshot that must not be used, though it may still hold the name. */
  exclude?: string,
): Promise<CachedSnapshot | undefined> => {
  try {
    const page = (await snapshotsClient(run).list({ name, limit: 10 })) as {
      items: SnapshotResource[];
    };

    const newest = page.items.find((snapshot) => {
      return snapshot.name === name;
    });

    if (!newest || newest.id === exclude) {
      return undefined;
    }

    const ready =
      newest.status === "CREATING"
        ? await waitUntilReady(run, newest.id)
        : newest;

    if (ready?.status !== "READY" || isExpiring(ready.expiresAt)) {
      return undefined;
    }

    return { snapshotId: ready.id, name, createdAt: ready.createdAt };
  } catch {
    return undefined;
  }
};

/** Look a job's snapshot up in each scope it reads, in order. */
const findInScopes = async (
  run: CiRunScope,
  jobId: string,
  cache: CacheConfig,
  ownKey: string,
  exclude?: string,
): Promise<CachedSnapshot | undefined> => {
  for (const scope of cacheScopes(run.repo, cache.scope).read) {
    const found = await findNamed(
      run,
      snapshotName(scope, jobId, ownKey),
      exclude,
    );

    if (found) {
      return found;
    }
  }

  return undefined;
};

/**
 * Look a job's cached snapshot up, as a memoized step. Its parents aren't
 * checked here: that needs the metadata inside it, which is read when a
 * machine starts from it.
 */
export const lookupCache = async (
  scope: CiJobScope,
  /** The job's `cache`, or none for a job whose snapshot is only for this run. */
  cache: CacheConfig | undefined,
  target: CacheTarget,
  /** A snapshot found to be bad, which a rebuild must not find again. */
  exclude?: string,
): Promise<CachedSnapshot | undefined> => {
  const { run } = scope;

  const found = (await run.step.run(
    ciStep(`${scope.path}${scopeSeparator}cache:lookup`, traceName.lookUpCache),
    async () => {
      await tagStep(run, { kind: "cache", job: scope.path });

      const hit = cache
        ? await findInScopes(
            run,
            scope.config.id,
            cache,
            target.ownKey,
            exclude,
          )
        : await findNamed(run, target.name, exclude);

      return hit ?? null;
    },
  )) as CachedSnapshot | null;

  return found ?? undefined;
};

/**
 * Find the snapshot that holds a name a build couldn't take, as a memoized
 * step. If it can't be used, because it is about to expire or is the bad one
 * the build replaces, it is deleted so the build can take the name after all.
 */
export const resolveTakenName = async (
  run: CiRunScope,
  stepId: string,
  name: string,
  exclude?: string,
): Promise<{ winner?: CachedSnapshot; cleared: boolean }> => {
  return (await run.step.run(
    ciStep(stepId, traceName.resolveCacheName),
    async () => {
      const winner = await findNamed(run, name, exclude);

      if (winner) {
        return { winner, cleared: false };
      }

      let cleared = false;

      try {
        const page = (await snapshotsClient(run).list({ name, limit: 10 })) as {
          items: SnapshotResource[];
        };

        for (const holder of page.items) {
          const unusable =
            holder.id === exclude || isExpiring(holder.expiresAt);

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
  )) as { winner?: CachedSnapshot; cleared: boolean };
};

/**
 * Which cached parent, if any, a snapshot was built from that its job would no
 * longer use: its key has changed, or its snapshot was rebuilt or is gone. Run
 * as a memoized step when a machine first starts from a cached snapshot.
 *
 * The metadata lists every cached snapshot up the chain, so a change anywhere
 * above is found here.
 */
export const staleParentOf = async (
  run: CiRunScope,
  stepId: string,
  jobPath: string,
  meta: SnapshotMeta,
): Promise<string | undefined> => {
  const stale = (await run.step.run(
    ciStep(stepId, traceName.verifyCachedSnapshot),
    async () => {
      await tagStep(run, { kind: "cache", job: jobPath });

      for (const [jobId, parent] of Object.entries(meta.parents)) {
        const cache = run.ci.jobs.get(jobId)?.config.cache;

        if (!cache) {
          return jobId;
        }

        const ownKey = await jobCacheKey(run, cache, parent.input);
        const current = await findInScopes(run, jobId, cache, ownKey);

        if (current?.snapshotId !== parent.snapshotId) {
          return jobId;
        }
      }

      return null;
    },
  )) as string | null;

  return stale ?? undefined;
};

/**
 * Delete a snapshot that is no use, so no run finds it again. Best effort: a
 * snapshot that can't be deleted is left to expire.
 */
export const deleteSnapshot = async (
  run: CiRunScope,
  stepId: string,
  snapshotId: string,
): Promise<void> => {
  try {
    await run.step.run(
      ciStep(stepId, traceName.deleteBadSnapshot),
      async () => {
        try {
          const snapshot = await snapshotsClient(run).get(snapshotId);

          await snapshot?.delete();

          // Gone now, so the run's cleanup has nothing to delete.
          run.createdSnapshots.delete(snapshotId);

          return { deleted: Boolean(snapshot) };
        } catch {
          return { deleted: false };
        }
      },
    );
  } catch {
    // Best effort only.
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
 * Patterns support `**`, `*`, `?`, and `{a,b}`.
 */
export const files = (
  /** Glob patterns for the files to hash. */ ...patterns: string[]
): CacheKeyPart => {
  return {
    kind: "inngest/ci.cacheKeyPart",
    type: "files",
    patterns,
  };
};
