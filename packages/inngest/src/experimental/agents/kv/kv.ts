/**
 * @module
 * EXPERIMENTAL: a scoped key-value store. Scopes say how long a value lives and
 * who sees it: `kv.env`, `kv.app`, `kv.run` and `kv.thread`, always written out.
 * The store is the one given to `createAgents(client, { store })`, else Redis at
 * `INNGEST_EXPERIMENTAL_KV_URL`, else the ledger (`ledgerKvAdapter()`), which
 * needs no outside service.
 *
 * Inside a function every read and write is its own memoized step, so a
 * replay sees the values the first execution saw. Outside a function (a thread
 * handle, a script) calls go straight to the store.
 *
 * The scope is chosen up front: `kv.thread.get("plan")` is the current
 * thread's and `kv.scope("thread", key).get("plan")` is another's. The global
 * `kv` finds the current run and thread from the function it is called in.
 *
 * Keys are plain names (values are `unknown`) or typed `kv.key`s, which carry
 * their value type and can validate it with a schema.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { getAsyncCtxSync } from "../../../components/execution/als.ts";
import {
  STEP_INDEXING_SUFFIX,
  step,
} from "../../../components/InngestStepTools.ts";
import { NonRetriableError } from "../../../components/NonRetriableError.ts";
import { nextCount } from "../agent/executionCounter.ts";
import { currentSessions } from "../agent/sessions.ts";
import type { Json } from "../json.ts";
import {
  conditionalOnLedger,
  isLedgerKvStore,
  type LedgerKvStore,
  type LedgerSender,
  ledgerKvAdapter,
} from "../threads/ledgerClient.ts";
import { redisConnection } from "./redis.ts";

/**
 * How long a value lives and who sees it: `env` (the whole environment),
 * `app`, `run` and `thread`.
 */
export type KvScope = "env" | "app" | "run" | "thread";

/**
 * Where values are stored. Each scope instance is one hash, so removing a
 * whole scope (a finished run) is one call.
 *
 * Four stores ship: the ledger (`ledgerKvAdapter`, the default), Redis
 * (`redisKvAdapter`), Cloudflare D1 (`d1KvAdapter`) and memory
 * (`memoryKvAdapter`, for tests). Give an app its store with
 * `createAgents(client, { store })`; with none (and no
 * `INNGEST_EXPERIMENTAL_KV_URL`) the ledger is used.
 *
 * What a store must guarantee:
 *
 * - `setIfAbsent` is atomic across callers: of two racing calls exactly one
 *   writes. Redis does it with `SET NX`, D1 with one upsert statement, memory
 *   by running on one thread.
 * - A field past its `ttl` reads as absent, and `setIfAbsent` may take it over.
 * - A single write (`set`, `delete`, `indexAdd`, `indexRemove`) takes effect
 *   whole or not at all.
 * - `compareAndSet` is atomic across callers, and the KV's `update` is built on
 *   it: it reads, computes, and writes only if the value is still the one it
 *   read, else it reads again. Redis does it in a script, D1 in one statement
 *   that matches on the old value, memory on one thread.
 * - Nothing else spans two calls. A `get` followed by a `set` is not atomic.
 */
export interface KvStore {
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

