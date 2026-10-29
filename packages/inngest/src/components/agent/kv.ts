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
 *
 * Keys are plain names (values are `unknown`) or typed `kvKey`s, which carry
 * their value type and can validate it with a schema.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { getAsyncCtxSync } from "../execution/als.ts";
import { STEP_INDEXING_SUFFIX, step } from "../InngestStepTools.ts";
import { NonRetriableError } from "../NonRetriableError.ts";
import { nextCount } from "./executionCounter.ts";
import { redisConnection } from "./redis.ts";
import { currentSessions } from "./sessions.ts";

/**
 * How long a value lives and who sees it: `env` (the whole environment),
 * `app`, `function`, `run` (the default), `session` and `thread`.
 */
export type KvScope = "env" | "app" | "function" | "run" | "session" | "thread";

/**
 * Where values are stored. Each scope instance is one hash, so removing a
 * whole scope (a finished run) is one call.
 *
 * Three stores ship: Redis (`redisKvAdapter`, the default), Cloudflare D1
 * (`d1KvAdapter`) and memory (`memoryKvAdapter`, for tests). Give an app its
 * store with `createAgents(client, { store })`.
 *
 * What a store must guarantee:
 *
 * - `setIfAbsent` is atomic across callers: of two racing calls exactly one
 *   writes. Redis does it with `SET NX`, D1 with one upsert statement, memory
 *   by running on one thread.
 * - A field past its `ttl` reads as absent, and `setIfAbsent` may take it over.
 * - A single write (`set`, `delete`, `indexAdd`, `indexRemove`) takes effect
 *   whole or not at all.
 * - Nothing spans two calls. A read followed by a write is not atomic, so the
 *   KV's `update` can lose an update when two runs update one key at once, on
 *   every store.
 */
export interface KvAdapter {
  get(hash: string, field: string): Promise<string | null>;

  /**
   * @param ttl Seconds until the field expires. Absent: it never does.
   */
  set(hash: string, field: string, value: string, ttl?: number): Promise<void>;

  /**
   * Writes only when the field has no live value, and returns whether this
   * call holds it: `true` when it wrote, and also when the field already holds
   * exactly `value` (the same call retried after its write).
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
/**
 * The store interface the KV, thread state and indexes sit on.
 */
export type KvStore = KvAdapter;

export interface KvIndexEntry {
  /**
   * The member, for example an id.
   */
  member: string;

