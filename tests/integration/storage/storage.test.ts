import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../../helpers/db.js';
import { insertScan, getScan, listScans, deleteScan, updateScanStatus } from '../../../src/storage/queries/scans.js';
import { insertResources, listResources } from '../../../src/storage/queries/resources.js';
import { upsertPrice, getPrice, purgeExpired, getCacheStats } from '../../../src/storage/queries/pricing.js';
import type { Driver } from '../../../src/storage/drivers/node.js';
import type { Scan } from '../../../src/storage/queries/scans.js';
import type { Resource } from '../../../src/storage/queries/resources.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const _dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(_dirname, '../../../src/storage/migrations');

// ─── In-memory DB setup ───────────────────────────────────────────────────────

function makeScan(id: string, overrides: Partial<Scan> = {}): Scan {
  return {
    id,
    started_at: new Date().toISOString(),
    status: 'completed',
    total_resources: 0,
    total_cost: 0,
    total_recommendations: 0,
    total_savings: 0,
    scenario_a_count: 0,
    scenario_b_count: 0,
    scenario_c_count: 0,
    ...overrides,
  };
}

function makeResource(resourceId: string, overrides: Partial<Resource> = {}): Resource {
  return {
    resource_id: resourceId,
    type: 'ec2_instance',
    name: 'web',
    region: 'us-east-1',
    state: 'running',
    instance_type: 't3.medium',
    monthly_cost: 30.45,
    tags: { Name: 'web', Environment: 'prod' },
    configuration: { instance_type: 't3.medium' },
    scenario: 'B',
    ...overrides,
  };
}

// ─── Migrations ───────────────────────────────────────────────────────────────

describe('storage — migrations', () => {
  it('creates all expected tables and is idempotent', () => {
    const db = createTestDb();
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all() as Array<{ name: string }>).map((r) => r.name);

    for (const t of ['scans', 'resources', 'costs', 'recommendations', 'pricing_cache', 'api_call_log', 'schema_migrations']) {
      expect(tables).toContain(t);
    }

    // idempotent: running migrations twice must not throw
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      expect(() => db.exec(sql)).not.toThrow();
    }
    db.close();
  });
});

// ─── Scans CRUD ───────────────────────────────────────────────────────────────

describe('storage — scans CRUD', () => {
  let db: Driver;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('insert, retrieve, list, update status, delete with cascade, and store metadata', () => {
    // insert + retrieve
    insertScan(db, makeScan('scan-1'));
    const found = getScan(db, 'scan-1');
    expect(found).not.toBeNull();
    expect(found!.id).toBe('scan-1');
    expect(found!.status).toBe('completed');

    // returns null for missing
    expect(getScan(db, 'does-not-exist')).toBeNull();

    // list ordered by started_at DESC
    insertScan(db, makeScan('scan-a', { started_at: '2024-01-01T00:00:00Z' }));
    insertScan(db, makeScan('scan-b', { started_at: '2024-02-01T00:00:00Z' }));
    const scans = listScans(db);
    const scanAIdx = scans.findIndex((s) => s.id === 'scan-a');
    const scanBIdx = scans.findIndex((s) => s.id === 'scan-b');
    expect(scanBIdx).toBeLessThan(scanAIdx);

    // updateScanStatus
    insertScan(db, makeScan('scan-upd', { status: 'running' }));
    updateScanStatus(db, 'scan-upd', 'completed', new Date().toISOString());
    expect(getScan(db, 'scan-upd')!.status).toBe('completed');

    // delete cascades to resources
    const scanDel = makeScan('scan-del');
    insertScan(db, scanDel);
    insertResources(db, 'scan-del', [makeResource('r-1')]);
    deleteScan(db, 'scan-del');
    expect(getScan(db, 'scan-del')).toBeNull();
    expect(listResources(db, 'scan-del')).toHaveLength(0);

    // metadata stored as JSON
    insertScan(db, makeScan('scan-meta', { metadata: { key: 'value', count: 42 } }));
    expect(getScan(db, 'scan-meta')!.metadata).toEqual({ key: 'value', count: 42 });
  });
});

// ─── Resources CRUD ───────────────────────────────────────────────────────────

