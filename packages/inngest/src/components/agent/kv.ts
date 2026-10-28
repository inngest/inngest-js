/**
 * @module
 * EXPERIMENTAL: a scoped key-value store over a Redis URL
 * (`INNGEST_EXPERIMENTAL_KV_URL`). Scopes say how long a value lives and who sees it:
 * `env`, `app`, `function`, `run` (the default), `session` and `thread`.
 *
 * Inside a function every read and write is its own memoized step, so a
 * replay sees the values the first execution saw. Outside a function (a thread
 * handle, a script) calls go straight to the store.
 *
 * The scope is chosen up front: `kv.thread.get("plan")` is the current
 * thread's, `kv.scope("thread", key).get("plan")` is another's, and plain
 * `kv.get()` is the run's own. A global `kv` finds the current run, session
 * and thread from the function it is called in.
 */

import { getAsyncCtxSync } from "../execution/als.ts";
import { step } from "../InngestStepTools.ts";
import { redisConnection } from "./redis.ts";
import { currentSessions } from "./sessions.ts";

export type KvScope = "env" | "app" | "function" | "run" | "session" | "thread";

/**
 * Where values are stored. Each scope instance is one hash, so removing a
 * whole scope (a finished run) is one call.
 */
export interface KvAdapter {
  get(hash: string, field: string): Promise<string | null>;

  /**
   * @param ttl Seconds until the field expires. Absent: it never does.
   */
  set(hash: string, field: string, value: string, ttl?: number): Promise<void>;

  /**
   * Writes only when the field has no live value. Returns whether it wrote.
   * @param ttl Seconds until the field expires. Absent: it never does.
   */
  setIfAbsent(
    hash: string,
    field: string,
    value: string,
    ttl?: number,
  ): Promise<boolean>;
  delete(hash: string, field: string): Promise<void>;
  all(hash: string): Promise<Record<string, string>>;

  /**
   * Removes every field and index of the hash.
   */
  clear(hash: string): Promise<void>;
  indexAdd(
    hash: string,
    index: string,
    member: string,
    score: number,
  ): Promise<void>;
  indexRange(
    hash: string,
    index: string,
    options: KvIndexRange,
  ): Promise<KvIndexEntry[]>;
  indexRemove(hash: string, index: string, member: string): Promise<void>;
}

/**
 * One member of a sorted index and its score.
 */
export interface KvIndexEntry {
  member: string;
  score: number;
}

export interface KvIndexRange {
  /**
   * Lowest score to include. Default: no lower bound.
   */
  min?: number;

  /**
   * Highest score to include. Default: no upper bound.
   */
  max?: number;

  /**
   * Most members to return. Default: all of them.
   */
  limit?: number;

  /**
   * `"asc"` (lowest score first, the default) or `"desc"`.
   */
  order?: "asc" | "desc";
}

/**
 * An in-process adapter, for tests and local scripts.
 */
