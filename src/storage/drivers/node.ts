import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Database, Statement } from 'better-sqlite3';

export interface Driver {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
  close(): void;
  pragma(pragma: string, options?: { simple?: boolean }): unknown;
}

export function openDriver(path: string): Driver {
  const db: BetterSqlite3Database = new Database(path);

  return {
    prepare: (sql) => db.prepare(sql),
    exec: (sql) => { db.exec(sql); },
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
    close: () => db.close(),
    pragma: (pragma, options) => db.pragma(pragma, options),
  };
}
