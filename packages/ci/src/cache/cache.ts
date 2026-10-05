/**
 * Cache stores (memory and file) and the machinery behind a job's `cache`
 * option: keys, lookups, storing entries, and the `files()` key helper.
 *
 * @module
 */

import type { CiJobScope, CiRunScope } from "../pipeline/scope.ts";
import { scopeSeparator } from "../pipeline/scope.ts";
import type {
  CacheConfig,
  CacheEntry,
  CacheKey,
  CacheKeyPart,
  CacheStore,
  RepoContext,
} from "../types.ts";
import { hash } from "../util.ts";

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Keep cache entries in memory, for as long as the process lives.
 *
 * This is the default. It's the right choice for a single long-lived server
 * and the wrong one for a fleet, where each machine would have its own cache;
 * use `fileCacheStore()` on shared storage, or your own `CacheStore`.
 */
export const memoryCacheStore = (): CacheStore => {
  const entries = new Map<string, CacheEntry>();

  return {
    get: async (key) => {
      return entries.get(key);
    },
    set: async (key, entry) => {
      entries.set(key, entry);
    },
  };
};

/**
 * EXPERIMENTAL: This API is not yet stable and may change in the future without
 * a major version bump.
 *
 * Keep cache entries as JSON files on disk, so they survive a restart.
 *
 * ```ts
 * export const ci = createCi(inngest, {
 *   cacheStore: fileCacheStore(".inngest/ci-cache"),
 * });
 * ```
 */
export const fileCacheStore = (
  /** Where to write entries. */
  dir = ".inngest/ci-cache",
): CacheStore => {
  const pathFor = async (key: string) => {
    const { join } = await import("node:path");

    return join(dir, `${hash(key, 32)}.json`);
  };

  return {
    get: async (key) => {
      try {
        const { readFile } = await import("node:fs/promises");
        const contents = await readFile(await pathFor(key), "utf8");

        return JSON.parse(contents) as CacheEntry;
      } catch {
        return undefined;
      }
    },
    set: async (key, entry) => {
      const { mkdir, writeFile } = await import("node:fs/promises");

      await mkdir(dir, { recursive: true });

      await writeFile(await pathFor(key), JSON.stringify(entry, null, 2));
    },
  };
};

/**
 * Where a job reads and writes cache entries.
 *
 * With the default `"branch"` scope, a pull request reads entries built on the
 * branch it targets and writes its own, so one PR can't poison another.
 */
export const cacheScopes = (
  repo: RepoContext | undefined,
  scope: CacheConfig["scope"],
): { read: string[]; write: string } => {
  if (scope === "global" || !repo) {
    return { read: ["global"], write: "global" };
  }

  const base = repo.baseRef ?? "default";

  if (repo.pullRequest) {
    const own = `pr-${repo.pullRequest.number}`;

    return { read: [own, base], write: own };
  }

  const branch = repo.ref?.replace(/^refs\/heads\//, "") ?? base;

  return { read: [branch], write: branch };
};

export const storeKey = (scope: string, jobId: string, key: string): string => {
  return `${scope}:${jobId}:${key}`;
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

export interface CacheLookup {
  /** The key this job's entry is stored under. */
  writeKey: string;
  entry?: CacheEntry;
  /** The resolved key the entry is stored under. */
  ownKey: string;
}

const findEntry = async (
  run: CiRunScope,
  cache: CacheConfig,
  jobId: string,
  key: string,
): Promise<CacheEntry | undefined> => {
  for (const readScope of cacheScopes(run.repo, cache.scope).read) {
    const found = await run.ci.cacheStore.get(storeKey(readScope, jobId, key));

    if (found) {
      return found;
    }
  }

  return undefined;
};

/**
 * The current keys of the cached jobs a job starts `from()`, by job ID.
 *
 * `from()` only runs inside the job body, after the lookup, so a job's entry
 * records its parents' keys when it is built and a lookup compares them with
 * the current ones. Each key folds in the parent's own parents, read from the
 * parent's stored entry, so a change anywhere up the chain changes it. A parent
 * that isn't cached has no key and is left out.
 */
export const resolveParentKeys = async (
  run: CiRunScope,
  jobIds: string[],
): Promise<Record<string, string>> => {
  const keys: Record<string, string> = {};

  for (const jobId of jobIds) {
    const cache = run.ci.jobs.get(jobId)?.config.cache;

    if (!cache) {
      continue;
    }

    const key = await resolveCacheKey(run, cache.key);
    const entry = await findEntry(run, cache, jobId, key);

    const parents = await resolveParentKeys(
      run,
      Object.keys(entry?.fromKeys ?? {}),
    );

    keys[jobId] = hash(
      `${key}|${entry ? "built" : "unbuilt"}|${JSON.stringify(parents)}`,
    );
  }

  return keys;
};

/**
 * Compute this job's key and look for an entry, both as memoized steps. An
 * entry is a miss if any parent's key has changed since it was built.
 */
export const lookupCache = async (
  scope: CiJobScope,
  cache: CacheConfig,
): Promise<CacheLookup> => {
  const { run } = scope;
  const jobId = scope.config.id;

  const ownKey = (await run.step.run(
    {
      id: `${scope.path}${scopeSeparator}cache:key`,
      name: "cache:key",
    },
    async () => {
      return resolveCacheKey(run, cache.key);
    },
  )) as string;

  const entry = (await run.step.run(
    {
      id: `${scope.path}${scopeSeparator}cache:lookup`,
      name: "cache:lookup",
    },
    async () => {
      const found = await findEntry(run, cache, jobId, ownKey);
      const built = found?.fromKeys ?? {};
      const current = await resolveParentKeys(run, Object.keys(built));
      const unchanged = JSON.stringify(current) === JSON.stringify(built);

      return found && unchanged ? found : null;
    },
  )) as CacheEntry | null;

  return {
    writeKey: storeKey(cacheScopes(run.repo, cache.scope).write, jobId, ownKey),
    ownKey,
    ...(entry ? { entry } : {}),
  };
};

/**
 * Store an entry after a successful run, with the keys of its parents.
 */
export const storeCache = async (
  scope: CiJobScope,
  lookup: CacheLookup,
  entry: Omit<CacheEntry, "key" | "fromKeys">,
): Promise<void> => {
  const { run } = scope;

  await run.step.run(
    {
      id: `${scope.path}${scopeSeparator}cache:store`,
      name: "cache:store",
    },
    async () => {
      const fromKeys = await resolveParentKeys(run, scope.fromJobIds);
      const full: CacheEntry = { ...entry, key: lookup.ownKey, fromKeys };

      await run.ci.cacheStore.set(lookup.writeKey, full);

      return { key: lookup.writeKey };
    },
  );
};

/**
 * A cached snapshot may have expired, in which case the entry is a miss.
 */
export const snapshotIsReady = async (
  run: CiRunScope,
  scopePath: string,
  snapshotId: string,
): Promise<boolean> => {
  try {
    const snapshot = await run.sandboxTools.snapshots.get(
      {
        id: `${scopePath}${scopeSeparator}cache:snapshot`,
        name: "cache:snapshot",
      },
      snapshotId,
    );

    return snapshot?.status === "READY";
  } catch {
    return false;
  }
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
