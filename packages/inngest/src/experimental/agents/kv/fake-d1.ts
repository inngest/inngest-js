/**
 * @module
 * A D1-shaped database over Node's built-in SQLite, for tests. The database's
 * clock (`julianday('now')` in the store's SQL) is a number the test
 * moves, so expiry is tested without waiting.
 */
import type { D1KvDatabase, D1KvStatement } from "./kvD1.ts";

/**
 * Whether this Node has `node:sqlite` (22.5 and later). Tests that need
 * {@link fakeD1} skip themselves without it.
 */
export const hasNodeSqlite = await import("node:sqlite").then(
  () => {
    return true;
  },
  () => {
    return false;
  },
);

/**
 * Opens an in-memory database.
 * @param clockMs The database's clock, in milliseconds.
 */
export async function fakeD1(clockMs: () => number): Promise<D1KvDatabase> {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(":memory:");

  function statement(sql: string, values: unknown[] = []): D1KvStatement {
    // The store's clock expression becomes the test's clock, in Julian days.
    const text = sql.replaceAll(
      "julianday('now')",
      String(clockMs() / 86400000 + 2440587.5),
    );

    return {
      bind: (...next) => {
        return statement(sql, next);
      },
      first: async <T>() => {
        return (sqlite.prepare(text).get(...(values as never[])) ??
          null) as T | null;
      },
      all: async <T>() => {
        return {
          results: sqlite.prepare(text).all(...(values as never[])) as T[],
        };
      },
      run: async () => {
        const result = sqlite.prepare(text).run(...(values as never[]));

        return { meta: { changes: Number(result.changes) } };
      },
    };
  }

  // D1 runs a batch as one transaction; a connection can hold only one, so
  // batches here wait for each other.
  let lock: Promise<unknown> = Promise.resolve();

  return {
    prepare: (sql) => {
      return statement(sql);
    },
    batch: (statements) => {
      const run = lock.then(async () => {
        sqlite.exec("BEGIN");

        try {
          const results = [];
          for (const one of statements) {
            results.push(await one.run());
          }
          sqlite.exec("COMMIT");

          return results;
        } catch (error) {
          sqlite.exec("ROLLBACK");

          throw error;
        }
      });

      lock = run.catch(() => {});

      return run;
    },
  };
}
