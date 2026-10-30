/**
 * @module
 * EXPERIMENTAL: a `KvStore` on a Cloudflare D1 database (or any SQLite with
 * the same prepared-statement API). Two tables hold the keys and the sorted
 * indexes. Expiry is checked against the database's clock, so hosts with a
 * skewed clock agree on when a key ends.
 *
 * Guarantees:
 *
 * - `setIfAbsent` is one SQL statement, so two callers racing for a key are
 *   arbitrated: exactly one wins. A key whose time to live has passed counts as
 *   absent.
 * - `set`, `delete`, `indexAdd` and `indexRemove` are single statements.
 * - `clear` removes the keys and the indexes of a scope instance in one batch,
 *   which D1 runs as a transaction.
 * - `compareAndSet` is one statement that matches on the old value (or, for
 *   an absent key, an insert that only takes an absent or expired key), so the
 *   KV's `update`, which retries on a lost compare, never loses an update. A
 *   value that returns to what it was between the read and the write counts as
 *   unchanged, which is right for an update that is a function of the value.
 * - Expired rows are deleted when their scope instance is next written with a
 *   time to live, and are never returned.
 */
import type { KvIndexEntry, KvIndexRange, KvStore } from "./kv.ts";

/**
 * A prepared statement, as D1 and compatible databases give it.
 */
export interface D1KvStatement {
  bind(...values: unknown[]): D1KvStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes?: number } }>;
}

/**
 * The part of a D1 database the store uses. A D1 binding (`env.DB`) fits it.
 */
export interface D1KvDatabase {
  prepare(query: string): D1KvStatement;
  batch(statements: D1KvStatement[]): Promise<unknown[]>;
}

/**
 * The tables the store needs. Put these in a migration (a wrangler D1
 * migration, for instance). The store does not create them unless
 * `createTables` is on.
 */
export const d1KvSchema = [
  `CREATE TABLE IF NOT EXISTS inngest_kv (
    scope TEXT NOT NULL,
    field TEXT NOT NULL,
    value TEXT NOT NULL,
    expires_at INTEGER,
    PRIMARY KEY (scope, field)
  )`,
  `CREATE TABLE IF NOT EXISTS inngest_kv_index (
    scope TEXT NOT NULL,
    idx TEXT NOT NULL,
    member TEXT NOT NULL,
    score REAL NOT NULL,
    PRIMARY KEY (scope, idx, member)
  )`,
  `CREATE INDEX IF NOT EXISTS inngest_kv_index_score
    ON inngest_kv_index (scope, idx, score, member)`,
] as const;

// The database's clock, in milliseconds. Not `strftime('%s')`, which counts
// whole seconds and would end a key up to a second early.
const clockSql = "(julianday('now') - 2440587.5) * 86400000";
const now = `CAST(ROUND(${clockSql}) AS INTEGER)`;

const live = `(expires_at IS NULL OR expires_at > ${now})`;

/**
 * Options of `d1KvAdapter`.
 */
export interface D1KvOptions {
  /**
   * Create the tables with `CREATE TABLE IF NOT EXISTS` before the first use
   * of each database. Default `false`: a migration creates `d1KvSchema`. A
   * binding that is a new object on every request would run it on every
   * request, so use this for local development.
   */
  createTables?: boolean;
}

/**
 * EXPERIMENTAL: A `KvStore` on D1.
 *
 * A Worker gets its bindings per request, so the database may be a function
 * that returns it; it is called on every operation.
 * @param database A D1 database, or a function that returns one.
 * @param options Table creation.
 */
