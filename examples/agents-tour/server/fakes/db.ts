/**
 * @module
 * A tiny typed layer over `node:sqlite`, the SQLite that ships with Node. The
 * fakes keep their data in memory, so a restart of the tour starts clean.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export interface Db {
  exec(sql: string): void;
  all<T>(sql: string, ...params: SQLInputValue[]): T[];
  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined;
  run(sql: string, ...params: SQLInputValue[]): { changes: number; id: number };
}

export const openDb = (): Db => {
  const db = new DatabaseSync(":memory:");

  return {
    exec: (sql) => {
      db.exec(sql);
    },
    all: <T>(sql: string, ...params: SQLInputValue[]) => {
      return db.prepare(sql).all(...params) as T[];
    },
    get: <T>(sql: string, ...params: SQLInputValue[]) => {
      return db.prepare(sql).get(...params) as T | undefined;
    },
    run: (sql, ...params) => {
      const result = db.prepare(sql).run(...params);

      return {
        changes: Number(result.changes),
        id: Number(result.lastInsertRowid),
      };
    },
  };
};