  /**
   * What the member is sorted by.
   */
  score: number;
}

/**
 * Which members of a sorted index to return, and in what order.
 */
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

interface MemoryField {
  value: string;
  expiresAt?: number;
}

interface MemoryHash {
  fields: Map<string, MemoryField>;
  indexes: Map<string, Map<string, number>>;
}

/**
 * An in-process adapter, for tests and local scripts.
 */
export function memoryKvAdapter(): KvAdapter {
  const hashes = new Map<string, MemoryHash>();

  function hashOf(hash: string) {
    let found = hashes.get(hash);
    if (!found) {
      found = { fields: new Map(), indexes: new Map() };
      hashes.set(hash, found);
    }

    return found;
  }

  // Drops the field once its time is up, so every read gives the same answer.
  function live(hash: string, field: string) {
    const found = hashes.get(hash)?.fields.get(field);
    if (found?.expiresAt !== undefined && found.expiresAt <= Date.now()) {
      hashes.get(hash)?.fields.delete(field);

      return undefined;
    }

    return found;
  }

  function write(hash: string, field: string, value: string, ttl?: number) {
    hashOf(hash).fields.set(field, {
      value,
      expiresAt: ttl === undefined ? undefined : Date.now() + ttl * 1000,
    });
  }

  return {
    async get(hash, field) {
      return live(hash, field)?.value ?? null;
    },
    async set(hash, field, value, ttl) {
      write(hash, field, value, ttl);
    },
    async setIfAbsent(hash, field, value, ttl) {
      const found = live(hash, field);
      if (found) {
        return found.value === value;
      }

      write(hash, field, value, ttl);

      return true;
    },
    async delete(hash, field) {
      hashes.get(hash)?.fields.delete(field);
    },
    async all(hash) {
      const out: Record<string, string> = {};
      for (const field of [...(hashes.get(hash)?.fields.keys() ?? [])]) {
        const found = live(hash, field);
        if (found) {
          out[field] = found.value;
        }
      }

      return out;
    },
    async clear(hash) {
      hashes.delete(hash);
    },
    async indexAdd(hash, index, member, score) {
      const { indexes } = hashOf(hash);
      const found = indexes.get(index) ?? new Map<string, number>();
      found.set(member, score);
      indexes.set(index, found);
    },
    async indexRange(hash, index, options) {
      const entries = [...(hashes.get(hash)?.indexes.get(index) ?? [])]
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
      hashes.get(hash)?.indexes.get(index)?.delete(member);
    },
  };
}

/**
 * A Redis adapter that connects on first use. Needs Redis 6.2 or newer.
 *
 * Plain fields live in one hash. Fields with a time to live are string keys
 * (older servers cannot expire a hash field) and each index is a sorted set.
 * Every key of a scope instance carries the hash in `{braces}`, so they share
 * a cluster slot and one scope instance can be read or removed in one go.
 * @param url `redis://` or `rediss://` URL.
 */
export function redisKvAdapter(url: string): KvAdapter {
  const client = redisConnection(url);
  const removeBatch = 500;

  function main(hash: string) {
    return `{${hash}}`;
  }

  function expiring(hash: string, field: string) {
    return `{${hash}}|t|${field}`;
  }

  function sorted(hash: string, index: string) {
    return `{${hash}}|z|${index}`;
  }

  // Lists the expiring fields and indexes of a hash, so `all()` and `clear()`
  // touch only that hash. Entries are `t:<field>` or `z:<index>`, scored by
  // when the entry may be forgotten (never, for an index).
  function registry(hash: string) {
    return `{${hash}}|keys`;
  }

  async function command(...args: string[]) {
    return (await client()).command(...args);
  }

  async function transaction(commands: string[][]) {
    return (await client()).transaction(commands);
  }

  // Redis's own clock, so a host with a skewed clock cannot mis-score entries.
  async function serverNow() {
    const [seconds, micros] = (await command("TIME")) as [string, string];

    return Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
  }

  async function register(hash: string, entry: string, ttl?: number) {
    const now = await serverNow();
    const until = ttl === undefined ? "+inf" : String(now + ttl * 1000);

    // GT: a later write with a shorter life never lowers the score.
    await command("ZADD", registry(hash), "GT", until, entry);
    await command("ZREMRANGEBYSCORE", registry(hash), "-inf", String(now));
  }

  async function members(hash: string) {
    return (await command(
      "ZRANGEBYSCORE",
      registry(hash),
      String(await serverNow()),
      "+inf",
    )) as string[];
  }

  return {
    async get(hash, field) {
      // One block, so a field moving between the two forms is never missed.
      const [stored, timed] = (await transaction([
        ["HGET", main(hash), field],
        ["GET", expiring(hash, field)],
      ])) as [string | null, string | null];

      return stored ?? timed;
    },
    async set(hash, field, value, ttl) {
      if (ttl === undefined) {
        // One block, so a reader never sees the field in neither form.
        await transaction([
          ["DEL", expiring(hash, field)],
          ["HSET", main(hash), field, value],
        ]);

        return;
      }

      // Listed before the write in case the process dies in between, and
      // after it so the entry cannot end before the key does.
      await register(hash, `t:${field}`, ttl);
      await transaction([
        ["HDEL", main(hash), field],
        ["SET", expiring(hash, field), value, "EX", String(ttl)],
      ]);
      await register(hash, `t:${field}`, ttl);
    },
    async setIfAbsent(hash, field, value, ttl) {
      const stored = (await command("HGET", main(hash), field)) as
        | string
        | null;
      if (stored !== null) {
        return stored === value;
      }

      // A holder that vanishes between our failed write and our read leaves
      // the key free, so the claim is tried once more.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (ttl === undefined) {
          const live = (await command("GET", expiring(hash, field))) as
            | string
            | null;
          if (live !== null) {
            return live === value;
          }

          if ((await command("HSETNX", main(hash), field, value)) === 1) {
            return true;
          }

          const current = await command("HGET", main(hash), field);
          if (current !== null) {
            return current === value;
          }

          continue;
        }

        // Not listed before the claim: a lost claim must not list the winner's
        // key under this call's score. A crash before listing is repaired by the
        // retry, which finds its own value and lists it.
        const claimed = await command(
          "SET",
          expiring(hash, field),
          value,
          "EX",
          String(ttl),
          "NX",
        );
        const current =
          claimed === "OK"
            ? value
            : await command("GET", expiring(hash, field));
        if (current === value) {
          // Also on a retry, which may have died before listing the key.
          await register(hash, `t:${field}`, ttl);

          return true;
        }
        if (current !== null) {
          return false;
        }
      }

      return false;
    },
    async delete(hash, field) {
      await command("HDEL", main(hash), field);
      await command("DEL", expiring(hash, field));
      await command("ZREM", registry(hash), `t:${field}`);
    },
    async all(hash) {
      const reply = (await command("HGETALL", main(hash))) as string[];
      const out: Record<string, string> = {};
      for (let i = 0; i < reply.length; i += 2) {
        out[reply[i] as string] = reply[i + 1] as string;
      }

      const fields = (await members(hash))
        .filter((entry) => {
          return entry.startsWith("t:");
        })
        .map((entry) => {
          return entry.slice(2);
        });
      if (fields.length > 0) {
        const values = (await command(
          "MGET",
          ...fields.map((field) => {
            return expiring(hash, field);
          }),
        )) as (string | null)[];
        fields.forEach((field, i) => {
          const value = values[i];
          // The hash wins, as in get().
          if (value !== null && value !== undefined && !(field in out)) {
            out[field] = value;
          }
        });
      }

      return out;
    },
    async clear(hash) {
      const keys = (await members(hash)).map((entry) => {
        return entry.startsWith("t:")
          ? expiring(hash, entry.slice(2))
          : sorted(hash, entry.slice(2));
      });

      // The hash and registry go last, so a failed clear can be run again.
      for (let i = 0; i < keys.length; i += removeBatch) {
        await command("DEL", ...keys.slice(i, i + removeBatch));
      }
      await command("DEL", registry(hash), main(hash));
    },
    async indexAdd(hash, index, member, score) {
      // Listed before the write in case the process dies in between, and
      // after it so a racing removal that unlisted the index cannot win.
      await register(hash, `z:${index}`);
      await command("ZADD", sorted(hash, index), String(score), member);
      await register(hash, `z:${index}`);
    },
    async indexRange(hash, index, options) {
      const low = options.min === undefined ? "-inf" : String(options.min);
      const high = options.max === undefined ? "+inf" : String(options.max);
      const args =
        options.order === "desc"
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

      // An index with no members is gone from Redis; forget its entry too.
      if ((await command("ZCARD", sorted(hash, index))) === 0) {
        await command("ZREM", registry(hash), `z:${index}`);

        // An add that raced the removal is listed again.
        if ((await command("ZCARD", sorted(hash, index))) !== 0) {
          await register(hash, `z:${index}`);
        }
      }
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

/**
 * A key of a scope instance that carries the type of its value. Make one with
 * `kvKey`: with a schema the value is validated on every read; without one
 * you vouch for the type.
 */
export interface KvKey<T> {
  /**
   * The key's name in the store.
   */
  readonly name: string;

  /**
   * Validates what is read. Absent: the stored value is trusted as `T`.
   */
  readonly schema?: StandardSchemaV1<unknown, T>;

  /**
   * Never set; carries `T` for inference.
   */
  readonly "~type"?: T;
}

/**
 * Anything JSON can carry. It is the default value type of `KvWrite`; plain-name
 * writes are checked with `KvJsonSafe`, so interfaces pass.
 */
export type KvJson =
  | string
  | number
  | boolean
  | null
  | readonly KvJson[]
  | { [key: string]: KvJson | undefined };

/**
 * Types JSON cannot carry: they come back changed, or fail to store.
 */
type KvNonJson =
  | bigint
  | symbol
  | undefined
  | ((...args: never[]) => unknown)
  | Date
  | RegExp
  | Map<never, never>
  | Set<never>
  | Promise<unknown>;

/**
 * `T` with every part JSON cannot carry (a `Date`, `Map`, bigint or function)
 * turned into `never`. A type is JSON-safe when it is assignable to its own
 * `KvJsonSafe`. Interfaces and branded primitives pass. An object property may be
 * `undefined` or optional (JSON drops it); a top-level or array `undefined`
 * does not pass.
 */
export type KvJsonSafe<T> = T extends string | number | boolean | null
  ? T
  : T extends KvNonJson
    ? never
    : T extends readonly (infer U)[]
      ? readonly KvJsonSafe<U>[]
      : T extends object
        ? { [P in keyof T]: KvJsonProp<T[P]> }
        : T;

/**
 * A property of a JSON-safe object. It may be `undefined` or optional, which
 * JSON drops on write; at the top level or in an array it may not be.
 */
type KvJsonProp<V> = [undefined] extends [V]
  ? KvJsonSafe<Exclude<V, undefined>> | undefined
  : KvJsonSafe<V>;

/**
 * What `kvKey<T>(name)` returns: a `KvKey<T>` when `T` is JSON-safe, otherwise
 * a type that names the problem, so the first use of the key is refused.
 */
export type KvKeyOf<T> = [T] extends [KvJsonSafe<T>]
  ? KvKey<T>
  : KvValueMustBeJson;

/**
 * Marks a value type refused by `kvKey`.
 */
export interface KvValueMustBeJson {
  "kv values are stored as JSON: no Date, Map, Set, bigint, symbol or function": never;
}

/**
 * A key as scope instance methods take it: a plain name (values are
 * `unknown`) or a typed `KvKey`.
 */
export type KvKeyInput = string | KvKey<unknown>;

/**
 * The value type of a key: `T` for a `KvKey<T>`, `unknown` for a plain name.
 */
export type KvValue<K extends KvKeyInput> = [K] extends [KvKey<infer T>]
  ? T
  : unknown;

/**
 * What `update` returns: the key's type, or the value type the callback gave
 * for a plain name.
 */
export type KvResult<K extends KvKeyInput, V> = [K] extends [KvKey<infer T>]
  ? T
  : V;

/**
 * What a write to a key takes: `T` for a `KvKey<T>`, for a plain name any value
 * whose type is JSON-safe (checked deeply, so interfaces pass).
 */
export type KvWrite<K extends KvKeyInput, V = KvJson> = [K] extends [
  KvKey<infer T>,
]
  ? T
  : V & KvJsonCheck<V>;

/**
 * `unknown` (no constraint) when `V` is JSON-safe, otherwise a type that
 * names the rule.
 */
export type KvJsonCheck<V> = [V] extends [KvJsonSafe<V>]
  ? unknown
  : KvValueMustBeJson;

/**
 * What a `kvKey` schema must satisfy: its input and output types match, so
 * the value read back is the value that was stored. A schema that does not
 * (a transform, default or coercion) fails with this type in the message.
 */
export type KvRoundTrips<S extends StandardSchemaV1> = [
  StandardSchemaV1.InferInput<S>,
] extends [StandardSchemaV1.InferOutput<S>]
  ? [StandardSchemaV1.InferOutput<S>] extends [StandardSchemaV1.InferInput<S>]
    ? [StandardSchemaV1.InferOutput<S>] extends [
        KvJsonSafe<StandardSchemaV1.InferOutput<S>>,
      ]
      ? unknown
      : KvSchemaMustRoundTrip
    : KvSchemaMustRoundTrip
  : KvSchemaMustRoundTrip;

/**
 * Marks a schema refused by `kvKey`.
 */
export interface KvSchemaMustRoundTrip {
  "kvKey schema: input and output types must match and be JSON (no transforms, defaults, coercion, Date or Map)": never;
}

/**
 * Names a key and types its value.
 *
 * @example
 * ```ts
 * const plan = kvKey("plan", z.object({ steps: z.number() }));
 * await kv.thread.set(plan, { steps: 3 });
 * const found = await kv.thread.get(plan); // { steps: number } | undefined
 * ```
 * Values are stored as JSON, so use JSON-representable types only: a
 * `z.date()` or a `Map` fails the check when read back, and a bigint throws
 * when written.
 * @param name The key's name in the store.
 * @param schema Validates the value on every read; a value that fails throws
 * an error naming the key. Its input and output types must be the same (no
 * transforms or defaults), because the value is stored as JSON and checked
 * as stored. Writes are not validated. Without a schema the type is yours to
 * vouch for.
 */
export function kvKey<T>(name: string): KvKeyOf<T>;
export function kvKey<S extends StandardSchemaV1>(
  name: string,
  schema: S & KvRoundTrips<S>,
): KvKey<StandardSchemaV1.InferOutput<S>>;
export function kvKey(name: string, schema?: StandardSchemaV1): KvKey<unknown> {
  return { name, schema };
}

/**
 * The name of a key given as a name or a `KvKey`.
 * @param key The key.
 */
function nameOf(key: KvKeyInput): string {
  return typeof key === "string" ? key : key.name;
}

/**
 * Turns a stored value into what a key promises: the value as stored for a
 * plain name or a key without a schema, the schema's output otherwise.
 * @param key The key read.
 * @param raw The stored value, or `undefined` when the key has none.
 */
async function decode<K extends KvKeyInput>(
  key: K,
  raw: unknown,
): Promise<KvValue<K> | undefined> {
  const schema = typeof key === "string" ? undefined : key.schema;
  if (raw === undefined || !schema) {
    // A missing value, a plain name (typed `unknown`) or a key whose type the
    // caller vouches for: nothing to check.
    return raw as KvValue<K> | undefined;
  }

  const result = await schema["~standard"].validate(raw);
  if (result.issues) {
    const issue = result.issues[0]?.message ?? "invalid value";
    throw new NonRetriableError(
      `kv key "${nameOf(key)}" holds a value that fails its schema: ${issue}`,
    );
  }

  return result.value as KvValue<K>;
}

/**
 * A read as a step result: tells a missing key from a stored `null`. The
 * marker key keeps the shape apart from any value a user stored.
 */
interface KvRead {
  "~kvRead": true;
  found: boolean;
  value?: unknown;

  /**
   * The schema failure message, when the stored value did not pass.
   */
  invalid?: string;
}

/**
 * An update as a step result.
 */
interface KvUpdate {
  "~kvUpdate": true;
  value?: unknown;

  /**
   * The schema failure message, when the stored value did not pass.
   */
  invalid?: string;
}

/**
 * Wraps a stored value as a step result.
 * @param value The stored value, or `undefined` when the key has none.
 */
function found(value: unknown): KvRead {
  return value === undefined
    ? { "~kvRead": true, found: false }
    : { "~kvRead": true, found: true, value };
}

/**
 * Reads a memoized read step. A run that started before the result was
 * wrapped replays the old memo: `null` meant no value, and anything else was
 * the value itself.
 * @param memo What the step returned or replayed.
 */
function unwrapRead(memo: unknown): unknown {
  if (memo === null || memo === undefined) {
    return undefined;
  }

  if (
    typeof memo === "object" &&
    !Array.isArray(memo) &&
    (memo as Partial<KvRead>)["~kvRead"] === true &&
    typeof (memo as Partial<KvRead>).found === "boolean"
  ) {
    const read = memo as KvRead;
    if (read.invalid !== undefined) {
      throw new NonRetriableError(read.invalid);
    }

    return read.found ? read.value : undefined;
  }

  return memo;
}

/**
 * Reads a memoized update step. An older run replays the raw value the step
 * returned.
 * @param memo What the step returned or replayed.
 */
function unwrapUpdate(memo: unknown): unknown {
  if (
    typeof memo === "object" &&
    memo !== null &&
    !Array.isArray(memo) &&
    (memo as Partial<KvUpdate>)["~kvUpdate"] === true
  ) {
    const update = memo as KvUpdate;
    if (update.invalid !== undefined) {
      throw new NonRetriableError(update.invalid);
    }

    return update.value;
  }

  return memo;
}

/**
 * Decodes inside a step: a schema failure comes back as a message, so the
 * caller can throw it outside the step, where it is not retried.
 * @param key The key read.
 * @param raw The stored value.
 */
async function tryDecode<K extends KvKeyInput>(
  key: K,
  raw: unknown,
): Promise<
  { ok: true; value: KvValue<K> | undefined } | { ok: false; invalid: string }
> {
  try {
    return { ok: true, value: await decode(key, raw) };
  } catch (error) {
    if (error instanceof NonRetriableError) {
      return { ok: false, invalid: error.message };
    }

    throw error;
  }
}

/**
 * Reads and writes one scope instance directly, with values as JSON.
 */
interface RawKv {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, options?: KvSetOptions): Promise<void>;
  setIfAbsent(
    key: string,
    value: unknown,
    options?: KvSetOptions,
  ): Promise<boolean>;
  delete(key: string): Promise<void>;
  all(): Promise<Record<string, unknown>>;
  clear(): Promise<void>;
  indexAdd(index: string, member: string, score: number): Promise<void>;
  indexRange(index: string, options: KvIndexRange): Promise<KvIndexEntry[]>;
  indexRemove(index: string, member: string): Promise<void>;
}

/**
 * The ids that name a scope instance.
 */
export interface KvScopeIds {
  /**
   * Environment ID.
   */
  env: string;