export function memoryKvAdapter(): KvAdapter {
  const hashes = new Map<string, Map<string, string>>();
  const expiries = new Map<string, number>();
  const indexes = new Map<string, Map<string, number>>();

  function hashOf(hash: string) {
    let found = hashes.get(hash);
    if (!found) {
      found = new Map();
      hashes.set(hash, found);
    }

    return found;
  }

  function expiryKey(hash: string, field: string) {
    return `${hash}|${field}`;
  }

  // Drops the field once its time is up, so every read gives the same answer.
  function live(hash: string, field: string) {
    const at = expiries.get(expiryKey(hash, field));
    if (at !== undefined && at <= Date.now()) {
      hashOf(hash).delete(field);
      expiries.delete(expiryKey(hash, field));
    }

    return hashOf(hash).has(field);
  }

  function write(hash: string, field: string, value: string, ttl?: number) {
    hashOf(hash).set(field, value);
    if (ttl === undefined) {
      expiries.delete(expiryKey(hash, field));
    } else {
      expiries.set(expiryKey(hash, field), Date.now() + ttl * 1000);
    }
  }

  return {
    async get(hash, field) {
      return live(hash, field) ? (hashOf(hash).get(field) ?? null) : null;
    },
    async set(hash, field, value, ttl) {
      write(hash, field, value, ttl);
    },
    async setIfAbsent(hash, field, value, ttl) {
      if (live(hash, field)) {
        return false;
      }
      write(hash, field, value, ttl);

      return true;
    },
    async delete(hash, field) {
      hashOf(hash).delete(field);
      expiries.delete(expiryKey(hash, field));
    },
    async all(hash) {
      for (const field of [...hashOf(hash).keys()]) {
        live(hash, field);
      }

      return Object.fromEntries(hashOf(hash));
    },
    async clear(hash) {
      hashes.delete(hash);
      for (const key of [...expiries.keys()]) {
        if (key.startsWith(`${hash}|`)) {
          expiries.delete(key);
        }
      }
      for (const key of [...indexes.keys()]) {
        if (key.startsWith(`${hash}|`)) {
          indexes.delete(key);
        }
      }
    },
    async indexAdd(hash, index, member, score) {
      const key = `${hash}|${index}`;
      const found = indexes.get(key) ?? new Map<string, number>();
      found.set(member, score);
      indexes.set(key, found);
    },
    async indexRange(hash, index, options) {
      const entries = [...(indexes.get(`${hash}|${index}`) ?? [])]
        .map(([member, score]) => {
          return { member, score };
        })
        .filter((entry) => {
          return (
            entry.score >= (options.min ?? -Infinity) &&
            entry.score <= (options.max ?? Infinity)
          );
        })
        .sort((a, b) => {
          return a.score - b.score || (a.member < b.member ? -1 : 1);
        });
      if (options.order === "desc") {
        entries.reverse();
      }

      return entries.slice(0, options.limit ?? entries.length);
    },
    async indexRemove(hash, index, member) {
      indexes.get(`${hash}|${index}`)?.delete(member);
    },
  };
}

/**
 * A Redis adapter that connects on first use.
 * @param url `redis://` or `rediss://` URL.
 */
export function redisKvAdapter(url: string): KvAdapter {
  const client = redisConnection(url);

  // Fields with a time to live are plain keys (older servers cannot expire a
  // hash field) and each index is a sorted set; both are named after the hash.
  function expiring(hash: string, field: string) {
    return `${hash}|t|${field}`;
  }

  function sorted(hash: string, index: string) {
    return `${hash}|z|${index}`;
  }

  async function command(...args: string[]) {
    return (await client()).command(...args);
  }

  // Every key of the hash other than the hash itself matching `kind`.
  async function scan(hash: string, kind: "t" | "z") {
    const pattern = `${hash.replace(/[\\*?[\]]/g, "\\$&")}|${kind}|*`;
    const found: string[] = [];
    let cursor = "0";
    do {
      const reply = (await command(
        "SCAN",
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        "200",
      )) as [string, string[]];
      cursor = reply[0];
      found.push(...reply[1]);
    } while (cursor !== "0");

    return found;
  }

  return {
    async get(hash, field) {
      const stored = (await command("HGET", hash, field)) as string | null;

      return (
        stored ??
        ((await command("GET", expiring(hash, field))) as string | null)
      );
    },
    async set(hash, field, value, ttl) {
      if (ttl === undefined) {
        await command("HSET", hash, field, value);
        await command("DEL", expiring(hash, field));

        return;
      }

      await command("SET", expiring(hash, field), value, "EX", String(ttl));
      await command("HDEL", hash, field);
    },
    async setIfAbsent(hash, field, value, ttl) {
      if ((await command("HEXISTS", hash, field)) === 1) {
        return false;
      }

      const args = ["SET", expiring(hash, field), value];
      if (ttl !== undefined) {
        args.push("EX", String(ttl));
      }
      args.push("NX");

      return (await command(...args)) === "OK";
    },
    async delete(hash, field) {
      await command("HDEL", hash, field);
      await command("DEL", expiring(hash, field));
    },
    async all(hash) {
      const reply = (await command("HGETALL", hash)) as string[];
      const out: Record<string, string> = {};
      for (let i = 0; i < reply.length; i += 2) {
        out[reply[i] as string] = reply[i + 1] as string;
      }

      const keys = await scan(hash, "t");
      if (keys.length > 0) {
        const values = (await command("MGET", ...keys)) as (string | null)[];
        const prefix = `${hash}|t|`;
        keys.forEach((key, i) => {
          const value = values[i];
          if (value !== null && value !== undefined) {
            out[key.slice(prefix.length)] = value;
          }
        });
      }

      return out;
    },
    async clear(hash) {
      const keys = [...(await scan(hash, "t")), ...(await scan(hash, "z"))];
      await command("DEL", hash, ...keys);
    },
    async indexAdd(hash, index, member, score) {
      await command("ZADD", sorted(hash, index), String(score), member);
    },
    async indexRange(hash, index, options) {
      const low = options.min === undefined ? "-inf" : String(options.min);
      const high = options.max === undefined ? "+inf" : String(options.max);
      const desc = options.order === "desc";
      const args = desc
        ? ["ZREVRANGEBYSCORE", sorted(hash, index), high, low]
        : ["ZRANGEBYSCORE", sorted(hash, index), low, high];
      args.push("WITHSCORES");
      if (options.limit !== undefined) {
        args.push("LIMIT", "0", String(options.limit));
      }

      const reply = (await command(...args)) as string[];
      const out: KvIndexEntry[] = [];
      for (let i = 0; i < reply.length; i += 2) {
        out.push({ member: reply[i] as string, score: Number(reply[i + 1]) });
      }

      return out;
    },
    async indexRemove(hash, index, member) {
      await command("ZREM", sorted(hash, index), member);
    },
  };
}

