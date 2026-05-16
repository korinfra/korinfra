import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { logger } from '../utils/logger.js';

import {
  defaultConfigDir,
  defaultStoragePath,
  expandPath,
} from '../config/paths.js';
import { openDriver } from './drivers/node.js';
import type { Driver } from './drivers/node.js';

// ─── Migration loader ─────────────────────────────────────────────────────────

const CONFIG_FILENAMES = [
  '.korinfra/config.yaml',
  '.korinfra/config.yml',
  '.korinfra/config.json',
] as const;

function readStoragePathFromConfigFile(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = filePath.endsWith('.json')
      ? (JSON.parse(content) as Record<string, unknown>)
      : (yaml.load(content, { schema: yaml.JSON_SCHEMA }) as Record<string, unknown> | null);
    const storage = parsed?.['storage'];
    if (typeof storage === 'object' && storage !== null) {
      const storagePath = (storage as Record<string, unknown>)['path'];
      if (typeof storagePath === 'string' && storagePath.trim() !== '') {
        return expandPath(storagePath);
      }
    }
  } catch {
    // Ignore malformed or unreadable config here; main config loader reports these explicitly elsewhere.
  }

  return null;
}

/**
 * Resolves the storage path by scanning known config filenames in common directories.
 * NOTE: This searches a fixed list of filenames and may not match the config file
 * actually loaded by cosmiconfig (e.g. korinfra.config.js). Callers should prefer
 * passing the resolved path from loadConfig() directly to getDb().
 */
