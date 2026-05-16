/**
 * Integration tests for src/storage/db.ts
 *
 * Uses real better-sqlite3 against a temp file or :memory: path so we exercise
 * actual migrations, WAL mode, foreign keys, and the singleton pattern.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { fork } from 'node:child_process';
import { getDb, closeDb, getDbOrNull } from '../../../src/storage/db.js';
import { openDriver } from '../../../src/storage/drivers/node.js';
import type { Driver } from '../../../src/storage/drivers/node.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeTmpDbPath(): string {
  return path.join(tmpDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'korinfra-db-test-'));
  closeDb();
});

afterEach(() => {
  closeDb();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

// ---------------------------------------------------------------------------
// getDb — basic creation and file system
// ---------------------------------------------------------------------------

describe('getDb — basic creation', () => {
  it('returns a Driver with all expected methods, creates file on disk, and creates nested dirs', () => {
    const dbPath = makeTmpDbPath();
    expect(fs.existsSync(dbPath)).toBe(false);
    const db = getDb(dbPath);
    expect(db).toBeDefined();
    expect(typeof db.prepare).toBe('function');
    expect(typeof db.exec).toBe('function');
    expect(typeof db.transaction).toBe('function');
    expect(typeof db.close).toBe('function');
    expect(typeof db.pragma).toBe('function');
    expect(fs.existsSync(dbPath)).toBe(true);

    // nested directories created recursively
    closeDb();
    const nested = path.join(tmpDir, 'a', 'b', 'c', 'data.db');
    expect(fs.existsSync(path.dirname(nested))).toBe(false);
    getDb(nested);
    expect(fs.existsSync(nested)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WAL mode and pragmas
// ---------------------------------------------------------------------------

describe('getDb — WAL mode and pragmas', () => {
  it('enables WAL, foreign_keys, and busy_timeout=30000', () => {
    const db = getDb(makeTmpDbPath());
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(Number(db.pragma('busy_timeout', { simple: true }))).toBe(30000);
  });
});

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

describe('getDb — migrations', () => {
  it('creates all expected tables and records migration versions', () => {
    const db = getDb(makeTmpDbPath());

    for (const table of ['scans', 'resources', 'costs', 'recommendations', 'pricing_cache', 'api_call_log', 'virtual_tags', 'schema_migrations']) {
      const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`).all() as Array<{ name: string }>;
      expect(row).toHaveLength(1);
    }

    const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>;
    expect(versions.length).toBeGreaterThanOrEqual(1);
    expect(versions[0]!.version).toBe(1);
  });

  it('does not re-apply migrations on second getDb call to same path', () => {
    const dbPath = makeTmpDbPath();
    const db = getDb(dbPath);
    const before = (db.prepare('SELECT COUNT(*) AS cnt FROM schema_migrations').all() as Array<{ cnt: number }>)[0]!.cnt;

    closeDb();
    const db2 = getDb(dbPath);
    const after = (db2.prepare('SELECT COUNT(*) AS cnt FROM schema_migrations').all() as Array<{ cnt: number }>)[0]!.cnt;
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Singleton pattern
// ---------------------------------------------------------------------------

describe('getDb — singleton and getDbOrNull', () => {
  it('returns same instance for same path, throws for different path, resets after close', () => {
    const dbPath = makeTmpDbPath();
    const db1 = getDb(dbPath);
    expect(getDb(dbPath)).toBe(db1);

    const dbPath2 = makeTmpDbPath();
    expect(() => getDb(dbPath2)).toThrow(/already open/i);

    closeDb();
    expect(() => getDb(dbPath2)).not.toThrow();
  });

  it('getDbOrNull returns null before open, driver after open, null after close', () => {
    expect(getDbOrNull()).toBeNull();
    const db = getDb(makeTmpDbPath());
    expect(getDbOrNull()).toBe(db);
    closeDb();
    expect(getDbOrNull()).toBeNull();
  });

  it('closeDb is no-op when no db open', () => {
    expect(() => closeDb()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// KORINFRA_STORAGE_PATH env override
// ---------------------------------------------------------------------------

describe('resolveConfiguredStoragePath — env override', () => {
  it('uses KORINFRA_STORAGE_PATH when set', () => {
    const envPath = makeTmpDbPath();
    const original = process.env['KORINFRA_STORAGE_PATH'];
    try {
      process.env['KORINFRA_STORAGE_PATH'] = envPath;
      const db = getDb();
      expect(fs.existsSync(envPath)).toBe(true);
      expect(db).toBeDefined();
    } finally {
      closeDb();
      if (original === undefined) {
        delete process.env['KORINFRA_STORAGE_PATH'];
      } else {
        process.env['KORINFRA_STORAGE_PATH'] = original;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Concurrent startup — regression for issue #21
// ---------------------------------------------------------------------------

describe('migrate — concurrent startup safety (regression for #21)', () => {
  const workerPath = path.resolve(
    path.dirname(url.fileURLToPath(import.meta.url)),
    '_migrate-worker.ts',
  );

  type WorkerHandle = {
    ready: Promise<void>;
    go: () => void;
    exit: Promise<{ code: number | null; stderr: string }>;
    kill: () => void;
  };

  function spawnWorker(dbPath: string): WorkerHandle {
    const child = fork(workerPath, [dbPath], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'inherit', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const ready = new Promise<void>((resolve, reject) => {
      child.on('message', (msg) => { if (msg === 'ready') resolve(); });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code !== 0) reject(new Error(`worker exited ${code} before signalling ready: ${stderr}`));
      });
    });
    const exit = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code) => resolve({ code, stderr }));
    });
    return {
      ready,
      go: () => { child.send('go'); },
      exit,
      kill: () => { try { child.kill('SIGKILL'); } catch { /* already dead */ } },
    };
  }

  // Spawn N workers and hold them at an IPC barrier until all are loaded,
  // then release them simultaneously so they actually race inside migrate().
  // If any worker fails before ready, kill the rest so they don't hang on
  // their barrier and leak child processes into the test runner.
  async function raceWorkers(dbPath: string, n: number): Promise<Array<{ code: number | null; stderr: string }>> {
    const workers = Array.from({ length: n }, () => spawnWorker(dbPath));
    try {
      await Promise.all(workers.map((w) => w.ready));
      for (const w of workers) w.go();
      return await Promise.all(workers.map((w) => w.exit));
    } catch (err) {
      for (const w of workers) w.kill();
      await Promise.allSettled(workers.map((w) => w.exit));
      throw err;
    }
  }

  // Inspect the DB with a raw driver — do NOT use getDb() here, since that
  // would re-run migrate() and could mask whatever partial state the
  // concurrent workers left behind (which is precisely what we want to detect).
  function inspect<T>(dbPath: string, fn: (db: Driver) => T): T {
    closeDb();
    const raw = openDriver(dbPath);
    try {
      return fn(raw);
    } finally {
      raw.close();
    }
  }

  // Pinned to the latest migration version in src/storage/db.ts MIGRATIONS.
  // Bump this when a new migration is appended — the assertion guards against
  // a concurrent startup silently leaving the schema behind the source of
  // truth (e.g. observed [1,2,3] would otherwise satisfy a self-referential
  // "contiguous 1..length" check).
  const LATEST_MIGRATION = 4;

  function assertSchemaMigrationsIsConsistent(dbPath: string): void {
    inspect(dbPath, (db) => {
      const versions = db
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all() as Array<{ version: number }>;
      const observed = versions.map((v) => v.version);
      const expected = Array.from({ length: LATEST_MIGRATION }, (_, i) => i + 1);
      expect(observed).toEqual(expected); // strict: 1..LATEST contiguous, no dups, no gaps, no missing tail
    });
  }

  it('two concurrent processes opening a fresh DB both complete successfully', async () => {
    const dbPath = makeTmpDbPath();
    const [a, b] = await raceWorkers(dbPath, 2);
    expect(a, `child A stderr: ${a!.stderr}`).toMatchObject({ code: 0 });
    expect(b, `child B stderr: ${b!.stderr}`).toMatchObject({ code: 0 });
    assertSchemaMigrationsIsConsistent(dbPath);
  });

  it('two concurrent processes opening an already-migrated DB both complete successfully', async () => {
    const dbPath = makeTmpDbPath();
    getDb(dbPath);
    closeDb();
    const [a, b] = await raceWorkers(dbPath, 2);
    expect(a, `child A stderr: ${a!.stderr}`).toMatchObject({ code: 0 });
    expect(b, `child B stderr: ${b!.stderr}`).toMatchObject({ code: 0 });
    assertSchemaMigrationsIsConsistent(dbPath);
  });

  it('two concurrent processes applying a newly-released migration both complete successfully', async () => {
    // Simulates the most realistic regression scenario for #21: a new korinfra
    // release adds migration N+1, and two processes start up against the same
    // existing DB at the same time. With DEFERRED semantics this is the path
    // that hits SQLITE_BUSY_SNAPSHOT (which busy_timeout does NOT retry).
    //
    // Pinned to migration 4 (which adds the monthly_cost_source column) rather
    // than dynamically "the latest version", because the schema rollback below
    // is specific to that migration. When future migrations are added, this
    // test remains valid as a regression for the migration-4 deployment race.
    // If migration 4 itself is ever modified, update both lines together.
    const dbPath = makeTmpDbPath();
    const setup = getDb(dbPath);
    setup.exec('ALTER TABLE resources DROP COLUMN monthly_cost_source');
    setup.prepare('DELETE FROM schema_migrations WHERE version = 4').run();
    closeDb();

    const [a, b] = await raceWorkers(dbPath, 2);
    expect(a, `child A stderr: ${a!.stderr}`).toMatchObject({ code: 0 });
    expect(b, `child B stderr: ${b!.stderr}`).toMatchObject({ code: 0 });
    assertSchemaMigrationsIsConsistent(dbPath);

    // Verify migration 4 actually re-applied: the column should exist again.
    inspect(dbPath, (db) => {
      const columns = db.prepare(`PRAGMA table_info(resources)`).all() as Array<{ name: string }>;
      expect(columns.some((c) => c.name === 'monthly_cost_source')).toBe(true);
    });
  });

  it('three concurrent processes opening a fresh DB all complete successfully', async () => {
    const dbPath = makeTmpDbPath();
    const [a, b, c] = await raceWorkers(dbPath, 3);
    expect(a, `child A stderr: ${a!.stderr}`).toMatchObject({ code: 0 });
    expect(b, `child B stderr: ${b!.stderr}`).toMatchObject({ code: 0 });
    expect(c, `child C stderr: ${c!.stderr}`).toMatchObject({ code: 0 });
    assertSchemaMigrationsIsConsistent(dbPath);
  });
});