describe('storage — resources CRUD', () => {
  let db: Driver;
  beforeEach(() => {
    db = createTestDb();
    insertScan(db, makeScan('scan-1'));
  });
  afterEach(() => { db.close(); });

  it('inserts and retrieves with filters, ordering, JSON fields, and bulk insert', () => {
    insertResources(db, 'scan-1', [makeResource('i-abc123')]);
    const resources = listResources(db, 'scan-1');
    expect(resources).toHaveLength(1);
    expect(resources[0]!.resource_id).toBe('i-abc123');
    expect(resources[0]!.type).toBe('ec2_instance');
    expect(resources[0]!.tags).toEqual({ Name: 'web', Environment: 'prod' });
    expect(resources[0]!.configuration).toEqual({ instance_type: 't3.medium' });

    // ordering by monthly_cost DESC
    insertResources(db, 'scan-1', [makeResource('i-cheap', { monthly_cost: 10 }), makeResource('i-expensive', { monthly_cost: 500 })]);
    const ordered = listResources(db, 'scan-1');
    expect(ordered[0]!.resource_id).toBe('i-expensive');

    // filter by type
    insertResources(db, 'scan-1', [makeResource('db-rds', { type: 'rds_instance' })]);
    const ec2 = listResources(db, 'scan-1', { type: 'ec2_instance' });
    expect(ec2.every((r) => r.type === 'ec2_instance')).toBe(true);

    // filter by region
    insertResources(db, 'scan-1', [makeResource('i-west', { region: 'us-west-2' })]);
    const east = listResources(db, 'scan-1', { region: 'us-east-1' });
    expect(east.every((r) => r.region === 'us-east-1')).toBe(true);

    // bulk insert
    const bulk = Array.from({ length: 50 }, (_, i) => makeResource(`i-bulk-${i}`, { monthly_cost: i * 2 }));
    insertResources(db, 'scan-1', bulk);
    // returns empty for unknown scan
    expect(listResources(db, 'scan-unknown')).toHaveLength(0);
  });

  it('cascade delete: deleting scan removes its resources without affecting others', () => {
    insertScan(db, makeScan('scan-keep'));
    insertResources(db, 'scan-keep', [makeResource('r-keep')]);
    insertResources(db, 'scan-1', [makeResource('r-1'), makeResource('r-2')]);

    deleteScan(db, 'scan-1');
    expect(listResources(db, 'scan-1')).toHaveLength(0);
    expect(listResources(db, 'scan-keep')).toHaveLength(1);
    expect(getScan(db, 'scan-keep')).not.toBeNull();
  });
});

// ─── Pricing cache ────────────────────────────────────────────────────────────

describe('storage — pricing cache', () => {
  let db: Driver;
  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('upserts, updates, expires, purges, and returns stats', () => {
    // insert + retrieve
    upsertPrice(db, 'AmazonEC2', 't3.medium:Linux', 'us-east-1', 0.0416);
    const entry = getPrice(db, 'AmazonEC2', 't3.medium:Linux', 'us-east-1');
    expect(entry).not.toBeNull();
    expect(entry!.hourly_price).toBeCloseTo(0.0416, 6);
    expect(entry!.service_code).toBe('AmazonEC2');

    // upsert updates price
    upsertPrice(db, 'AmazonEC2', 't3.medium:Linux', 'us-east-1', 0.0500);
    expect(getPrice(db, 'AmazonEC2', 't3.medium:Linux', 'us-east-1')!.hourly_price).toBeCloseTo(0.0500, 6);

    // expired entry returns null
    upsertPrice(db, 'AmazonEC2', 't3.expired:Linux', 'us-east-1', 0.0416, null, 0);
    expect(getPrice(db, 'AmazonEC2', 't3.expired:Linux', 'us-east-1')).toBeNull();

    // different region returns null
    expect(getPrice(db, 'AmazonEC2', 't3.medium:Linux', 'us-west-2')).toBeNull();

    // purgeExpired removes expired, keeps valid
    upsertPrice(db, 'AmazonEC2', 't3.valid:Linux', 'us-east-1', 0.0416, null, 7);
    const deleted = purgeExpired(db);
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(getPrice(db, 'AmazonEC2', 't3.valid:Linux', 'us-east-1')).not.toBeNull();

    // getCacheStats
    upsertPrice(db, 'AmazonEC2', 't3.small:Linux', 'us-east-1', 0.0208, { family: 't3' });
    const stats = getCacheStats(db);
    expect(stats.count).toBeGreaterThanOrEqual(1);
    expect(stats.total_size_bytes).toBeGreaterThanOrEqual(0);

    // attributes stored as JSON
    const attrs = { vcpu: '2', memory: '4 GiB', operatingSystem: 'Linux' };
    upsertPrice(db, 'AmazonEC2', 't3.attrs:Linux', 'us-east-1', 0.0416, attrs);
    expect(getPrice(db, 'AmazonEC2', 't3.attrs:Linux', 'us-east-1')!.attributes).toEqual(attrs);
  });
});