export interface KvSetOptions {
  /**
   * Seconds until the key expires. Default: it never does.
   */
  ttl?: number;
}

/**
 * A sorted index in a scope instance: members ordered by a numeric score,
 * for example run ids by start time. Inside a function every call is a
 * memoized step.
 */
export interface KvIndex {
  /**
   * Adds the member, or moves it to the new score.
   * @param member The member, for example an id.
   * @param score What it sorts by, for example a timestamp.
   */
  add(member: string, score: number): Promise<void>;

  /**
   * Members in score order, with their scores.
   */
  range(options?: KvIndexRange): Promise<KvIndexEntry[]>;
  remove(member: string): Promise<void>;
}

export interface KvHandle {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, options?: KvSetOptions): Promise<void>;
  setIfAbsent(
    key: string,
    value: unknown,
    options?: KvSetOptions,
  ): Promise<boolean>;
  delete(key: string): Promise<void>;
  all<T = unknown>(): Promise<Record<string, T>>;
  clear(): Promise<void>;
  indexAdd(index: string, member: string, score: number): Promise<void>;
  indexRange(index: string, options: KvIndexRange): Promise<KvIndexEntry[]>;
  indexRemove(index: string, member: string): Promise<void>;
}

export interface KvScopeIds {
  env: string;
  app: string;
  function?: string;
  run?: string;
  session?: string;
  thread?: string;
}

/**
 * One scope instance: the keys of a run, a thread and so on. Inside a function
 * every call is a memoized step; outside one it goes straight to the store.
 */
export interface KvScopeInstance {
  get<T = unknown>(key: string): Promise<T | undefined>;

  /**
   * Writes a key. With `{ ttl }` it expires that many seconds later.
   */
  set(key: string, value: unknown, options?: KvSetOptions): Promise<void>;

  /**
   * Writes a key only when it has no value, and returns whether it did: the
   * first caller gets `true`, later ones `false` until the key expires or is
   * deleted. Atomic across runs. Use one style per key: a key written with
   * `set` and no `ttl` is seen as present, but a later `set` may replace a claim.
   */
  setIfAbsent(
    key: string,
    value: unknown,
    options?: KvSetOptions,
  ): Promise<boolean>;

  /**
   * A sorted index named `name`, kept beside the keys of the scope instance
   * and removed with `clear()`.
   * @param name Index name.
   */
  index(name: string): KvIndex;

  /**
   * Reads, transforms and writes a key in one step. Not atomic across runs.
   */
  update<T = unknown>(
    key: string,
    fn: (current: T | undefined) => T,
  ): Promise<T>;

  /**
   * Reads a key and deletes it in one step. Use it for flags consumed once.
   */
  take<T = unknown>(key: string): Promise<T | undefined>;
  delete(key: string): Promise<void>;
  all<T = unknown>(): Promise<Record<string, T>>;

  /**
   * Removes every key of the scope instance.
   */
  clear(): Promise<void>;
}