function resolveConfiguredStoragePath(): string {
  const envPath = process.env['KORINFRA_STORAGE_PATH'];
  if (envPath && envPath.trim() !== '') {
    return path.resolve(expandPath(envPath));
  }

  const searchDirs = [process.cwd(), defaultConfigDir()];

  for (const dir of searchDirs) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.join(dir, name);
      const configured = readStoragePathFromConfigFile(candidate);
      if (configured) return configured;
    }
  }

  return defaultStoragePath();
}

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `-- korinfra initial schema
-- All tables use IF NOT EXISTS for idempotent migrations.

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scans (
    id TEXT PRIMARY KEY,
    started_at DATETIME NOT NULL,
    completed_at DATETIME,
    status TEXT NOT NULL DEFAULT 'running',
    terraform_path TEXT,
    aws_profile TEXT,
    aws_region TEXT,
    total_resources INTEGER DEFAULT 0,
    total_cost REAL DEFAULT 0,
    total_recommendations INTEGER DEFAULT 0,
    total_savings REAL DEFAULT 0,
    scenario_a_count INTEGER DEFAULT 0,
    scenario_b_count INTEGER DEFAULT 0,
    scenario_c_count INTEGER DEFAULT 0,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS resources (
    id TEXT PRIMARY KEY,
    scan_id TEXT NOT NULL REFERENCES scans(id),
    resource_id TEXT NOT NULL,
    arn TEXT,
    type TEXT NOT NULL,
    name TEXT,
    region TEXT,
    state TEXT,
    instance_type TEXT,
    monthly_cost REAL DEFAULT 0,
    tags TEXT,
    utilization TEXT,
    configuration TEXT,
    scenario TEXT,
    terraform_address TEXT,
    collected_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS costs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id TEXT NOT NULL REFERENCES scans(id),
    service_name TEXT NOT NULL,
    region TEXT,
    cost_date DATE NOT NULL,
    daily_cost REAL DEFAULT 0,
    monthly_cost REAL DEFAULT 0,
    currency TEXT DEFAULT 'USD',
    usage_type TEXT,
    tags TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recommendations (
    id TEXT PRIMARY KEY,
    scan_id TEXT NOT NULL REFERENCES scans(id),
    resource_id TEXT,
    resource_type TEXT,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    reasoning TEXT,
    estimated_savings REAL DEFAULT 0,
    confidence REAL DEFAULT 0,
    quality_score INTEGER DEFAULT 0,
    impact TEXT DEFAULT 'medium',
    risk TEXT DEFAULT 'low',
    status TEXT DEFAULT 'draft',
    current_config TEXT,
    suggested_config TEXT,
    patch_content TEXT,
    file_path TEXT,
    implementation_steps TEXT,
    ai_model TEXT,
    scenario TEXT,
    applied_at DATETIME,
    dismissed_at DATETIME,
    dismiss_reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS virtual_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resource_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    dimension TEXT NOT NULL,
    value TEXT NOT NULL,
    allocation_pct REAL DEFAULT 100.0,
    source TEXT DEFAULT 'manual',
    confidence REAL DEFAULT 1.0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(resource_id, dimension, value)
);

CREATE TABLE IF NOT EXISTS pricing_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_code TEXT NOT NULL,
    resource_key TEXT NOT NULL,
    region TEXT NOT NULL,
    hourly_price REAL NOT NULL,
    price_unit TEXT DEFAULT 'Hrs',
    attributes TEXT,
    fetched_at DATETIME NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(service_code, resource_key, region)
);

CREATE TABLE IF NOT EXISTS api_call_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id TEXT REFERENCES scans(id),
    service TEXT NOT NULL,
    operation TEXT NOT NULL,
    region TEXT,
    estimated_cost REAL DEFAULT 0,
    duration_ms INTEGER,
    status TEXT NOT NULL,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_resources_scan ON resources(scan_id);
CREATE INDEX IF NOT EXISTS idx_resources_type ON resources(type);
CREATE INDEX IF NOT EXISTS idx_resources_scenario ON resources(scenario);
CREATE INDEX IF NOT EXISTS idx_costs_scan ON costs(scan_id);
CREATE INDEX IF NOT EXISTS idx_costs_service ON costs(service_name);
CREATE INDEX IF NOT EXISTS idx_costs_date ON costs(cost_date);
CREATE INDEX IF NOT EXISTS idx_recommendations_scan ON recommendations(scan_id);
CREATE INDEX IF NOT EXISTS idx_recommendations_status ON recommendations(status);
CREATE INDEX IF NOT EXISTS idx_recommendations_type ON recommendations(type);
CREATE INDEX IF NOT EXISTS idx_virtual_tags_resource ON virtual_tags(resource_id);
CREATE INDEX IF NOT EXISTS idx_pricing_cache_key ON pricing_cache(service_code, resource_key, region);
CREATE INDEX IF NOT EXISTS idx_pricing_cache_expires ON pricing_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_api_call_log_scan ON api_call_log(scan_id);
CREATE INDEX IF NOT EXISTS idx_api_call_log_service ON api_call_log(service);
CREATE INDEX IF NOT EXISTS idx_scans_created_at ON scans(created_at);
`,
  },
  {
    version: 2,
    sql: `
    CREATE INDEX IF NOT EXISTS idx_resources_scan_type ON resources(scan_id, type);
    CREATE INDEX IF NOT EXISTS idx_recommendations_scan_resource_status ON recommendations(scan_id, resource_id, status);
    CREATE INDEX IF NOT EXISTS idx_costs_scan_service_date ON costs(scan_id, service_name, cost_date);
  `,
  },
  {
    version: 3,
    sql: `
    ALTER TABLE resources RENAME TO resources_old;
    CREATE TABLE resources (
        id TEXT PRIMARY KEY,
        scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
        resource_id TEXT NOT NULL,
        arn TEXT,
        type TEXT NOT NULL,
        name TEXT,
        region TEXT,
        state TEXT,
        instance_type TEXT,
        monthly_cost REAL DEFAULT 0,
        tags TEXT,
        utilization TEXT,
        configuration TEXT,
        scenario TEXT,
        terraform_address TEXT,
        collected_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO resources SELECT * FROM resources_old;
    DROP TABLE resources_old;

    ALTER TABLE costs RENAME TO costs_old;
    CREATE TABLE costs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
        service_name TEXT NOT NULL,
        region TEXT,
        cost_date DATE NOT NULL,
        daily_cost REAL DEFAULT 0,
        monthly_cost REAL DEFAULT 0,
        currency TEXT DEFAULT 'USD',
        usage_type TEXT,
        tags TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO costs SELECT * FROM costs_old;
    DROP TABLE costs_old;

    ALTER TABLE recommendations RENAME TO recommendations_old;
    CREATE TABLE recommendations (
        id TEXT PRIMARY KEY,
        scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
        resource_id TEXT,
        resource_type TEXT,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        reasoning TEXT,
        estimated_savings REAL DEFAULT 0,
        confidence REAL DEFAULT 0,
        quality_score INTEGER DEFAULT 0,
        impact TEXT DEFAULT 'medium',
        risk TEXT DEFAULT 'low',
        status TEXT DEFAULT 'draft',
        current_config TEXT,
        suggested_config TEXT,
        patch_content TEXT,
        file_path TEXT,
        implementation_steps TEXT,
        ai_model TEXT,
        scenario TEXT,
        applied_at DATETIME,
        dismissed_at DATETIME,
        dismiss_reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO recommendations SELECT * FROM recommendations_old;
    DROP TABLE recommendations_old;

    ALTER TABLE api_call_log RENAME TO api_call_log_old;
    CREATE TABLE api_call_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_id TEXT REFERENCES scans(id) ON DELETE CASCADE,
        service TEXT NOT NULL,
        operation TEXT NOT NULL,
        region TEXT,
        estimated_cost REAL DEFAULT 0,
        duration_ms INTEGER,
        status TEXT NOT NULL,
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO api_call_log SELECT * FROM api_call_log_old;
    DROP TABLE api_call_log_old;
  `,
  },
  {
    version: 4,
    sql: `
    ALTER TABLE resources ADD COLUMN monthly_cost_source TEXT;
  `,
  },
];

