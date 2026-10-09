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

import type { Inngest } from "inngest";
import { NonRetriableError } from "inngest";
import { mapGitHubError, rest } from "../github/rest.ts";
import type { ResolvedSource } from "../github/source.ts";
import {
  octokitForSource,
  resolvedSource,
  resolveSource,
  targetsRunRepo,
} from "../github/source.ts";
import { ciRun, shorten, warnStep } from "../pipeline/metadata.ts";
import { ciStep, traceName } from "../pipeline/names.ts";
import type { CiJobScope, CiRunScope } from "../pipeline/scope.ts";
import { countApi, rootRunIdOf, scopeSeparator } from "../pipeline/scope.ts";
import type {
  CacheConfig,
  CacheKey,
  CacheKeyPart,
  FilesOptions,
  JobConfig,
  RepoContext,
} from "../types.ts";
import {
  boundedName,
  durationToMs,
  filterPaths,
  formatRelative,
  hash,
  isSnapshotNotFound,
  stableStringify,
} from "../util.ts";

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
 * run's commit on GitHub (or for the commit its `repo` and `ref` resolved to),
 * or the working tree locally, so a key changes exactly when the matched files
 * do.
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

/** The parts of a cache key, as a list. */
const keyParts = (key: CacheKey | undefined): (CacheKeyPart | string)[] => {
  if (key === undefined || typeof key === "function") {
    return [];
  }

  return Array.isArray(key) ? key : [key];
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
  for (const part of keyParts(key)) {
    if (typeof part !== "string" && !targetsRunRepo(run, part)) {
      await resolveSource(run, part);
    }
  }
};

