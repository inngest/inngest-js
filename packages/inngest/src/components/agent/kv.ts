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

import { reduceEventsToPropagatedSessions } from "../../helpers/sessions.ts";
import { getAsyncCtxSync } from "../execution/als.ts";
import { step } from "../InngestStepTools.ts";
import { redisConnection } from "./redis.ts";

export type KvScope = "env" | "app" | "function" | "run" | "session" | "thread";

/**
 * Where values are stored. Each scope instance is one hash, so removing a
 * whole scope (a finished run) is one call.
 */
export interface KvAdapter {
  get(hash: string, field: string): Promise<string | null>;
  set(hash: string, field: string, value: string): Promise<void>;
  delete(hash: string, field: string): Promise<void>;
  all(hash: string): Promise<Record<string, string>>;
  clear(hash: string): Promise<void>;
}

/**
 * An in-process adapter, for tests and local scripts.
 */
export function memoryKvAdapter(): KvAdapter {
  const hashes = new Map<string, Map<string, string>>();

  function hashOf(hash: string) {
    let found = hashes.get(hash);
    if (!found) {
      found = new Map();
      hashes.set(hash, found);
    }

    return found;
  }

  return {
    async get(hash, field) {
      return hashOf(hash).get(field) ?? null;
    },
    async set(hash, field, value) {
      hashOf(hash).set(field, value);
    },
    async delete(hash, field) {
      hashOf(hash).delete(field);
    },
    async all(hash) {
      return Object.fromEntries(hashOf(hash));
    },
    async clear(hash) {
      hashes.delete(hash);
    },
  };
}

/**
 * A Redis adapter that connects on first use.
 * @param url `redis://` or `rediss://` URL.
 */
export function redisKvAdapter(url: string): KvAdapter {
  const client = redisConnection(url);

  return {
    async get(hash, field) {
      const reply = await (await client()).command("HGET", hash, field);

      return reply as string | null;
    },
    async set(hash, field, value) {
      await (await client()).command("HSET", hash, field, value);
    },
    async delete(hash, field) {
      await (await client()).command("HDEL", hash, field);
    },
    async all(hash) {
      const reply = (await (
        await client()
      ).command("HGETALL", hash)) as string[];
      const out: Record<string, string> = {};
      for (let i = 0; i < reply.length; i += 2) {
        out[reply[i] as string] = reply[i + 1] as string;
      }

      return out;
    },
    async clear(hash) {
      await (await client()).command("DEL", hash);
    },
  };
}

export interface KvHandle {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  all<T = unknown>(): Promise<Record<string, T>>;
  clear(): Promise<void>;
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
  set(key: string, value: unknown): Promise<void>;

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

  const { ctx, instance } = execution;
  const app = getAsyncCtxSync()?.app as { id?: string; env?: string | null };

  // `ctx.sessions` is only set while session propagation is on, so read the
  // trigger events too. `data.thread` is what agent functions are started with.
  const sessions = {
    ...reduceEventsToPropagatedSessions(ctx.events ?? [ctx.event]),
    ...ctx.sessions,
  };
  const thread =
    sessions.agent_thread ?? (ctx.event?.data as { thread?: string })?.thread;

  return {
    env: app?.env ?? "default",
    app: app?.id ?? "app",
    // The execution keeps its options protected; the function ID is all we
    // need from them.
    function: (
      instance as unknown as { options?: { fn?: { id(): string } } }
    ).options?.fn?.id(),
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
    async set(key, value) {
      await adapter.set(hash, key, JSON.stringify(value ?? null));
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
  };
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
        return ((await run("get", key, (h) => h.get<T>(key))) ?? undefined) as
          | T
          | undefined;
      },
      async set(key, value) {
        await run("set", key, async (h) => {
          await h.set(key, value);
        });
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
        return run("all", undefined, (h) => h.all<T>());
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
