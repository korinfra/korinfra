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
import { getDb, closeDb, getDbOrNull } from '../../../src/storage/db.js';

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
