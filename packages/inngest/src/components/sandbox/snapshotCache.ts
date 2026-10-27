/**
 * `snapshotCache`: build a sandbox once, keep it as a named snapshot, find it
 * again by name, and build a new one when what it was built from changes.
 *
 * A snapshot is immutable and expires, and only the files in it survive. So a
 * cache entry is never a record: it is a snapshot's name,
 * `<scope>/<key>/<generation>`.
 *
 * - `scope`: who sees the entry and how it is cleaned up (`main`, `pr:4`,
 *   `skills`, `thread`).
 * - `key`: which entry it is (a repository, a thread, a job and its inputs).
 * - `generation`: which version of it (a commit sha, a hash of the inputs, a
 *   counter). A change is a new generation under the same scope and key; the
 *   older generations are deleted when the new one is taken, and expire
 *   otherwise.
 *
 * Several builders racing for one name are settled by the platform: it gives
 * a name to one snapshot, and the others adopt that snapshot.
 *
 * @module
 */

import hashjs from "hash.js";
import { durationToMs } from "../../helpers/duration.ts";
import type { SandboxClient, SandboxDuration } from "./types.ts";

const { sha256 } = hashjs;

/** Which cache entry, and which version of it, a snapshot is. */
export interface SnapshotEntry {
  /** Who sees the entry: `main`, `pr:4`, `skills`. May contain `/`. */
  scope: string;
  /** Which entry it is. May contain `/`. */
  key: string;
  /** Which version of it. Must not contain `/`. */
  generation: string;
}

/** The longest a snapshot name can be. */
const maxNameLength = 255;

/**
 * Hash a string to a short, stable hex digest. Used for keys and for
 * shortening names that would otherwise be too long.
 */
const hash = (input: string, length = 16): string => {
  return sha256().update(input).digest("hex").slice(0, length);
};

/**
 * A name that fits in `max` characters: long ones keep their start and gain a
 * hash of the whole, so two long names never become one.
 */
const bounded = (name: string, max: number): string => {
  if (name.length <= max) {
    return name;
  }

  const suffix = `-${hash(name, 8)}`;

  return `${name.slice(0, max - suffix.length)}${suffix}`;
};

/**
 * The slot of a name: everything but the generation. Names with the same slot
 * are versions of one entry, and a newer one replaces the others.
 */
export const snapshotSlot = (name: string): string => {
  return name.slice(0, name.lastIndexOf("/"));
};

/** The generation a name ends with. */
export const snapshotGeneration = (name: string): string => {
  return name.slice(name.lastIndexOf("/") + 1);
};

/**
 * The name a snapshot of an entry has: `<scope>/<key>/<generation>`. A name too
 * long for a snapshot has its scope and key shortened, keeping their start and
 * gaining a hash, so the generation stays whole and no two entries share a name.
 *
 * @throws {Error} When a part is empty or the generation has a `/`.
 */
export const snapshotName = (entry: SnapshotEntry): string => {
  const { scope, key, generation } = entry;

  if (!scope || !key || !generation) {
    throw new Error("A snapshot's scope, key and generation can't be empty.");
  }

  if (generation.includes("/")) {
    throw new Error(
      `A snapshot generation can't contain "/": "${generation}".`,
    );
  }

  const room = maxNameLength - 1 - generation.length;

  if (room < 16) {
    throw new Error("A snapshot generation is too long to fit in a name.");
  }

  const slot = bounded(`${scope}/${key}`, room);

  return `${slot}/${generation}`;
};

/** One part of a key: text, or a function that works the text out. */
export type SnapshotKeyPart = string | (() => string | Promise<string>);

/**
 * Hash the parts of a key into one string, which changes when any part does.
 * Named parts (an object) are told apart by their names, and also come back
 * resolved, for a builder that needs their values. Functions are called once,
 * in order.
 *
 * ```ts
 * const { hash } = await snapshotKey([lockfileHash, "node22"]);
 * const { hash, named } = await snapshotKey({ sha: () => resolveSha() });
 * ```
 */