// ---------------------------------------------------------------------------
// Driver.transaction — mode parameter
// ---------------------------------------------------------------------------

describe('Driver.transaction — mode parameter', () => {
  it('accepts DEFERRED, IMMEDIATE, and EXCLUSIVE modes', () => {
    const db = getDb(makeTmpDbPath());
    expect(() => db.transaction(() => undefined, { mode: 'DEFERRED' })).not.toThrow();
    expect(() => db.transaction(() => undefined, { mode: 'IMMEDIATE' })).not.toThrow();
    expect(() => db.transaction(() => undefined, { mode: 'EXCLUSIVE' })).not.toThrow();
  });

  it('defaults to DEFERRED when no mode is provided', () => {
    const db = getDb(makeTmpDbPath());
    expect(() => db.transaction(() => undefined)).not.toThrow();
  });

  it('throws on invalid runtime mode value (defense against JS callers and casts)', () => {
    const db = getDb(makeTmpDbPath());
    // Cast a bogus string through the type system to simulate a JS caller
    // or a `mode: someStringVar as TransactionMode` pattern.
    expect(() =>
      db.transaction(() => undefined, { mode: 'BOGUS' as 'DEFERRED' }),
    ).toThrow(/Invalid transaction mode/);
  });
});

// ---------------------------------------------------------------------------
// Foreign key enforcement
// ---------------------------------------------------------------------------

describe('foreign key enforcement', () => {
  it('rejects resource referencing non-existent scan, allows when scan exists', () => {
    const db = getDb(makeTmpDbPath());
    expect(() => {
      db.exec(`INSERT INTO resources (id, scan_id, resource_id, type) VALUES ('r1', 'non-existent-scan', 'i-12345', 'ec2')`);
    }).toThrow();

    db.exec(`INSERT INTO scans (id, started_at, status) VALUES ('scan-1', datetime('now'), 'running')`);
    expect(() => {
      db.exec(`INSERT INTO resources (id, scan_id, resource_id, type) VALUES ('r1', 'scan-1', 'i-12345', 'ec2')`);
    }).not.toThrow();
  });
});