  /**
   * App ID.
   */
  app: string;

  /**
   * Function ID, for the `function` scope.
   */
  function?: string;

  /**
   * Run ID, for the `run` scope.
   */
  run?: string;

  /**
   * Session ID, for the `session` scope.
   */
  session?: string;

  /**
   * Thread key, for the `thread` scope.
   */
  thread?: string;
}

/**
 * One scope instance: the keys of a run, a thread and so on. Inside a function
 * every call is a memoized step; outside one it goes straight to the store.
 */
export interface KvScopeInstance {
  /**
   * Reads a key: `undefined` when it has no value. A `KvKey` gives its
   * type (checked against its schema, if it has one); a plain name gives
   * `unknown`.
   * @param key Name or typed key.
   */
  get<K extends KvKeyInput>(key: K): Promise<KvValue<K> | undefined>;

  /**
   * Writes a key. With `{ ttl }` it expires that many seconds later.
   * @param key Name or typed key.
   * @param value The value, JSON-serializable.
   * @param options Expiry.
   */
  set<K extends KvKeyInput, V = KvValue<K>>(
    key: K,
    value: KvWrite<K, V>,
    options?: KvSetOptions,
  ): Promise<void>;

  /**
   * Writes a key only when it has no value, and returns whether this call
   * holds it: the first caller gets `true`, later ones `false` until the key
   * expires or is deleted. Atomic against other `setIfAbsent` calls. A call
   * retried after its own write also gets `true`, because the key already
   * holds exactly its value; put an owner token (such as the run id) in the
   * value so a different caller never matches. Use one style per key: a
   * concurrent `set`, or a claim with and without a `ttl`, is not arbitrated.
   *
   * @example
   * ```ts
   * // Only the first run to ask owns the card; a retry of that run still does.
   * const owns = await kv.env.setIfAbsent(`card:${id}`, runId, { ttl: 600 });
   * ```
   */
  setIfAbsent<K extends KvKeyInput, V = KvValue<K>>(
    key: K,
    value: KvWrite<K, V>,
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
   * A stored value that fails its key's schema is a `NonRetriableError`, as
   * for `get`, and nothing is written.
   * The result never expires, even if the key had a `ttl`: pass nothing to
   * `set` yourself if you need the expiry kept.
   */
  update<K extends KvKeyInput, V = KvValue<K>>(
    key: K,
    fn: (current: KvValue<K> | undefined) => KvWrite<K, V>,
  ): Promise<KvResult<K, V>>;

  /**
   * Reads a key and deletes it in one step. Use it for flags consumed once.
   * A value that fails its key's schema is checked before it is removed, so it
   * stays readable. The failure is a `NonRetriableError`, as for `get`.
   * @param key Name or typed key.
   */
  take<K extends KvKeyInput>(key: K): Promise<KvValue<K> | undefined>;

  /**
   * Removes a key.
   * @param key Name or typed key.
   */
  delete(key: KvKeyInput): Promise<void>;

  /**
   * Every key of the scope instance with its value, as stored (`unknown`).
   */
  all(): Promise<Record<string, unknown>>;

  /**
   * Removes every key of the scope instance.
   */
  clear(): Promise<void>;
}

/**
 * The store: the current run's scope instance, plus every other scope.
 */
export interface Kv extends KvScopeInstance {
  /**
   * A scope instance. Without `id` it is the current function's (the run, or
   * the thread or session the run belongs to); with one it is that instance.
   * @param scope The scope.
   * @param id The instance, for example a thread key.
   */
  scope(scope: KvScope, id?: string): KvScopeInstance;