export const snapshotKey = async (
  parts: SnapshotKeyPart[] | Record<string, SnapshotKeyPart>,
): Promise<{ hash: string; named: Record<string, string> }> => {
  const entries: [string | undefined, SnapshotKeyPart][] = Array.isArray(parts)
    ? parts.map((part) => {
        return [undefined, part];
      })
    : Object.entries(parts);

  const resolved: string[] = [];
  const named: Record<string, string> = {};

  for (const [name, part] of entries) {
    const value = typeof part === "function" ? await part() : part;

    if (name === undefined) {
      resolved.push(value);
    } else {
      resolved.push(`${name}=${value}`);
      named[name] = value;
    }
  }

  return { hash: hash(resolved.join("\0")), named };
};

/** A snapshot found by name. */
export interface FoundSnapshot {
  snapshotId: string;
  /** The name it has, which may be another scope's, such as the base branch's. */
  name: string;
  /** When it was taken, as an ISO timestamp. */
  createdAt: string;
}

/** A snapshot `take` or `ensure` ended with. */
export interface TakenSnapshot extends FoundSnapshot {
  /**
   * Whether the snapshot has its name. `false` when the name was refused or
   * couldn't be freed: the snapshot works, but nothing will find it later.
   */
  named: boolean;
  /** Whether it was already there, rather than taken by this call. */
  reused: boolean;
}

/** Options for finding a snapshot. */
export interface FindOptions {
  /**
   * The scopes to look in, in order. Defaults to the entry's own scope. A pull
   * request's snapshots read `["pr:4", "main"]`: its own, then the branch's.
   */
  read?: string[];
  /** Snapshots older than this are not used. */
  maxAge?: SandboxDuration;
  /** A snapshot that must not be used, though it may still hold the name. */
  exclude?: string;
  /** The ID the memoized lookup has. Defaults to one made from the entry. */
  stepId?: string;
}

/** Options for taking a snapshot. */
export interface TakeOptions {
  /** A holder of the name older than this is deleted so the name can be taken. */
  maxAge?: SandboxDuration;
  /** A snapshot that must not be used, though it may hold the name. */
  exclude?: string;
  /** Whether `exclude` is known to be broken, which is the only case it is deleted. */
  broken?: boolean;
  /** The ID steps are given. Defaults to one made from the entry. */
  stepId?: string;
}

/**
 * Takes the snapshot of the sandbox being built, with the name it is to have
 * (none if the name was refused). `attempt` counts from 0, so each attempt can
 * have a step ID of its own when the sandbox is a durable one:
 * `(name, attempt) => sandbox.snapshot(\`save:${attempt}\`, { name })`.
 */
export type TakeSnapshot = (
  name: string | undefined,
  attempt: number,
) => Promise<{ id: string; createdAt: string }>;

/** Options for `snapshotCache`. */
export interface SnapshotCacheOptions {
  /**
   * Run a lookup or cleanup so it happens once per run, such as
   * `(id, fn) => step.run(id, fn)`. Without it, each runs directly.
   */
  memo?: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
  /**
   * How long before it expires a snapshot stops being reused, long enough for
   * what starts from it to get its sandbox. Defaults to 15 minutes.
   */
  expiryMargin?: SandboxDuration;
  /** How long a lookup waits for a snapshot still being created. Defaults to 2 minutes. */
  readyWait?: SandboxDuration;
}

/** The snapshot API the cache needs, which `client.sandboxes` provides. */
export interface SnapshotCacheClient {
  sandboxes: {
    snapshots: Pick<SandboxClient["snapshots"], "list" | "get">;
  };
}

/** What the cache reads of a snapshot. */
interface SnapshotInfo {
  id: string;
  name?: string;
  status: string;
  createdAt: string;
  expiresAt?: string;
}

/** The cache of one client's snapshots. */
export interface SnapshotCache {
  /**
   * The newest usable snapshot of an entry, or `undefined`. Usable means ready
   * (a snapshot still being created is waited for), not about to expire, not
   * older than `maxAge` and not `exclude`. Any error is a miss.
   */
  find(
    entry: SnapshotEntry,
    options?: FindOptions,
  ): Promise<FoundSnapshot | undefined>;