(function validateMigrations() {
  for (let i = 0; i < MIGRATIONS.length; i++) {
    const m = MIGRATIONS[i];
    if (m === undefined) throw new Error(`Missing migration at index ${i}`);
    if (m.version !== i + 1) {
      throw new Error(`Migration version mismatch at index ${i}: expected ${i + 1}, got ${String(m.version)}`);
    }
  }
})();

function loadMigrations(): Array<{ version: number; sql: string }> {
  return MIGRATIONS;
}

// ─── WAL mode setup ───────────────────────────────────────────────────────────

// Pre-allocated wait buffer for sync sleep in setWalMode.
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

/**
 * Set journal_mode = WAL with retry. Two processes opening the same fresh DB
 * file simultaneously can race on `PRAGMA journal_mode = WAL` — the operation
 * needs a brief exclusive lock to checkpoint and rewrite the file header, and
 * SQLite's busy handler does not always retry it (in contrast to ordinary
 * SQLITE_BUSY paths covered by busy_timeout). Both the lock-free read
 * short-circuit and the write retry live inside the same try/catch: the
 * read itself can transiently raise a busy/locked error mid-checkpoint.
 * Backoff is exponential (50, 100, 200, 400 ms) capped at 500 ms.
 */
function setWalMode(db: Driver): void {
  const deadline = Date.now() + 30_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    try {
      const current = ((db.pragma('journal_mode', { simple: true }) as string | undefined) ?? '').toLowerCase();
      if (current === 'wal') return;
      const result = ((db.pragma('journal_mode = WAL', { simple: true }) as string | undefined) ?? '').toLowerCase();
      if (result !== 'wal') {
        logger.warn({ walResult: result }, 'WAL mode not enabled; journal_mode may be restricted');
      }
      return;
    } catch (err) {
      const msg = ((err as Error).message ?? '').toLowerCase();
      if (!msg.includes('busy') && !msg.includes('lock')) throw err;
      const delayMs = Math.min(50 * 2 ** attempt, 500);
      attempt++;
      Atomics.wait(SLEEP_BUFFER, 0, 0, delayMs);
    }
  }
  throw new Error('Failed to set journal_mode = WAL within 30s — another process may be holding the database lock');
}

// ─── Migration runner ─────────────────────────────────────────────────────────

function migrate(db: Driver): void {
  // Sort ascending so gaps can be detected and migrations run in order
  const migrations = loadMigrations().slice().sort((a, b) => a.version - b.version);

  // Wrap the entire migration sequence — bootstrap, read, and every migration step —
  // in a single BEGIN IMMEDIATE transaction. This serialises concurrent migrators across
  // processes: the second `migrate()` call blocks at BEGIN IMMEDIATE (within busy_timeout)
  // until the first commits, then its read snapshot reflects the fully populated
  // schema_migrations table and it correctly skips already-applied versions.
  // DEFERRED would be unsafe here on an already-migrated DB: the CREATE TABLE IF NOT EXISTS
  // and SELECT would run as reads, and a subsequent write attempt could fail with
  // SQLITE_BUSY_SNAPSHOT (which busy_timeout does not retry).
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    const applied = new Set<number>(
      (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version),
    );

    let prevVersion = 0;
    for (const { version, sql } of migrations) {
      if (applied.has(version)) {
        prevVersion = version;
        continue;
      }

      if (version > prevVersion + 1 && prevVersion > 0) {
        logger.warn({ expected: prevVersion + 1, got: version }, 'Migration version gap detected');
      }

      db.exec(sql);
      db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        version,
        new Date().toISOString(),
      );

      prevVersion = version;
    }
  }, { mode: 'IMMEDIATE' });
}