  /**
   * Shared by every app of the environment.
   */
  readonly env: KvScopeInstance;

  /**
   * Shared by every function of the app.
   */
  readonly app: KvScopeInstance;

  /**
   * Shared by every run of the current function.
   */
  readonly function: KvScopeInstance;

  /**
   * The current run's own keys, removed when it ends.
   */
  readonly run: KvScopeInstance;

  /**
   * The current session's keys.
   */
  readonly session: KvScopeInstance;

  /**
   * The current thread's keys, kept across the runs of an agent thread.
   */
  readonly thread: KvScopeInstance;

  /**
   * The store for a client, to use outside a function (a thread handle, a
   * script) where there is no current run to take the environment and app from.
   * @param client Inngest client.
   */
  with(client: { id: string; env: string | null }): Kv;
}

/**
 * Escapes the characters that separate or tag parts of a stored key, so
 * different ids never name the same key.
 * @param id Environment, app or scope id.
 */
function encodeId(id: string): string {
  return id.replace(/[%:|{}]/g, (char) => {
    return `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
  });
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

  return `inngest:kv:${scope}:${parts.filter(Boolean).map(encodeId).join(":")}`;
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

  // A run started by `agent.invoke()` or by an event of `on` is told its
  // thread and session by the agent function; `data.thread` is what a message
  // starts an agent function with.
  const sessions = currentSessions(ctx);
  const agent = execution.agent;
  const thread =
    agent?.thread ??
    sessions.agent_thread ??
    (ctx.event?.name === "agent/message"
      ? (ctx.event.data as { thread?: string })?.thread
      : undefined);

  return {
    env: app?.env ?? "default",
    app: app?.id ?? "app",
    function: execution.functionId,
    run: ctx.runId,
    session: agent?.session ?? sessions.agent_session,
    thread,
  };
}

/**
 * Reads and writes one scope instance directly.
 * @param adapter Where values live.
 * @param scope The scope.
 * @param ids Ids of the scope instances.
 */
function handleFor(adapter: KvAdapter, scope: KvScope, ids: KvScopeIds): RawKv {
  const hash = kvHash(scope, ids);

  return {
    async get(key) {
      const raw = await adapter.get(hash, key);

      return raw === null ? undefined : JSON.parse(raw);
    },
    async set(key, value, options) {
      await adapter.set(
        hash,
        key,
        JSON.stringify(checkedValue(value)),
        checkedTtl(options),
      );
    },
    async setIfAbsent(key, value, options) {
      return adapter.setIfAbsent(
        hash,
        key,
        JSON.stringify(checkedValue(value)),
        checkedTtl(options),
      );
    },
    async delete(key) {
      await adapter.delete(hash, key);
    },
    async all() {
      const raw = await adapter.all(hash);

      return Object.fromEntries(
        Object.entries(raw).map(([key, value]) => {
          return [key, JSON.parse(value)];
        }),
      );
    },
    async clear() {
      await adapter.clear(hash);
    },
    async indexAdd(index, member, score) {
      checkedScore(score);
      await adapter.indexAdd(hash, index, member, score);
    },
    async indexRange(index, options) {
      checkedRange(options);

      return adapter.indexRange(hash, index, options);
    },
    async indexRemove(index, member) {
      await adapter.indexRemove(hash, index, member);
    },
  };
}

function checkedMember(member: string) {
  if (typeof member !== "string") {
    throw new Error("kv index members must be strings.");
  }
}

function checkedScore(score: number) {
  if (!Number.isFinite(score)) {
    throw new Error("kv index scores must be finite numbers.");
  }
}

function checkedRange(options: KvIndexRange) {
  const { limit, min, max } = options;
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 0)) {
    throw new Error("kv index limit must be a whole number, zero or more.");
  }
  if (
    options.order !== undefined &&
    options.order !== "asc" &&
    options.order !== "desc"
  ) {
    throw new Error('kv index order must be "asc" or "desc".');
  }
  for (const bound of [min, max]) {
    if (
      bound !== undefined &&
      (typeof bound !== "number" || Number.isNaN(bound))
    ) {
      throw new Error("kv index min and max must be numbers.");
    }
  }
}

/**
 * Refuses `undefined`, which JSON cannot store: it would read back as
 * `null`. `set` and `setIfAbsent` call it before the step so a bad call fails
 * at once instead of retrying; `update` meets it inside the step.
 * @param value The value to write.
 */
function checkedValue(value: unknown): unknown {
  if (value === undefined) {
    throw new Error(
      "kv values cannot be undefined: store null, or delete the key.",
    );
  }

  return value;
}

function checkedTtl(options?: KvSetOptions): number | undefined {
  const ttl = options?.ttl;
  if (
    ttl !== undefined &&
    !(Number.isInteger(ttl) && ttl > 0 && ttl <= 2 ** 31)
  ) {
    throw new Error(
      "kv ttl must be a whole number of seconds, above zero and at most 2147483648.",
    );
  }

  return ttl;
}

const appStores = new Map<string, KvAdapter>();

/**
 * Sets the store the KV of an app uses, unless a KV was built with its own.
 * `createAgents(client, { store })` calls it.
 * @param app The app ID of the client.
 * @param store The store.
 */
export function setAppKvStore(app: string, store: KvAdapter): void {
  appStores.set(app, store);
}

/**
 * Builds a store.
 * @param options.adapter Where values live. Default: Redis at `INNGEST_EXPERIMENTAL_KV_URL`.
 * @param options.bound Environment and app to use outside a function.
 */
export function createKv(
  options: { adapter?: KvAdapter; bound?: { env: string; app: string } } = {},
): Kv {
  let fromEnv: KvAdapter | undefined;

  // The store of an app: the one this KV was built with, else the one the app
  // gave `createAgents`, else Redis at the environment's URL.
  function store(app?: string): KvAdapter {
    const given = options.adapter ?? (app ? appStores.get(app) : undefined);
    if (given) {
      return given;
    }

    if (!fromEnv) {
      // A Worker may have no `process`; it gives a store instead.
      const url =
        typeof process === "undefined"
          ? undefined
          : process.env.INNGEST_EXPERIMENTAL_KV_URL;
      if (!url) {
        throw new Error(
          "kv needs a store: give createAgents(client, { store }) one, or set INNGEST_EXPERIMENTAL_KV_URL to a Redis URL (redis:// or rediss://).",
        );
      }
      fromEnv = redisKvAdapter(url);
    }

    return fromEnv;
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
        handle: handleFor(store(scoped.app), scope, scoped),
        inFunction: Boolean(current),
      };
    }

    // Inside a function each call is a step; outside it is direct.
    async function run<T>(
      op: string,
      key: string | undefined,
      fn: (handle: RawKv) => Promise<T>,
    ) {
      const { handle, inFunction } = resolve();
      if (!inFunction) {
        return fn(handle);
      }

      // The same operation on the same key is often repeated with other work
      // between the calls, which the engine reads as parallel chains using one
      // ID and warns about. Each repeat gets the ID the engine would index it
      // to (`id`, `id:1`, `id:2`), so runs in flight keep their steps and
      // every ID is distinct.
      const base = `kv.${op}:${scope}${explicitId ? `:${explicitId}` : ""}${key === undefined ? "" : `:${key}`}`;
      const execution = getAsyncCtxSync()?.execution;
      const repeat = execution ? nextCount(execution.instance, base) : 0;

      return (await step.run(
        repeat === 0
          ? base
          : { id: `${base}${STEP_INDEXING_SUFFIX}${repeat}`, name: base },
        async () => {
          return (await fn(handle)) ?? null;
        },
      )) as T;
    }

    return {
      async get(key) {
        const name = nameOf(key);
        const read = await run("get", name, async (h) => {
          return found(await h.get(name));
        });

        return decode(key, unwrapRead(read));
      },
      async set(key, value, setOptions) {
        checkedTtl(setOptions);
        checkedValue(value);
        const name = nameOf(key);
        await run("set", name, async (h) => {
          await h.set(name, value, setOptions);
        });
      },
      async setIfAbsent(key, value, setOptions) {
        checkedTtl(setOptions);
        checkedValue(value);
        const name = nameOf(key);

        return run("setIfAbsent", name, async (h) => {
          return h.setIfAbsent(name, value, setOptions);
        });
      },
      index(name) {
        return {
          async add(member, score) {
            checkedMember(member);
            checkedScore(score);
            await run("index.add", `${name}:${member}`, async (h) => {
              await h.indexAdd(name, member, score);
            });
          },
          async range(rangeOptions = {}) {
            checkedRange(rangeOptions);

            return run("index.range", name, async (h) => {
              return h.indexRange(name, rangeOptions);
            });
          },
          async remove(member) {
            checkedMember(member);
            await run("index.remove", `${name}:${member}`, async (h) => {
              await h.indexRemove(name, member);
            });
          },
        };
      },
      async update<K extends KvKeyInput, V>(
        key: K,
        fn: (current: KvValue<K> | undefined) => KvWrite<K, V>,
      ): Promise<KvResult<K, V>> {
        const name = nameOf(key);
        const result = await run("update", name, async (h) => {
          const current = await tryDecode(key, await h.get(name));
          if (!current.ok) {
            return {
              "~kvUpdate": true,
              invalid: current.invalid,
            } satisfies KvUpdate;
          }

          const next = fn(current.value);
          await h.set(name, next);

          return { "~kvUpdate": true, value: next } satisfies KvUpdate;
        });

        return unwrapUpdate(result) as KvResult<K, V>;
      },
      async take(key) {
        const name = nameOf(key);
        // Checked before the key is removed, so a value that fails its schema
        // stays readable.
        const read = await run("take", name, async (h) => {
          const raw = await h.get(name);
          const checked = await tryDecode(key, raw);
          if (!checked.ok) {
            return {
              "~kvRead": true,
              found: false,
              invalid: checked.invalid,
            } satisfies KvRead;
          }

          await h.delete(name);

          return found(raw);
        });

        return decode(key, unwrapRead(read));
      },
      async delete(key) {
        const name = nameOf(key);
        await run("delete", name, async (h) => {
          await h.delete(name);
        });
      },
      async all() {
        return run("all", undefined, async (h) => {
          return h.all();
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
        adapter: options.adapter,
        bound: { env: client.env ?? "default", app: client.id },
      });
    },
  };
}

/**
 * The default KV. Its store is the one the app gave `createAgents`, else Redis
 * at `INNGEST_EXPERIMENTAL_KV_URL`.
 */
export const kv: Kv = createKv();