export interface Kv extends KvScopeInstance {
  /**
   * A scope instance. Without `id` it is the current function's (the run, or
   * the thread or session the run belongs to); with one it is that instance.
   * @param scope The scope.
   * @param id The instance, for example a thread key.
   */
  scope(scope: KvScope, id?: string): KvScopeInstance;

  readonly env: KvScopeInstance;
  readonly app: KvScopeInstance;
  readonly function: KvScopeInstance;
  readonly run: KvScopeInstance;
  readonly session: KvScopeInstance;
  readonly thread: KvScopeInstance;

  /**
   * The store for a client, to use outside a function (a thread handle, a
   * script) where there is no current run to take the environment and app from.
   * @param client Inngest client.
   */
  with(client: { id: string; env: string | null }): Kv;
}

/**
 * Names a scope instance's hash.
 * @param scope Scope to name.
 * @param ids Ids of the instances.
 */
export function kvHash(scope: KvScope, ids: KvScopeIds): string {
  const id = scope === "env" ? ids.env : ids[scope];
  if (!id) {
    throw new Error(
      `kv scope "${scope}" is not available here: no ${scope} id (sessions and threads come from the event's meta.sessions or data.thread).`,
    );
  }

  const parts =
    scope === "app" || scope === "function"
      ? [ids.env, ids.app, scope === "function" ? id : ""]
      : scope === "env"
        ? [ids.env]
        : [ids.env, ids.app, id];

  return `inngest:kv:${scope}:${parts.filter(Boolean).join(":")}`;
}

/**
 * The scope ids of the running function, or `undefined` outside one.
 */
function currentIds(): KvScopeIds | undefined {
  const execution = getAsyncCtxSync()?.execution;
  if (!execution) {
    return undefined;
  }

  const { ctx } = execution;
  const app = getAsyncCtxSync()?.app as { id?: string; env?: string | null };

  // `data.thread` is what agent functions are started with.
  const sessions = currentSessions(ctx);
  const thread =
    sessions.agent_thread ??
    (ctx.event?.name === "agent/message"
      ? (ctx.event.data as { thread?: string })?.thread
      : undefined);

  return {
    env: app?.env ?? "default",
    app: app?.id ?? "app",
    function: execution.functionId,
    run: ctx.runId,
    session: sessions.agent_session,
    thread,
  };
}

/**
 * Reads and writes one scope instance directly.
 * @param adapter Where values live.
 * @param scope The scope.
 * @param ids Ids of the scope instances.
 */
function handleFor(
  adapter: KvAdapter,
  scope: KvScope,
  ids: KvScopeIds,
): KvHandle {
  const hash = kvHash(scope, ids);

  return {
    async get<T>(key: string) {
      const raw = await adapter.get(hash, key);

      return raw === null ? undefined : (JSON.parse(raw) as T);
    },
    async set(key, value, options) {
      await adapter.set(
        hash,
        key,
        JSON.stringify(value ?? null),
        checkedTtl(options),
      );
    },
    async setIfAbsent(key, value, options) {
      return adapter.setIfAbsent(
        hash,
        key,
        JSON.stringify(value ?? null),
        checkedTtl(options),
      );
    },
    async delete(key) {
      await adapter.delete(hash, key);
    },
    async all<T>() {
      const raw = await adapter.all(hash);

      return Object.fromEntries(
        Object.entries(raw).map(([key, value]) => {
          return [key, JSON.parse(value) as T];
        }),
      );
    },
    async clear() {
      await adapter.clear(hash);
    },
    async indexAdd(index, member, score) {
      await adapter.indexAdd(hash, index, member, score);
    },
    async indexRange(index, options) {
      return adapter.indexRange(hash, index, options);
    },
    async indexRemove(index, member) {
      await adapter.indexRemove(hash, index, member);
    },
  };
}

function checkedTtl(options?: KvSetOptions): number | undefined {
  const ttl = options?.ttl;
  if (ttl !== undefined && !(Number.isInteger(ttl) && ttl > 0)) {
    throw new Error("kv ttl must be a whole number of seconds above zero.");
  }

  return ttl;
}