  /**
   * Take the snapshot of an entry under its name. If another snapshot holds
   * the name, that one is used. If the holder is not usable it is deleted and
   * the take retried once. If the name is refused, the snapshot is taken
   * without one. A new snapshot replaces the older generations of its entry.
   */
  take(
    entry: SnapshotEntry,
    snapshot: TakeSnapshot,
    options?: TakeOptions,
  ): Promise<TakenSnapshot>;

  /**
   * The snapshot of an entry if there is one, else build it: `build` makes the
   * sandbox and returns the result of `take` for it.
   */
  ensure(
    entry: SnapshotEntry,
    build: (
      take: (snapshot: TakeSnapshot) => Promise<TakenSnapshot>,
    ) => Promise<TakenSnapshot>,
    options?: FindOptions & TakeOptions,
  ): Promise<TakenSnapshot | FoundSnapshot>;

  /**
   * The newest snapshot with this scope and key, whatever its generation. It
   * lists every snapshot, so prefer `find` with a known generation.
   */
  latest(
    entry: Pick<SnapshotEntry, "scope" | "key">,
    options?: Pick<FindOptions, "maxAge" | "exclude">,
  ): Promise<FoundSnapshot | undefined>;

  /** Delete a snapshot. `true` if it is gone, including if it already was. */
  remove(snapshotId: string): Promise<boolean>;
}

const defaultExpiryMargin = "15m";
const defaultReadyWait = "2m";
const readyPollMs = 1000;
const nameTakenCode = "sandbox_snapshot_name_taken";

const hasCode = (error: unknown, code: string): boolean => {
  const { code: own, cause } = (error ?? {}) as {
    code?: string;
    cause?: { code?: string };
  };

  return own === code || cause?.code === code;
};

/**
 * Whether a named snapshot was refused for its name, so taking it without one
 * may work. A server without snapshot names, such as an older Dev Server,
 * refuses the create as a bad request.
 */
const isNameRefused = (error: unknown): boolean => {
  const { status, name } = (error ?? {}) as { status?: number; name?: string };

  return status === 400 || status === 422 || name === "SandboxValidationError";
};

const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

/**
 * A cache of named snapshots on one client.
 *
 * ```ts
 * const cache = snapshotCache(client, { memo: (id, fn) => step.run(id, fn) });
 * const entry = { scope: "skills", key: "acme/skills", generation: sha };
 *
 * const found = await cache.find(entry);
 *
 * const snapshot = await cache.ensure(entry, async (take) => {
 *   const sandbox = await step.sandbox.create("bake", { name: "bake" });
 *   await sandbox.commands.run("clone", "git clone ...");
 *
 *   return take((name, attempt) => sandbox.snapshot(`save:${attempt}`, { name }));
 * });
 * ```
 */
