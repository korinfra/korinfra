import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';

const ALLOWED_PRAGMAS = new Set([
  'journal_mode', 'foreign_keys', 'busy_timeout', 'synchronous',
  'cache_size', 'temp_store', 'mmap_size', 'page_size', 'auto_vacuum',
  'incremental_vacuum', 'encoding', 'user_version', 'application_id',
  'secure_delete', 'locking_mode', 'wal_checkpoint',
]);

export type TransactionMode = 'DEFERRED' | 'IMMEDIATE' | 'EXCLUSIVE';

const VALID_TRANSACTION_MODES: ReadonlySet<TransactionMode> = new Set([
  'DEFERRED', 'IMMEDIATE', 'EXCLUSIVE',
]);

export interface Driver {
  prepare(sql: string): StatementSync;
  exec(sql: string): void;
  transaction<T>(fn: () => T, options?: { mode?: TransactionMode }): T;
  close(): void;
  pragma(pragma: string, options?: { simple?: boolean }): unknown;
}

export function openDriver(dbPath: string): Driver {
  const db = new DatabaseSync(dbPath);

  return {
    prepare: (sql) => db.prepare(sql),
    exec: (sql) => { db.exec(sql); },
    transaction: <T>(fn: () => T, options?: { mode?: TransactionMode }): T => {
      const mode = options?.mode ?? 'DEFERRED';
      if (!VALID_TRANSACTION_MODES.has(mode)) {
        throw new Error(`Invalid transaction mode: ${String(mode)}`);
      }
      db.exec(`BEGIN ${mode}`);
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    close: () => db.close(),
    pragma: (pragma, options): unknown => {
      const name = (pragma.split(/[\s=(]/)[0] ?? '').toLowerCase();
      if (!ALLOWED_PRAGMAS.has(name)) throw new Error(`PRAGMA not allowed: ${name}`);
      if (options?.simple) {
        const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined;
        return row !== undefined ? Object.values(row)[0] : undefined;
      }
      db.exec(`PRAGMA ${pragma}`);
      return undefined;
    },
  };
}