  /**
   * Replaces the field's value with `next` only when its live value is
   * `expected` (`null`: the field is absent), and returns whether it did.
   * Atomic across callers: of two calls that read the same value, one wins.
   * The new value never expires. The KV's `update` is built on it.
   */
  compareAndSet(
    hash: string,
    field: string,
    expected: string | null,
    next: string,
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
export function memoryKvAdapter(): KvStore {
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
    async compareAndSet(hash, field, expected, next) {
      if ((live(hash, field)?.value ?? null) !== expected) {
        return false;
      }

      write(hash, field, next);

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

// Compares the field (in either of its two forms) with the expected value and
// writes the new one as a plain hash field, all on the server.
const compareAndSetScript = `-- inngest-kv-cas
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if not cur then cur = redis.call('GET', KEYS[2]) end
if ARGV[2] == '0' then
  if cur then return 0 end
elseif cur ~= ARGV[3] then
  return 0
end
redis.call('DEL', KEYS[2])
redis.call('HSET', KEYS[1], ARGV[1], ARGV[4])
return 1`;

/**
 * A Redis adapter that connects on first use. Needs Redis 6.2 or newer.
 *
 * Plain fields live in one hash. Fields with a time to live are string keys
 * (older servers cannot expire a hash field) and each index is a sorted set.
 * Every key of a scope instance carries the hash in `{braces}`, so they share
 * a cluster slot and one scope instance can be read or removed in one go.
 * @param url `redis://` or `rediss://` URL.
 */
export function redisKvAdapter(url: string): KvStore {
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
    async compareAndSet(hash, field, expected, next) {
      // A script, so the compare and the write are one step on the server.
      const swapped = await command(
        "EVAL",
        compareAndSetScript,
        "2",
        main(hash),
        expiring(hash, field),
        field,
        expected === null ? "0" : "1",
        expected ?? "",
        next,
      );

      return swapped === 1;
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
 * `kv.key`: with a schema the value is validated on every read; without one
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
 * What `kv.key<T>(name)` returns: a `KvKey<T>` when `T` is JSON-safe, otherwise
 * a type that names the problem, so the first use of the key is refused.
 */
export type KvKeyOf<T> = [T] extends [KvJsonSafe<T>]
  ? KvKey<T>
  : KvValueMustBeJson;

/**
 * Marks a value type refused by `kv.key`.
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
export type KvWrite<K extends KvKeyInput, V = Json> = [K] extends [
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
 * What a `kv.key` schema must satisfy: its input and output types match, so
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
 * Marks a schema refused by `kv.key`.
 */
export interface KvSchemaMustRoundTrip {
  "kv.key schema: input and output types must match and be JSON (no transforms, defaults, coercion, Date or Map)": never;
}

/**
 * Names a key and types its value; `kv.key` is this function.
 *
 * @example
 * ```ts
 * const plan = kv.key("plan", z.object({ steps: z.number() }));
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
export function typedKey<T>(name: string): KvKeyOf<T>;
export function typedKey<S extends StandardSchemaV1>(
  name: string,
  schema: S & KvRoundTrips<S>,
): KvKey<StandardSchemaV1.InferOutput<S>>;
export function typedKey(
  name: string,
  schema?: StandardSchemaV1,
): KvKey<unknown> {
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
  /**
   * Set on the ledger's handle, which has no conditional writes.
   */
  readonly ledger?: true;
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, options?: KvSetOptions): Promise<void>;
  setIfAbsent(
    key: string,
    value: unknown,
    options?: KvSetOptions,
  ): Promise<boolean>;

  /**
   * Reads a key, asks `compute` what to do, and writes only if the key is
   * still as it was read, trying again from a fresh read when another caller
   * got there first. `compute` may run more than once, so it must be a pure
   * function of what it is given.
   */
  update<R>(
    key: string,
    compute: (current: unknown) => Promise<{ stop: R } | { write: unknown }>,
  ): Promise<{ stopped: R } | { written: unknown }>;
  delete(key: string): Promise<void>;

  all(): Promise<Record<string, unknown>>;
  clear(): Promise<void>;
  indexAdd(index: string, member: string, score: number): Promise<void>;
  indexRange(index: string, options: KvIndexRange): Promise<KvIndexEntry[]>;
  indexRemove(index: string, member: string): Promise<void>;
}

// How many times an update retries after losing a race.
const updateAttempts = 25;

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
   * Run ID, for the `run` scope.
   */
  run?: string;

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
   * Reads, transforms and writes a key in one step. It is a compare-and-set:
   * when another run changes the key between the read and the write, the
   * update reads again and calls `fn` again, so `fn` must be a pure function
   * of its argument. Two runs updating one key never lose an update. A key
   * that loses 25 races in a row (many writers at once, with no backoff)
   * throws. A run that is retried after the write but before its step was saved
   * applies `fn` again, so `fn` must also tolerate being applied twice.
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
 * The store. A scope is always written out: `kv.thread`, `kv.run`, `kv.app`
 * and `kv.env`. `thread` needs an agent run; the others work in any function.
 */
export interface Kv {
  /**
   * A scope instance by id: for example `kv.scope("thread", key)` reaches
   * another thread's state from a bridge or a script.
   * @param scope The scope.
   * @param id The instance, for example a thread key. Without it, the current
   * function's own.
   */
  scope(scope: KvScope, id?: string): KvScopeInstance;

  /**
   * Shared by every app of the environment. On the ledger KV store (the
   * default) it is shared by the functions of one app only, because a ledger
   * function belongs to one app: configure a store adapter to share it across
   * apps.
   */
  readonly env: KvScopeInstance;

  /**
   * Shared by every function of the app.
   */
  readonly app: KvScopeInstance;

  /**
   * The current run's own keys, removed when it ends. On the ledger KV store
   * they live in the run itself: a read costs no step, and a write is a step
   * that cannot be made inside another step's callback.
   */
  readonly run: KvScopeInstance;

  /**
   * EXPERIMENTAL: The current thread's keys, kept across the runs of an agent
   * thread.
   *
   * On the default ledger store, thread state is eventually consistent: a
   * shared whiteboard every live run on the thread sees with a small lag, not a
   * lock. A value never goes backwards for a key (the later write wins,
   * ordered by when Inngest recorded it, then by writer), but two writers
   * racing on one key can each read their own value until the other's arrives.
   * For anything agents must agree on, send a message to one owner or
   * configure a store adapter. Prefer one writer per key. The ledger has no
   * conditional writes: `setIfAbsent`, `update` and `take` throw there and ask
   * for a store adapter, which keeps them.
   */
  readonly thread: KvScopeInstance;

  /**
   * Names a key and types its value: `kv.key<T>(name)`, or
   * `kv.key(name, schema)` to check the value on every read.
   */
  readonly key: typeof typedKey;

  /**
   * The store for a client, to use outside a function (a route, a script)
   * where there is no current run to take the environment and app from.
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
      `kv scope "${scope}" is not available here: no ${scope} id (the thread scope needs an agent run; use kv.scope("thread", key) to name one).`,
    );
  }

  const parts =
    scope === "app"
      ? [ids.env, ids.app]
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

  // A run started by another agent or by an event of `triggers` is told its
  // thread by the agent function; `data.thread` is what a message
  // starts an agent function with.
  const sessions = currentSessions(ctx);
  const agent = execution.agent;
  const thread =
    agent?.thread ??
    sessions.agent_thread ??
    (ctx.event?.name?.startsWith("agent/")
      ? (ctx.event.data as { thread?: string })?.thread
      : undefined);

  return {
    env: app?.env ?? "default",
    app: app?.id ?? "app",
    run: ctx.runId,
    thread,
  };
}

/**
 * The key of the thread the current run belongs to, when there is one.
 */
export function currentThreadKey(): string | undefined {
  return currentIds()?.thread;
}

/**
 * Reads and writes one scope instance directly.
 * @param adapter Where values live.
 * @param scope The scope.
 * @param ids Ids of the scope instances.
 */
function handleFor(adapter: KvStore, scope: KvScope, ids: KvScopeIds): RawKv {
  const hash = kvHash(scope, ids);

  return {
    ...(isLedgerKvStore(adapter) && { ledger: true as const }),
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
      if (isLedgerKvStore(adapter)) {
        throw conditionalOnLedger("setIfAbsent");
      }

      return adapter.setIfAbsent(
        hash,
        key,
        JSON.stringify(checkedValue(value)),
        checkedTtl(options),
      );
    },
    async update(key, compute) {
      if (isLedgerKvStore(adapter)) {
        throw conditionalOnLedger("update");
      }

      for (let attempt = 0; attempt < updateAttempts; attempt++) {
        const raw = await adapter.get(hash, key);
        const outcome = await compute(
          raw === null ? undefined : JSON.parse(raw),
        );

        if ("stop" in outcome) {
          return { stopped: outcome.stop };
        }

        if (
          await adapter.compareAndSet(
            hash,
            key,
            raw,
            JSON.stringify(checkedValue(outcome.write)),
          )
        ) {
          return { written: outcome.write };
        }
      }

      throw new Error(
        `kv update of "${key}" kept losing to other writers; gave up after ${updateAttempts} tries`,
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

const appStores = new Map<string, KvStore>();
const envStores = new Map<string, KvStore>();
let ledgerStoreCache: KvStore | undefined;

// Lazy: building it at module load reads `ledgerKvAdapter` before an import
// cycle through `experimental.ts` has initialized it.
const ledgerStore = (): KvStore => {
  ledgerStoreCache ??= ledgerKvAdapter();
  return ledgerStoreCache;
};

/**
 * Sets the store the KV of an app uses, unless a KV was built with its own.
 * `createAgents(client, { store })` calls it.
 * @param app The app ID of the client.
 * @param store The store.
 */
export function setAppKvStore(app: string, store: KvStore): void {
  appStores.set(app, store);
}

/**
 * The store an app's KV uses: the one the app gave `createAgents`, else Redis
 * at `INNGEST_EXPERIMENTAL_KV_URL`, else the ledger. Direct calls, not steps,
 * so other parts of the SDK that run inside a step (such as MCP OAuth tokens)
 * can share it.
 * @param app The app ID of the client, if known.
 */
export function kvAdapterFor(app?: string): KvStore {
  const given = app ? appStores.get(app) : undefined;
  if (given) {
    return given;
  }

  // A Worker may have no `process`; it gives a store instead.
  const url =
    typeof process === "undefined"
      ? undefined
      : process.env.INNGEST_EXPERIMENTAL_KV_URL;
  if (!url) {
    return ledgerStore();
  }

  // One connection per URL, however many KVs are built (`kv.with(client)`
  // builds one per call).
  let found = envStores.get(url);
  if (!found) {
    found = redisKvAdapter(url);
    envStores.set(url, found);
  }

  return found;
}

/**
 * Whether an app's KV is the ledger: no store was given to `createAgents` and
 * there is no `INNGEST_EXPERIMENTAL_KV_URL`.
 * @param app The app ID of the client, if known.
 */
export function usesLedger(app?: string): boolean {
  return isLedgerKvStore(kvAdapterFor(app));
}

/**
 * One run's own keys when the KV is the ledger: held in the run, rebuilt on a
 * replay from the memoized write steps, gone when the run ends.
 */
interface RunLocal {
  keys: Map<string, { v: string; exp?: number }>;
  indexes: Map<string, Map<string, number>>;
}

const runLocals = new WeakMap<object, RunLocal>();

/**
 * A write to a run's own keys, as its step returns it.
 */
type RunOp =
  | { kind: "set"; key: string; value: string; exp?: number }
  | { kind: "delete"; key: string }
  | { kind: "clear" }
  | { kind: "add"; index: string; member: string; score: number }
  | { kind: "remove"; index: string; member: string };

/**
 * The handle of the current run's own keys with the ledger KV. A read is the
 * run's copy and costs no step. A write is one memoized step that returns the
 * write, which the run applies to its copy, so a replay rebuilds the copy.
 */
function localRunHandle(): RawKv {
  const execution = getAsyncCtxSync()?.execution;

  if (!execution) {
    throw new Error("kv.run needs a function run");
  }

  let local = runLocals.get(execution.instance);

  if (!local) {
    local = { keys: new Map(), indexes: new Map() };
    runLocals.set(execution.instance, local);
  }

  const mine = local;
  const live = (key: string): string | undefined => {
    const field = mine.keys.get(key);

    return field && (field.exp === undefined || field.exp > Date.now())
      ? field.v
      : undefined;
  };
  const apply = (op: RunOp) => {
    switch (op.kind) {
      case "set":
        mine.keys.set(op.key, {
          v: op.value,
          ...(op.exp !== undefined && { exp: op.exp }),
        });
        return;
      case "delete":
        mine.keys.delete(op.key);
        return;
      case "clear":
        mine.keys.clear();
        mine.indexes.clear();
        return;
      case "add": {
        const members = mine.indexes.get(op.index) ?? new Map();

        members.set(op.member, op.score);
        mine.indexes.set(op.index, members);
        return;
      }
      case "remove":
        mine.indexes.get(op.index)?.delete(op.member);
    }
  };
  const commit = async (
    name: string,
    key: string | undefined,
    build: () => RunOp,
  ) => {
    if (execution.executingStep) {
      throw new Error(
        "With the ledger KV store, kv.run cannot be written inside a step's callback: write between steps. Configure a store adapter with createAgents(client, { store }) to do this.",
      );
    }

    const base = `kv.${name}:run${key === undefined ? "" : `:${key}`}`;
    const repeat = nextCount(execution.instance, base);
    const done = (await step.run(
      repeat === 0
        ? base
        : { id: `${base}${STEP_INDEXING_SUFFIX}${repeat}`, name: base },
      async () => {
        return build();
      },
    )) as RunOp;

    apply(done);
  };
  const expires = (options?: KvSetOptions) => {
    const ttl = checkedTtl(options);

    return ttl === undefined ? {} : { exp: Date.now() + ttl * 1000 };
  };

  return {
    async get(key) {
      const raw = live(key);

      return raw === undefined ? undefined : JSON.parse(raw);
    },
    async set(key, value, options) {
      const text = JSON.stringify(checkedValue(value));

      await commit("set", key, () => {
        return { kind: "set", key, value: text, ...expires(options) };
      });
    },
    async setIfAbsent(key, value, options) {
      const text = JSON.stringify(checkedValue(value));
      const held = live(key);

      if (held !== undefined) {
        return held === text;
      }

      await commit("setIfAbsent", key, () => {
        return { kind: "set", key, value: text, ...expires(options) };
      });

      return true;
    },
    async update(key, compute) {
      const held = live(key);
      const outcome = await compute(
        held === undefined ? undefined : JSON.parse(held),
      );

      if ("stop" in outcome) {
        return { stopped: outcome.stop };
      }

      const text = JSON.stringify(checkedValue(outcome.write));

      await commit("update", key, () => {
        return { kind: "set", key, value: text };
      });

      return { written: outcome.write };
    },
    async delete(key) {
      await commit("delete", key, () => {
        return { kind: "delete", key };
      });
    },
    async all() {
      return Object.fromEntries(
        [...mine.keys.keys()].flatMap((key) => {
          const raw = live(key);

          return raw === undefined ? [] : [[key, JSON.parse(raw)]];
        }),
      );
    },
    async clear() {
      await commit("clear", undefined, () => {
        return { kind: "clear" };
      });
    },
    async indexAdd(index, member, score) {
      checkedScore(score);
      await commit("index.add", `${index}:${member}`, () => {
        return { kind: "add", index, member, score };
      });
    },
    async indexRange(index, options) {
      checkedRange(options);

      const entries = [...(mine.indexes.get(index) ?? [])]
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
    async indexRemove(index, member) {
      await commit("index.remove", `${index}:${member}`, () => {
        return { kind: "remove", index, member };
      });
    },
  };
}

/**
 * Builds a store.
 * @param options.adapter Where values live. Default: Redis at `INNGEST_EXPERIMENTAL_KV_URL`.
 * @param options.bound Environment and app to use outside a function.
 */
export function createKv(
  options: {
    adapter?: KvStore;
    bound?: { env: string; app: string; client?: LedgerSender };
  } = {},
): Kv {
  // The store of an app: the one this KV was built with, else the one the app
  // gave `createAgents`, else Redis at the environment's URL.
  function store(app?: string): KvStore {
    return options.adapter ?? kvAdapterFor(app);
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

      const adapter = store(ids.app);

      // The ledger keeps its own steps, so its calls are not wrapped in
      // another. Outside a function it writes through the bound client.
      if (isLedgerKvStore(adapter)) {
        // A run's own keys live in the run, not in a ledger that would outlive
        // it.
        if (scope === "run") {
          if (
            !current ||
            (explicitId !== undefined && explicitId !== ids.run)
          ) {
            throw new Error(
              "With the ledger KV store, kv.run is the current run's own and works only inside its function. Configure a store adapter with createAgents(client, { store }) to name another run.",
            );
          }

          return {
            handle: localRunHandle(),
            inFunction: false,
          };
        }

        const bound = options.bound?.client;

        return {
          handle: handleFor(
            current || !bound ? adapter : ledgerKvAdapter({ client: bound }),
            scope,
            scoped,
          ),
          inFunction: false,
        };
      }

      return {
        handle: handleFor(adapter, scope, scoped),
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

      // Outside a function the call is direct. Inside a step's own callback
      // it rides on that step instead of being a nested step, so it runs
      // again when that step is retried: `update`, `take` and
      // `setIfAbsent` there must be safe to repeat.
      if (!inFunction || getAsyncCtxSync()?.execution?.executingStep) {
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
          const outcome = await h.update<KvUpdate>(name, async (raw) => {
            const current = await tryDecode(key, raw);
            if (!current.ok) {
              return {
                stop: { "~kvUpdate": true, invalid: current.invalid },
              };
            }

            return { write: fn(current.value) };
          });

          return "stopped" in outcome
            ? outcome.stopped
            : ({
                "~kvUpdate": true,
                value: outcome.written,
              } satisfies KvUpdate);
        });

        return unwrapUpdate(result) as KvResult<K, V>;
      },
      async take(key) {
        const name = nameOf(key);
        // Checked before the key is removed, so a value that fails its schema
        // stays readable.
        const read = await run("take", name, async (h) => {
          if (h.ledger) {
            throw conditionalOnLedger("take");
          }

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

  return {
    scope: instance,
    key: typedKey,
    get env() {
      return instance("env");
    },
    get app() {
      return instance("app");
    },
    get run() {
      return instance("run");
    },
    get thread() {
      return instance("thread");
    },
    with(client) {
      return createKv({
        adapter: options.adapter,
        bound: {
          env: client.env ?? "default",
          app: client.id,
          client: client as unknown as LedgerSender,
        },
      });
    },
  };
}

/**
 * The default KV. Its store is the one the app gave `createAgents`, else Redis
 * at `INNGEST_EXPERIMENTAL_KV_URL`.
 */
export const kv: Kv = createKv();