export const snapshotCache = (
  client: SnapshotCacheClient,
  options: SnapshotCacheOptions = {},
): SnapshotCache => {
  const memo =
    options.memo ??
    (<T>(_id: string, fn: () => Promise<T>): Promise<T> => {
      return fn();
    });
  const marginMs = durationToMs(options.expiryMargin ?? defaultExpiryMargin, {
    name: "expiryMargin",
  });
  const readyWaitMs = durationToMs(options.readyWait ?? defaultReadyWait, {
    name: "readyWait",
  });
  const snapshots = client.sandboxes.snapshots;

  const usableFor = (
    maxAge: SandboxDuration | undefined,
    exclude: string | undefined,
  ): ((snapshot: SnapshotInfo) => boolean) => {
    const maxAgeMs =
      maxAge === undefined
        ? undefined
        : durationToMs(maxAge, { name: "maxAge" });

    return (snapshot) => {
      const createdAt = Date.parse(snapshot.createdAt);
      const expiresAt = snapshot.expiresAt
        ? Date.parse(snapshot.expiresAt)
        : Number.NaN;
      const expiring =
        Number.isFinite(expiresAt) && expiresAt - Date.now() < marginMs;
      const tooOld =
        maxAgeMs !== undefined &&
        Number.isFinite(createdAt) &&
        Date.now() - createdAt > maxAgeMs;

      return (
        snapshot.status === "READY" &&
        snapshot.id !== exclude &&
        !expiring &&
        !tooOld
      );
    };
  };

  const waitUntilReady = async (
    snapshotId: string,
  ): Promise<SnapshotInfo | undefined> => {
    const deadline = Date.now() + readyWaitMs;

    while (true) {
      const snapshot = (await snapshots.get(snapshotId)) as
        | SnapshotInfo
        | null
        | undefined;

      if (!snapshot || snapshot.status !== "CREATING") {
        return snapshot ?? undefined;
      }

      if (Date.now() >= deadline) {
        return undefined;
      }

      await sleep(readyPollMs);
    }
  };

  /** The newest snapshot with exactly this name, if usable. Errors are misses. */
  const findNamed = async (
    name: string,
    usable: (snapshot: SnapshotInfo) => boolean,
  ): Promise<FoundSnapshot | undefined> => {
    try {
      const page = await snapshots.list({ name, limit: 10 });

      // A server that doesn't know names lists everything, so only an exact
      // name counts.
      const newest = (page.items as SnapshotInfo[]).find((snapshot) => {
        return snapshot.name === name;
      });

      // Waiting is only worth it for a snapshot that would be usable once ready.
      if (!newest || !usable({ ...newest, status: "READY" })) {
        return undefined;
      }

      const ready =
        newest.status === "CREATING" ? await waitUntilReady(newest.id) : newest;

      if (!ready || !usable(ready)) {
        return undefined;
      }

      return { snapshotId: ready.id, name, createdAt: ready.createdAt };
    } catch {
      return undefined;
    }
  };

  const idOf = (action: string, entry: SnapshotEntry, stepId?: string) => {
    return `${stepId ?? `snapshot:${snapshotName(entry)}`}:${action}`;
  };

  const find: SnapshotCache["find"] = async (entry, findOptions = {}) => {
    const usable = usableFor(findOptions.maxAge, findOptions.exclude);

    const found = await memo(
      idOf("find", entry, findOptions.stepId),
      async (): Promise<FoundSnapshot | null> => {
        for (const scope of findOptions.read ?? [entry.scope]) {
          const hit = await findNamed(
            snapshotName({ ...entry, scope }),
            usable,
          );

          if (hit) {
            return hit;
          }
        }

        return null;
      },
    );

    return found ?? undefined;
  };

  const remove: SnapshotCache["remove"] = async (snapshotId) => {
    try {
      const snapshot = await snapshots.get(snapshotId);

      await snapshot?.delete();

      return true;
    } catch (error) {
      // Deleted meanwhile by someone else, which is as good.
      return hasCode(error, "sandbox_snapshot_not_found");
    }
  };

  /** Every snapshot that exists and passes `matches`, paged. */
  const listMatching = async (
    matches: (snapshot: SnapshotInfo & { name: string }) => boolean,
  ): Promise<(SnapshotInfo & { name: string })[]> => {
    const found: (SnapshotInfo & { name: string })[] = [];
    let cursor: string | undefined;

    do {
      const page = await snapshots.list({
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });

      for (const snapshot of page.items as SnapshotInfo[]) {
        // The API keeps the records of deleted snapshots in its lists.
        if (
          snapshot.name &&
          !/^DELET/.test(snapshot.status) &&
          matches({ ...snapshot, name: snapshot.name })
        ) {
          found.push({ ...snapshot, name: snapshot.name });
        }
      }

      cursor = page.page.hasMore ? page.page.cursor : undefined;
    } while (cursor);

    return found;
  };

  /**
   * Find the snapshot that holds a name a take couldn't get. A usable one wins;
   * an unusable one is deleted so the name can be taken after all.
   */
  const resolveTaken = async (
    name: string,
    maxAge: SandboxDuration | undefined,
    exclude: string | undefined,
    broken: boolean | undefined,
  ): Promise<{ winner?: FoundSnapshot; cleared: boolean }> => {
    const winner = await findNamed(name, usableFor(maxAge, exclude));

    if (winner) {
      return { winner, cleared: false };
    }

    let cleared = false;
    const usableHolder = usableFor(maxAge, undefined);

    try {
      const page = await snapshots.list({ name, limit: 10 });

      for (const holder of page.items as SnapshotInfo[]) {
        const unusable =
          (broken && holder.id === exclude) || !usableHolder(holder);

        if (holder.name !== name || holder.status !== "READY" || !unusable) {
          continue;
        }

        if (await remove(holder.id)) {
          cleared = true;
        }
      }
    } catch {
      // Nothing more to try: the snapshot is kept without a name.
    }

    return { cleared };
  };

  /** Delete the older generations of the entry a new snapshot replaces. */
  const deleteReplaced = async (mine: FoundSnapshot): Promise<void> => {
    const slot = snapshotSlot(mine.name);

    try {
      const replaced = await listMatching((other) => {
        return (
          snapshotSlot(other.name) === slot &&
          other.name !== mine.name &&
          other.createdAt <= mine.createdAt
        );
      });

      for (const other of replaced) {
        await remove(other.id);
      }
    } catch {
      // Best effort: what stays expires on its own.
    }
  };

  const take: SnapshotCache["take"] = async (
    entry,
    snapshot,
    takeOptions = {},
  ) => {
    const name = snapshotName(entry);
    const taken = (
      result: { id: string; createdAt: string },
      named: boolean,
    ): TakenSnapshot => {
      return {
        snapshotId: result.id,
        name,
        createdAt: result.createdAt,
        named,
        reused: false,
      };
    };
    let attempt = 0;

    const named = async (): Promise<TakenSnapshot> => {
      const result = taken(await snapshot(name, attempt++), true);

      await memo(idOf("replaced", entry, takeOptions.stepId), async () => {
        await deleteReplaced(result);

        return null;
      });

      return result;
    };

    let refused = false;

    try {
      return await named();
    } catch (error) {
      if (hasCode(error, nameTakenCode)) {
        refused = false;
      } else if (isNameRefused(error)) {
        refused = true;
      } else {
        throw error;
      }
    }

    if (!refused) {
      const holder = await memo(
        idOf("name-taken", entry, takeOptions.stepId),
        () => {
          return resolveTaken(
            name,
            takeOptions.maxAge,
            takeOptions.exclude,
            takeOptions.broken,
          );
        },
      );

      if (holder.winner) {
        // Another build got there first with the same name, so its snapshot is
        // as good as this one.
        return { ...holder.winner, named: true, reused: true };
      }

      if (holder.cleared) {
        try {
          return await named();
        } catch {
          // Falls back to a snapshot without the name.
        }
      }
    }

    return taken(await snapshot(undefined, attempt++), false);
  };

  const ensure: SnapshotCache["ensure"] = async (
    entry,
    build,
    ensureOptions,
  ) => {
    const found = await find(entry, ensureOptions);

    if (found) {
      return { ...found, named: true, reused: true };
    }

    return build((snapshot) => {
      return take(entry, snapshot, ensureOptions);
    });
  };

  const latest: SnapshotCache["latest"] = async (entry, latestOptions = {}) => {
    const usable = usableFor(latestOptions.maxAge, latestOptions.exclude);

    try {
      const matching = await listMatching((snapshot) => {
        // Rebuilding the name from the snapshot's own generation tells this
        // entry's snapshots from those of a key that merely starts the same.
        const generation = snapshotGeneration(snapshot.name);

        return (
          generation !== "" &&
          !generation.includes("/") &&
          snapshotName({ ...entry, generation }) === snapshot.name &&
          usable(snapshot)
        );
      });
      const newest = matching.sort((a, b) => {
        return a.createdAt < b.createdAt ? 1 : -1;
      })[0];

      return newest
        ? {
            snapshotId: newest.id,
            name: newest.name,
            createdAt: newest.createdAt,
          }
        : undefined;
    } catch {
      return undefined;
    }
  };

  return { find, take, ensure, latest, remove };
};
