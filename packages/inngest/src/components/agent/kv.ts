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
 * Run-scoped keys are removed by `kv.clearRun()`, which the agent function
 * calls on every way a run can end.
 */

import { reduceEventsToPropagatedSessions } from "../../helpers/sessions.ts";
import { getAsyncCtxSync } from "../execution/als.ts";
import { step } from "../InngestStepTools.ts";
import { connectRedis, type RedisClient } from "./redis.ts";

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
  let connection: Promise<RedisClient> | undefined;

  function client() {
    connection ??= connectRedis(url);

    return connection;
  }

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

export interface KvOptions {
  /**
   * Which scope to use. Default `"run"`.
   */
  scope?: KvScope;
}

/**
 * The ids that name each scope instance.
 */
export interface KvScopeIds {
  env: string;
  app: string;
  function?: string;
  run?: string;
  session?: string;
  thread?: string;
}

/**
 * One scope instance, read and written directly (never as steps).
 */
export interface KvHandle {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  all<T = unknown>(): Promise<Record<string, T>>;
  clear(): Promise<void>;
}

export interface Kv {
  get<T = unknown>(key: string, opts?: KvOptions): Promise<T | undefined>;
  set(key: string, value: unknown, opts?: KvOptions): Promise<void>;

  /**
   * Reads, transforms and writes a key in one step. Not atomic across runs.
   */
  update<T = unknown>(
    key: string,
    fn: (current: T | undefined) => T,
    opts?: KvOptions,
  ): Promise<T>;
  delete(key: string, opts?: KvOptions): Promise<void>;
  all<T = unknown>(opts?: KvOptions): Promise<Record<string, T>>;

  /**
   * Removes every run-scoped key of the current run.
   */
  clearRun(): Promise<void>;

  /**
   * A direct handle to a scope instance, for use outside functions. `ids`
   * names the instance; fill in the one `scope` needs.
   */
  at(scope: KvScope, ids: KvScopeIds): KvHandle;
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
      `kv scope "${scope}" is not available here: no ${scope} id (sessions and threads come from the event's meta.sessions).`,
    );
  }

  const parts =
    scope === "app" || scope === "function"
      ? [ids.env, ids.app, scope === "function" ? id : ""]
      : [ids.env, id];

  return `inngest:kv:${scope}:${parts.filter(Boolean).join(":")}`;
}

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
      await adapter.set(hash, key, JSON.stringify(value));
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
 * Builds a store.
 * @param options.adapter Where values live. Default: Redis at `INNGEST_EXPERIMENTAL_KV_URL`.
 */
export function createKv(options: { adapter?: KvAdapter } = {}): Kv {
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

  function target(opts: KvOptions | undefined) {
    const ids = currentIds();
    if (!ids) {
      throw new Error(
        "kv.get/set/update/delete/all run inside a function; use kv.at() elsewhere.",
      );
    }
    const scope = opts?.scope ?? "run";

    return { scope, handle: handleFor(store(), scope, ids) };
  }

  return {
    async get<T>(key: string, opts?: KvOptions) {
      const { scope, handle } = target(opts);

      return step.run(`kv.get:${scope}:${key}`, async () => {
        return (await handle.get<T>(key)) ?? null;
      }) as Promise<T | undefined>;
    },
    async set(key, value, opts) {
      const { scope, handle } = target(opts);
      await step.run(`kv.set:${scope}:${key}`, async () => {
        await handle.set(key, value);
      });
    },
    async update<T>(
      key: string,
      fn: (current: T | undefined) => T,
      opts?: KvOptions,
    ) {
      const { scope, handle } = target(opts);

      return (await step.run(`kv.update:${scope}:${key}`, async () => {
        const next = fn(await handle.get<T>(key));
        await handle.set(key, next);

        return next;
      })) as T;
    },
    async delete(key, opts) {
      const { scope, handle } = target(opts);
      await step.run(`kv.delete:${scope}:${key}`, async () => {
        await handle.delete(key);
      });
    },
    async all<T>(opts?: KvOptions) {
      const { scope, handle } = target(opts);

      return (await step.run(`kv.all:${scope}`, async () => {
        return handle.all<T>();
      })) as Record<string, T>;
    },
    async clearRun() {
      const { handle } = target({ scope: "run" });
      await step.run("kv.clearRun", async () => {
        await handle.clear();
      });
    },
    at(scope, ids) {
      return handleFor(store(), scope, ids);
    },
  };
}

/**
 * The default store, backed by Redis at `INNGEST_EXPERIMENTAL_KV_URL`.
 */
export const kv: Kv = createKv();
