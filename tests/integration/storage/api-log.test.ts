import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, closeDb } from '../../../src/storage/db.js';
import { insertApiCall, listApiCalls } from '../../../src/storage/queries/api-log.js';
import type { ApiCallEntry } from '../../../src/storage/queries/api-log.js';

let tmpDir: string;

function makeTmpDbPath(): string {
  return path.join(tmpDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'korinfra-apilog-test-'));
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

describe('insertApiCall + listApiCalls', () => {
  it('inserts a full entry and lists it back with correct values', () => {
    const db = getDb(makeTmpDbPath());

    // scan_id is a FK to scans(id) — insert parent row first
    db.exec(`INSERT INTO scans (id, started_at, status) VALUES ('scan-001', datetime('now'), 'running')`);

    const entry: ApiCallEntry = {
      scan_id: 'scan-001',
      service: 'ec2',
      operation: 'DescribeInstances',
      region: 'us-east-1',
      estimated_cost: 0.005,
      duration_ms: 123,
      status: 'success',
      error_message: null,
    };

    insertApiCall(db, entry);
    const rows = listApiCalls(db);

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.scan_id).toBe('scan-001');
    expect(row.service).toBe('ec2');
    expect(row.operation).toBe('DescribeInstances');
    expect(row.region).toBe('us-east-1');
    expect(row.estimated_cost).toBe(0.005);
    expect(row.duration_ms).toBe(123);
    expect(row.status).toBe('success');
    expect(row.error_message).toBeNull();
    expect(row.id).toBeDefined();
    expect(row.created_at).toBeDefined();
  });

  it('applies null/undefined defaults for optional fields', () => {
    const db = getDb(makeTmpDbPath());
    const entry: ApiCallEntry = {
      service: 's3',
      operation: 'ListBuckets',
      status: 'success',
    };

    insertApiCall(db, entry);
    const rows = listApiCalls(db);

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.scan_id).toBeNull();
    expect(row.region).toBeNull();
    expect(row.estimated_cost).toBe(0);
    expect(row.duration_ms).toBeNull();
    expect(row.error_message).toBeNull();
  });

  it('returns all entries ordered by created_at DESC', () => {
    const db = getDb(makeTmpDbPath());

    // Insert rows with explicit ISO timestamps 1 second apart — guarantees strict ordering
    // even on fast machines where CURRENT_TIMESTAMP would give identical seconds.
    const t1 = '2024-01-01 10:00:00';
    const t2 = '2024-01-01 10:00:01';
    const t3 = '2024-01-01 10:00:02';
    db.exec(`INSERT INTO api_call_log (service, operation, status, created_at) VALUES ('ec2', 'DescribeInstances', 'success', '${t1}')`);
    db.exec(`INSERT INTO api_call_log (service, operation, status, created_at) VALUES ('s3', 'ListBuckets', 'success', '${t2}')`);
    db.exec(`INSERT INTO api_call_log (service, operation, status, created_at) VALUES ('rds', 'DescribeDBInstances', 'error', '${t3}')`);

    const rows = listApiCalls(db);
    expect(rows).toHaveLength(3);

    // Verify strict DESC order — each created_at must be strictly greater than the next
    for (let i = 0; i < rows.length - 1; i++) {
      expect(rows[i]!.created_at! > rows[i + 1]!.created_at!).toBe(true);
    }
  });

  it('filters by since timestamp', () => {
    const db = getDb(makeTmpDbPath());

    // Insert an entry and capture a timestamp after it
    insertApiCall(db, { service: 'ec2', operation: 'DescribeInstances', status: 'success' });

    const since = new Date(Date.now() + 1000).toISOString().replace('T', ' ').slice(0, 19);

    // Insert another entry whose created_at will be >= since (force via direct SQL)
    db.exec(`
      INSERT INTO api_call_log (service, operation, status, created_at)
      VALUES ('s3', 'ListBuckets', 'success', '${since}')
    `);

    const rows = listApiCalls(db, since);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(row.created_at! >= since).toBe(true);
    }
  });

  it('filters by service', () => {
    const db = getDb(makeTmpDbPath());

    insertApiCall(db, { service: 'ec2', operation: 'DescribeInstances', status: 'success' });
    insertApiCall(db, { service: 's3', operation: 'ListBuckets', status: 'success' });
    insertApiCall(db, { service: 'ec2', operation: 'DescribeVolumes', status: 'success' });

    const rows = listApiCalls(db, undefined, 'ec2');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.service).toBe('ec2');
    }
  });

  it('filters by both since and service combined', () => {
    const db = getDb(makeTmpDbPath());

    insertApiCall(db, { service: 'ec2', operation: 'DescribeInstances', status: 'success' });

    const since = new Date(Date.now() + 1000).toISOString().replace('T', ' ').slice(0, 19);

    db.exec(`
      INSERT INTO api_call_log (service, operation, status, created_at)
      VALUES ('ec2', 'DescribeVolumes', 'success', '${since}')
    `);
    db.exec(`
      INSERT INTO api_call_log (service, operation, status, created_at)
      VALUES ('s3', 'ListBuckets', 'success', '${since}')
    `);

    const rows = listApiCalls(db, since, 'ec2');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.service).toBe('ec2');
    expect(rows[0]!.operation).toBe('DescribeVolumes');
  });

  it('returns empty array when table is empty', () => {
    const db = getDb(makeTmpDbPath());
    const rows = listApiCalls(db);
    expect(rows).toEqual([]);
  });
});