// ─── Retention purge ─────────────────────────────────────────────────────────

/**
 * Deletes scans (and their child rows) older than retentionDays.
 * Child tables (resources, costs, recommendations, api_call_log) lack CASCADE DELETE,
 * so they are purged explicitly before removing the parent scans rows.
 */
function purgeOldScans(db: Driver, retentionDays: number): void {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  db.transaction(() => {
    db.prepare(`DELETE FROM api_call_log WHERE scan_id IN (SELECT id FROM scans WHERE created_at < ?)`).run(cutoff);
    // Purge orphaned api_call_log rows (no associated scan) older than retention window.
    db.prepare(`DELETE FROM api_call_log WHERE scan_id IS NULL AND created_at < ?`).run(cutoff);
    db.prepare(`DELETE FROM recommendations WHERE scan_id IN (SELECT id FROM scans WHERE created_at < ?)`).run(cutoff);
    db.prepare(`DELETE FROM costs WHERE scan_id IN (SELECT id FROM scans WHERE created_at < ?)`).run(cutoff);
    db.prepare(`DELETE FROM resources WHERE scan_id IN (SELECT id FROM scans WHERE created_at < ?)`).run(cutoff);
    db.prepare(`DELETE FROM scans WHERE created_at < ?`).run(cutoff);
  });
  // Reclaim freed pages without a full VACUUM lock.
  db.pragma('incremental_vacuum(100)');
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _instance: Driver | null = null;
let _instancePath: string | null = null;

/**
 * Returns (or creates) the singleton database connection.
 * Enables WAL mode, foreign keys, and runs pending migrations.
 * On first open, purges scans older than retentionDays (default 365).
 *
 * @param dbPath        - Optional override; defaults to config storage.path or .korinfra/data.db
 * @param retentionDays - How many days of scan history to keep (default 365)
 */
export function getDb(dbPath?: string, retentionDays = 365): Driver {
  const resolvedPath = dbPath ?? resolveConfiguredStoragePath();

  if (_instance) {
    if (_instancePath !== resolvedPath) {
      throw new Error(
        `Database already open at "${_instancePath}" — cannot open "${resolvedPath}" in same process`,
      );
    }
    return _instance;
  }

  // Ensure parent directory exists
  const dir = path.dirname(resolvedPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* windows */ }

  let prevMask: number | undefined;
  try { prevMask = process.umask(0o177); } catch { /* windows — umask not available */ }
  const db = openDriver(resolvedPath);
  if (prevMask !== undefined) {
    try { process.umask(prevMask); } catch { /* ignore */ }
  }

  try {
    fs.chmodSync(resolvedPath, 0o600);
  } catch (chmodErr) {
    // Expected on Windows (ENOSYS) or filesystems without permission support.
    // Log a warning on Unix for unexpected failures.
    const code = (chmodErr as NodeJS.ErrnoException).code;
    if (code !== 'ENOSYS' && code !== 'EPERM' && process.platform !== 'win32') {
      logger.warn({ err: String(chmodErr) }, 'Failed to set database file permissions to 0o600');
    }
  }

  // Performance & correctness pragmas. busy_timeout is set first so that ordinary
  // SQLITE_BUSY errors on subsequent statements are retried by SQLite's default
  // busy handler. WAL setup needs its own application-level retry (see setWalMode).
  db.pragma('busy_timeout = 30000');
  setWalMode(db);
  db.pragma('foreign_keys = ON');
  const fkEnabled = db.pragma('foreign_keys', { simple: true }) as number;
  if (fkEnabled !== 1) {
    throw new Error('Failed to enable foreign key enforcement — data integrity cannot be guaranteed');
  }

  migrate(db);

  purgeOldScans(db, retentionDays);

  _instance = db;
  _instancePath = resolvedPath;
  return db;
}

/** Closes the singleton database connection and resets the singleton. */
export function closeDb(): void {
  if (_instance) {
    _instance.close();
    _instance = null;
    _instancePath = null;
  }
}

/** Returns the current singleton instance, or null if not open. */
export function getDbOrNull(): Driver | null {
  return _instance;
}