/**
 * Builds a store.
 * @param options.adapter Where values live. Default: Redis at `INNGEST_EXPERIMENTAL_KV_URL`.
 * @param options.bound Environment and app to use outside a function.
 */
export function createKv(
  options: { adapter?: KvAdapter; bound?: { env: string; app: string } } = {},
): Kv {
  let adapter = options.adapter;

  function store(): KvAdapter {
    if (!adapter) {
      const url = process.env.INNGEST_EXPERIMENTAL_KV_URL;
      if (!url) {
        throw new Error(
          "kv needs a Redis URL: set INNGEST_EXPERIMENTAL_KV_URL (redis:// or rediss://).",
        );
      }
      adapter = redisKvAdapter(url);
    }

    return adapter;
  }

  function instance(scope: KvScope, explicitId?: string): KvScopeInstance {
    // Resolved on every call: the same instance works in whichever function
    // it is called from.
    function resolve() {
      const current = currentIds();
      const ids: KvScopeIds | undefined = current ?? options.bound;
      if (!ids) {
        throw new Error(
          "kv outside a function needs a client: use kv.with(client).",
        );
      }

      const scoped: KvScopeIds = { ...ids };
      if (explicitId !== undefined) {
        scoped[scope] = explicitId;
      }

      return {
        handle: handleFor(store(), scope, scoped),
        inFunction: Boolean(current),
      };
    }

    // Inside a function each call is a step; outside it is direct.
    async function run<T>(
      op: string,
      key: string | undefined,
      fn: (handle: KvHandle) => Promise<T>,
    ) {
      const { handle, inFunction } = resolve();
      if (!inFunction) {
        return fn(handle);
      }

      return (await step.run(
        `kv.${op}:${scope}${explicitId ? `:${explicitId}` : ""}${key === undefined ? "" : `:${key}`}`,
        async () => {
          return (await fn(handle)) ?? null;
        },
      )) as T;
    }

    return {
      async get<T>(key: string) {
        return ((await run("get", key, async (h) => {
          return h.get<T>(key);
        })) ?? undefined) as T | undefined;
      },
      async set(key, value, setOptions) {
        checkedTtl(setOptions);
        await run("set", key, async (h) => {
          await h.set(key, value, setOptions);
        });
      },
      async setIfAbsent(key, value, setOptions) {
        checkedTtl(setOptions);

        return run("setIfAbsent", key, async (h) => {
          return h.setIfAbsent(key, value, setOptions);
        });
      },
      index(name) {
        return {
          async add(member, score) {
            await run("index.add", `${name}:${member}`, async (h) => {
              await h.indexAdd(name, member, score);
            });
          },
          async range(rangeOptions = {}) {
            return run("index.range", name, async (h) => {
              return h.indexRange(name, rangeOptions);
            });
          },
          async remove(member) {
            await run("index.remove", `${name}:${member}`, async (h) => {
              await h.indexRemove(name, member);
            });
          },
        };
      },
      async update<T>(key: string, fn: (current: T | undefined) => T) {
        return run("update", key, async (h) => {
          const next = fn(await h.get<T>(key));
          await h.set(key, next);

          return next;
        });
      },
      async take<T>(key: string) {
        return ((await run("take", key, async (h) => {
          const value = (await h.get<T>(key)) ?? null;
          await h.delete(key);

          return value;
        })) ?? undefined) as T | undefined;
      },
      async delete(key) {
        await run("delete", key, async (h) => {
          await h.delete(key);
        });
      },
      async all<T>() {
        return run("all", undefined, async (h) => {
          return h.all<T>();
        });
      },
      async clear() {
        await run("clear", undefined, async (h) => {
          await h.clear();
        });
      },
    };
  }

  const root = instance("run");

  return {
    ...root,
    scope: instance,
    get env() {
      return instance("env");
    },
    get app() {
      return instance("app");
    },
    get function() {
      return instance("function");
    },
    get run() {
      return instance("run");
    },
    get session() {
      return instance("session");
    },
    get thread() {
      return instance("thread");
    },
    with(client) {
      return createKv({
        adapter: store(),
        bound: { env: client.env ?? "default", app: client.id },
      });
    },
  };
}

/**
 * The default store, backed by Redis at `INNGEST_EXPERIMENTAL_KV_URL`.
 */
export const kv: Kv = createKv();