const resolveFilesPart = async (
  run: CiRunScope,
  part: CacheKeyPart,
): Promise<string> => {
  if (!targetsRunRepo(run, part)) {
    return hashRemoteFiles(run, await resolvedSource(run, part), part);
  }

  const repo = run.repo;

  if (repo?.local && process.env.INNGEST_CI_GITHUB !== "live") {
    const { hashLocalFiles } = await import("./localCache.ts");

    return hashLocalFiles(repo.local.path, part.patterns);
  }

  if (!repo && run.build?.resolve) {
    throw new NonRetriableError(noDeployedRepo(run, "`files()`"));
  }

  if (!repo) {
    return `files:${part.patterns.join(",")}`;
  }

  const tree = await rest.git.getTree({
    tree_sha: repo.sha,
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
      `\`${fullName}\` is too large to hash \`files()\` from GitHub's tree API, which cut the file listing short. Use narrower patterns, or a string key.`,
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
 * Why a job another app asked for can't read its repository: the deployment
 * didn't say which it came from.
 */
export const noDeployedRepo = (run: CiRunScope, what: string): string => {
  const job = run.build?.resolve?.job ?? "this job";

  return `\`${run.ci.client.id}/${job}\` uses ${what}, but this app's deployment doesn't say which repository it came from. Deploy it from a host that sets git variables (Vercel, Netlify, Render, Railway, GitHub Actions) or from a git checkout.`;
};

/**
 * A job's own cache key: its resolved key, with the repository, the input it
 * was called with and the snapshot it starts from folded in, since any of
 * them changing makes it a different job. The app's ID is always part of it,
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
): Promise<string> => {
  const key = await resolveCacheKey(run, cache.key);

  // Repositories and apps can share a Sandbox environment, so the same
  // branch, job and key in two of them are still two names.
  const app = `app:${run.ci.client?.id ?? ""}`;
  const owner = run.repo ? `repo:${run.repo.fullName}\0${app}` : app;

  return identityKey(hash(`${key}\0${owner}`), input, base);
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
    parts.push(
      base.image === undefined
        ? `from:${base.jobId}@${base.snapshotId ?? ""}`
        : `from:image:${base.image}@${base.snapshotId ?? ""}`,
    );
  }

  return parts.length === 1 ? key : hash(parts.join("\0"));
};

/**
 * The base a job starts from, as its key sees it: a parent job or a base
 * image, and its snapshot, which is missing when a parent had none to take. A parent rebuilt
 * with any change has a new snapshot, so every job below it gets a new name
 * and misses on lookup, without a machine starting to find out.
 */
export interface BaseIdentity {
  /** The parent job, for a job base. */
  jobId?: string;
  /** The name of the base image, for an image base. */
  image?: string;
  snapshotId?: string;
}

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

  const ownKey = await ciRun(
    run,
    {
      step: ciStep(
        `${job.path}${scopeSeparator}cache:key`,
        traceName.checkCache,
      ),
      intent: `Work out the cache key for \`${jobId}\``,
      tag: { kind: "cache", job: job.path },
    },
    async (note) => {
      const key = await jobCacheKey(run, cache, input, base);

      note.outcome({ key });

      return key;
    },
  );

  return {
    ownKey,
    name: snapshotName(cacheScopes(run.repo, cache.scope).write, jobId, ownKey),
  };
};

/**
 * The start of every name a pipeline run's builds give their snapshots. The
 * trailing `/` keeps one run's prefix from matching another run's longer ID.
 */
export const runSnapshotPrefix = (rootRunId: string): string => {
  return `ci/run:${rootRunId}/`;
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
    name: snapshotName(`run:${rootRunIdOf(run)}`, jobId, ownKey),
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

/**
 * A job's `maxAge` in milliseconds, or none if it has no cache or no max age.
 * `defineJob` has already checked that it parses.
 */
export const maxAgeMsOf = (
  cache: CacheConfig | undefined,
): number | undefined => {
  return cache?.maxAge === undefined
    ? undefined
    : durationToMs(cache.maxAge, "cache.maxAge");
};

/** Whether a snapshot was taken longer ago than a job's max age allows. */
const isTooOld = (createdAt: string, maxAgeMs: number | undefined): boolean => {
  if (maxAgeMs === undefined) {
    return false;
  }

  const at = Date.parse(createdAt);

  return Number.isFinite(at) && Date.now() - at > maxAgeMs;
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

/** The direct snapshots client of an Inngest client. */
// biome-ignore lint/suspicious/noExplicitAny: SandboxClient["snapshots"], kept loose
export const clientSnapshots = (client: Inngest.Any): any => {
  // biome-ignore lint/suspicious/noExplicitAny: the SDK's sandboxes client
  return (client as any).sandboxes.snapshots;
};

/** The direct snapshots client, for CI's own steps. */
// biome-ignore lint/suspicious/noExplicitAny: SandboxClient["snapshots"], kept loose
const snapshotsClient = (run: CiRunScope): any => {
  return clientSnapshots(run.ci.client);
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
export const findNamed = async (
  run: CiRunScope,
  name: string,
  /** A snapshot that must not be used, though it may still hold the name. */
  exclude?: string,
  /** How old a snapshot may be, in milliseconds, from the job's `maxAge`. */
  maxAgeMs?: number,
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

    if (
      ready?.status !== "READY" ||
      isExpiring(ready.expiresAt) ||
      isTooOld(ready.createdAt, maxAgeMs)
    ) {
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
  const maxAgeMs = maxAgeMsOf(cache);

  for (const scope of cacheScopes(run.repo, cache.scope).read) {
    const found = await findNamed(
      run,
      snapshotName(scope, jobId, ownKey),
      exclude,
      maxAgeMs,
    );

    if (found) {
      return found;
    }
  }

  return undefined;
};

/** What a lookup step sets out to do, for the job it looks a snapshot up for. */
const lookupIntent = (jobId: string): string => {
  return `Look up the cached snapshot for \`${jobId}\``;
};

/** What a lookup step found, for its outcome. */
const lookupOutcome = (hit: CachedSnapshot | undefined) => {
  return hit
    ? { found: true, snapshotId: hit.snapshotId, name: hit.name }
    : { found: false };
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
  const { run } = scope;

  const found = await ciRun<CachedSnapshot | null>(
    run,
    {
      step: ciStep(
        `${scope.path}${scopeSeparator}cache:lookup`,
        traceName.lookUpCache,
      ),
      intent: lookupIntent(scope.config.id),
      tag: { kind: "cache", job: scope.path },
    },
    async (note) => {
      const hit = await findCached(
        run,
        scope.config.id,
        cache,
        target,
        exclude,
      );

      note.outcome(lookupOutcome(hit));

      return hit ?? null;
    },
  );

  return found ?? undefined;
};

/**
 * What a lookup for a `from` parent says on its row, which is the parent's own:
 * one row however many jobs start from it.
 */
export interface ParentNotes {
  /** The cached parent, which a miss means is built just in time. */
  justInTime?: JobConfig;
  /** A cached job whose cache is unusable because its base has none. */
  uncachedBase?: { jobId: string; baseId: string };
}

/** A job's usable snapshot: in the scopes it reads if cached, else by its run's name. */
const findCached = (
  run: CiRunScope,
  jobId: string,
  cache: CacheConfig | undefined,
  target: CacheTarget,
  exclude?: string,
): Promise<CachedSnapshot | undefined> => {
  return cache
    ? findInScopes(run, jobId, cache, target.ownKey, exclude)
    : findNamed(run, target.name, exclude);
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
  /** What to warn about, when the lookup is for a job's `from` parent. */
  notes?: ParentNotes,
): Promise<CachedSnapshot | undefined> => {
  const found = await ciRun<CachedSnapshot | null>(
    run,
    {
      step: ciStep(
        `${job.stepPath}${scopeSeparator}lookup`,
        traceName.lookUpCache,
      ),
      intent: lookupIntent(job.id),
      tag: { kind: "cache", job: job.path },
    },
    async (note) => {
      const hit = await findCached(run, job.id, cache, target, exclude);

      note.outcome(lookupOutcome(hit));

      if (notes?.uncachedBase) {
        await warnStep(
          run,
          "ci.uncachedBase",
          uncachedBaseNote(notes.uncachedBase.jobId, notes.uncachedBase.baseId)
            .message,
        );
      } else if (notes?.justInTime && !hit) {
        await warnStep(
          run,
          "ci.justInTime",
          justInTimeNote(notes.justInTime).message,
        );
      }

      return hit ?? null;
    },
  );

  // From the memoized result, so a replay says it too, once per parent however
  // many jobs start from it.
  if (notes?.justInTime && !found) {
    warnJustInTime(run, notes.justInTime);
  }

  return found ?? undefined;
};

/**
 * What a cached parent that was built just in time says, on the row of its
 * lookup (`message`) and in the run's warnings (`line`). One place, so the
 * two can't drift apart.
 *
 * A miss is more than "never built": the lookup also comes back empty on an
 * API error, a snapshot about to expire or still being made, or one that isn't
 * ready. The wording is true for all of them, and only suggests `cache.warm`
 * when the parent has none.
 */
export const justInTimeNote = (
  config: JobConfig,
): { message: string; line: string } => {
  const warm = Boolean(config.cache?.warm);

  return {
    message: `\`${config.id}\` had no usable cached snapshot for these inputs, so it was built while the jobs that start from it waited. ${
      warm
        ? "Its `cache.warm` triggers hadn't built a usable snapshot for these inputs yet."
        : "Add `cache.warm` to build it ahead of time."
    }`,
    line: `built just in time: \`${config.id}\` (${
      warm
        ? "not warmed for these inputs yet"
        : "add `cache.warm` to build it ahead of time"
    })`,
  };
};

/** Add a cached parent's just-in-time line to the run's warnings, once. */
export const warnJustInTime = (run: CiRunScope, config: JobConfig): void => {
  const { line } = justInTimeNote(config);

  if (!run.warnings.includes(line)) {
    run.warnings.push(line);
  }
};

/**
 * What a cached job that starts from a job with no `cache` says, on a row of
 * the trace (`message`) and in the run's warnings (`line`). A job without a
 * cache is built fresh in every run, and the cached job's key holds that
 * build's snapshot, so the cached job could never be found again. It is built
 * in every run too, without a name, and the run deletes its snapshot at its
 * end. Warming can't help, so this replaces the just-in-time note.
 */
export const uncachedBaseNote = (
  /** The cached job. */
  jobId: string,
  /** The job it starts from, which has no cache. */
  baseId: string,
): { message: string; line: string } => {
  return {
    message: `\`${jobId}\` is cached, but it starts from \`${baseId}\`, which has no \`cache\`. \`${baseId}\` is built fresh in every run, so \`${jobId}\` is rebuilt in every run too and its snapshot is never reused or named. Give \`${baseId}\` a \`cache\`.`,
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
 * Find the snapshot that holds a name a build couldn't take, as a memoized
 * step. If it can't be used, because it is about to expire, is older than the
 * job's max age or is the bad one the build replaces, it is deleted so the
 * build can take the name after all.
 */
export const resolveTakenName = async (
  run: CiRunScope,
  stepId: string,
  name: string,
  exclude?: string,
  /**
   * Whether `exclude` was decided to be broken, which is the only case where
   * it is deleted. A snapshot that merely failed to start once may be a
   * shared one, such as the base branch's, that other runs still use.
   */
  broken?: boolean,
  /** How old a snapshot may be, in milliseconds, from the job's `maxAge`. */
  maxAgeMs?: number,
): Promise<{ winner?: CachedSnapshot; cleared: boolean }> => {
  return ciRun<{ winner?: CachedSnapshot; cleared: boolean }>(
    run,
    {
      step: ciStep(stepId, traceName.resolveCacheName),
      intent: `Find who holds the snapshot name \`${shorten(name, 80)}\``,
    },
    async (note) => {
      const winner = await findNamed(run, name, exclude, maxAgeMs);

      if (winner) {
        note.outcome({
          winner: winner.snapshotId,
          cleared: false,
        });

        return { winner, cleared: false };
      }

      let cleared = false;

      try {
        const page = (await snapshotsClient(run).list({ name, limit: 10 })) as {
          items: SnapshotResource[];
        };

        for (const holder of page.items) {
          const unusable =
            (broken && holder.id === exclude) ||
            isExpiring(holder.expiresAt) ||
            isTooOld(holder.createdAt, maxAgeMs);

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

      note.outcome({ cleared });

      return { cleared };
    },
  );
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
  return ciRun<"gone" | "creating" | "ready">(
    run,
    {
      step: ciStep(stepId, traceName.checkSnapshotState),
      intent: `Check the state of snapshot \`${snapshotId}\``,
    },
    async (note) => {
      try {
        const snapshot = (await snapshotsClient(run).get(snapshotId)) as
          | SnapshotResource
          | null
          | undefined;

        if (!snapshot || /^DELET/.test(snapshot.status)) {
          note.outcome({ snapshotId, state: "gone" });

          return "gone";
        }

        const state = snapshot.status === "CREATING" ? "creating" : "ready";

        note.outcome({ snapshotId, state });

        return state;
      } catch {
        note.outcome({ snapshotId, state: "ready" });

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
    const result = await ciRun<{ deleted: boolean; gone: boolean }>(
      run,
      {
        step: ciStep(stepId, traceName.deleteBadSnapshot),
        intent: `Delete the bad snapshot \`${snapshotId}\``,
      },
      async (note) => {
        try {
          const snapshot = await snapshotsClient(run).get(snapshotId);

          await snapshot?.delete();

          note.outcome({ snapshotId, deleted: Boolean(snapshot) });

          return { deleted: Boolean(snapshot), gone: true };
        } catch (error) {
          const gone = isSnapshotNotFound(error);

          note.outcome({ snapshotId, deleted: false, gone });

          // Deleted meanwhile by someone else, which is as good.
          return { deleted: false, gone };
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

  const patterns = list.filter((arg): arg is string => {
    return typeof arg === "string";
  });

  return {
    kind: "inngest/ci.cacheKeyPart",
    type: "files",
    patterns,
    ...(options?.repo ? { repo: options.repo } : {}),
    ...(options?.ref ? { ref: options.ref } : {}),
  };
};