export function d1KvAdapter(
  database: D1KvDatabase | (() => D1KvDatabase),
  options: D1KvOptions = {},
): KvStore {
  const db = () => {
    return typeof database === "function" ? database() : database;
  };
  const created = new WeakMap<object, Promise<unknown>>();

  async function ready(): Promise<D1KvDatabase> {
    const current = db();

    if (options.createTables === true) {
      // One creation per database, shared by calls that arrive together.
      let creating = created.get(current);

      if (!creating) {
        creating = current
          .batch(
            d1KvSchema.map((statement) => {
              return current.prepare(statement);
            }),
          )
          .catch((error) => {
            created.delete(current);

            throw error;
          });
        created.set(current, creating);
      }

      await creating;
    }

    return current;
  }

  return {
    async get(hash, field) {
      const row = await (await ready())
        .prepare(
          `SELECT value FROM inngest_kv WHERE scope = ? AND field = ? AND ${live}`,
        )
        .bind(hash, field)
        .first<{ value: string }>();

      return row?.value ?? null;
    },

    async set(hash, field, value, ttl) {
      const current = await ready();
      const statements = [
        current
          .prepare(
            `INSERT INTO inngest_kv (scope, field, value, expires_at)
             VALUES (?, ?, ?, ${ttl === undefined ? "NULL" : `${now} + ? * 1000`})
             ON CONFLICT (scope, field) DO UPDATE SET
               value = excluded.value, expires_at = excluded.expires_at`,
          )
          .bind(
            ...(ttl === undefined
              ? [hash, field, value]
              : [hash, field, value, ttl]),
          ),
      ];

      // Expired rows of the scope go when it is written with a time to live.
      if (ttl !== undefined) {
        statements.push(
          current
            .prepare(
              `DELETE FROM inngest_kv WHERE scope = ? AND expires_at IS NOT NULL AND expires_at <= ${now}`,
            )
            .bind(hash),
        );
      }

      await current.batch(statements);
    },

    async setIfAbsent(hash, field, value, ttl) {
      const current = await ready();

      const claim = async (retried: boolean): Promise<boolean> => {
        // One statement: inserts a new key, or takes over one that expired, and
        // leaves a live key alone. `changes` tells which.
        const result = await current
          .prepare(
            `INSERT INTO inngest_kv (scope, field, value, expires_at)
           VALUES (?, ?, ?, ${ttl === undefined ? "NULL" : `${now} + ? * 1000`})
           ON CONFLICT (scope, field) DO UPDATE SET
             value = excluded.value, expires_at = excluded.expires_at
           WHERE inngest_kv.expires_at IS NOT NULL AND inngest_kv.expires_at <= ${now}`,
          )
          .bind(
            ...(ttl === undefined
              ? [hash, field, value]
              : [hash, field, value, ttl]),
          )
          .run();

        if ((result.meta.changes ?? 0) > 0) {
          return true;
        }

        // The key is held. It is this call's when it holds exactly this value
        // (the same call retried after its own write).
        const row = await current
          .prepare(
            `SELECT value FROM inngest_kv WHERE scope = ? AND field = ? AND ${live}`,
          )
          .bind(hash, field)
          .first<{ value: string }>();

        // The holder expired or was deleted between the two statements: the key
        // is free, so claim it once more.
        if (!row && !retried) {
          return claim(true);
        }

        return row?.value === value;
      };

      return claim(false);
    },

    async compareAndSet(hash, field, expected, next) {
      const current = await ready();
      const result =
        expected === null
          ? await current
              .prepare(
                `INSERT INTO inngest_kv (scope, field, value, expires_at)
                 VALUES (?, ?, ?, NULL)
                 ON CONFLICT (scope, field) DO UPDATE SET
                   value = excluded.value, expires_at = NULL
                 WHERE inngest_kv.expires_at IS NOT NULL AND inngest_kv.expires_at <= ${now}`,
              )
              .bind(hash, field, next)
              .run()
          : await current
              .prepare(
                `UPDATE inngest_kv SET value = ?, expires_at = NULL
                 WHERE scope = ? AND field = ? AND value = ? AND ${live}`,
              )
              .bind(next, hash, field, expected)
              .run();

      return (result.meta.changes ?? 0) > 0;
    },

    async delete(hash, field) {
      await (await ready())
        .prepare("DELETE FROM inngest_kv WHERE scope = ? AND field = ?")
        .bind(hash, field)
        .run();
    },

    async all(hash) {
      const { results } = await (await ready())
        .prepare(
          `SELECT field, value FROM inngest_kv WHERE scope = ? AND ${live}`,
        )
        .bind(hash)
        .all<{ field: string; value: string }>();

      return Object.fromEntries(
        results.map((row) => {
          return [row.field, row.value];
        }),
      );
    },

    async clear(hash) {
      const current = await ready();

      await current.batch([
        current.prepare("DELETE FROM inngest_kv WHERE scope = ?").bind(hash),
        current
          .prepare("DELETE FROM inngest_kv_index WHERE scope = ?")
          .bind(hash),
      ]);
    },

    async indexAdd(hash, index, member, score) {
      await (await ready())
        .prepare(
          `INSERT INTO inngest_kv_index (scope, idx, member, score)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (scope, idx, member) DO UPDATE SET score = excluded.score`,
        )
        .bind(hash, index, member, score)
        .run();
    },

    async indexRange(
      hash,
      index,
      range: KvIndexRange,
    ): Promise<KvIndexEntry[]> {
      const desc = range.order === "desc";
      // An infinite bound on its own side is no bound. One that excludes
      // everything (or NaN) matches nothing, as in the other stores.
      if (
        range.min === Number.POSITIVE_INFINITY ||
        range.max === Number.NEGATIVE_INFINITY ||
        Number.isNaN(range.min) ||
        Number.isNaN(range.max)
      ) {
        return [];
      }

      const min =
        range.min === Number.NEGATIVE_INFINITY ? undefined : range.min;
      const max =
        range.max === Number.POSITIVE_INFINITY ? undefined : range.max;
      const { results } = await (await ready())
        .prepare(
          `SELECT member, score FROM inngest_kv_index
           WHERE scope = ? AND idx = ?${min === undefined ? "" : " AND score >= ?"}${max === undefined ? "" : " AND score <= ?"}
           ORDER BY score ${desc ? "DESC" : "ASC"}, member ${desc ? "DESC" : "ASC"}
           LIMIT ?`,
        )
        .bind(
          hash,
          index,
          ...(min === undefined ? [] : [min]),
          ...(max === undefined ? [] : [max]),
          range.limit ?? -1,
        )
        .all<{ member: string; score: number }>();

      return results.map((row) => {
        return { member: row.member, score: Number(row.score) };
      });
    },

    async indexRemove(hash, index, member) {
      await (await ready())
        .prepare(
          "DELETE FROM inngest_kv_index WHERE scope = ? AND idx = ? AND member = ?",
        )
        .bind(hash, index, member)
        .run();
    },
  };
}
