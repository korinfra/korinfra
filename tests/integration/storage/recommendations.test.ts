import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../../helpers/db.js';
import { insertScan } from '../../../src/storage/queries/scans.js';
import {
  insertRecommendations,
  listRecommendations,
  updateRecommendationStatus,
  upsertRecommendations,
} from '../../../src/storage/queries/recommendations.js';
import type { Driver } from '../../../src/storage/drivers/node.js';
import type { Recommendation } from '../../../src/storage/queries/recommendations.js';

function makeScan(id: string) {
  return { id, started_at: new Date().toISOString(), status: 'completed' as const, total_resources: 0, total_cost: 0, total_recommendations: 0, total_savings: 0, scenario_a_count: 0, scenario_b_count: 0, scenario_c_count: 0 };
}

function makeRec(id: string, overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    id,
    scan_id: 'scan-1',
    resource_id: 'i-0a1b2c3d4e5f67890',
    resource_type: 'ec2_instance',
    type: 'rightsizing',
    title: 'Downsize m5.xlarge to m5.large',
    description: 'Instance CPU utilization is below 10% for 30 days',
    reasoning: 'Consistent low utilization detected via CloudWatch metrics',
    estimated_savings: 345.67,
    confidence: 0.92,
    quality_score: 0.88,
    impact: 'high',
    risk: 'low',
    status: 'draft',
    scenario: 'B',
    ...overrides,
  };
}

// ─── recommendations CRUD ────────────────────────────────────────────────────

describe('storage — recommendations CRUD', () => {
  let db: Driver;

  beforeEach(() => {
    db = createTestDb();
    insertScan(db, makeScan('scan-1'));
  });

  afterEach(() => { db.close(); });

  it('inserts, retrieves, orders, isolates per scan, and handles empty/unknown', () => {
    // basic insert + retrieve
    insertRecommendations(db, 'scan-1', [makeRec('rec-1')]);
    const recs = listRecommendations(db, 'scan-1');
    expect(recs).toHaveLength(1);
    expect(recs[0]!.id).toBe('rec-1');
    expect(recs[0]!.type).toBe('rightsizing');
    expect(recs[0]!.estimated_savings).toBeCloseTo(345.67, 2);

    // all fields populated
    const fullRec = makeRec('rec-full', {
      current_config: { instance_type: 'm5.xlarge', vcpu: 4 },
      suggested_config: { instance_type: 'm5.large', vcpu: 2 },
      implementation_steps: ['Stop instance', 'Change type', 'Start instance'],
      ai_model: 'claude-opus-4',
      patch_content: 'resource "aws_instance" "web" { instance_type = "m5.large" }',
      file_path: 'modules/compute/main.tf',
    });
    insertRecommendations(db, 'scan-1', [fullRec]);
    const full = listRecommendations(db, 'scan-1').find((r) => r.id === 'rec-full')!;
    expect(full.current_config).toEqual({ instance_type: 'm5.xlarge', vcpu: 4 });
    expect(full.suggested_config).toEqual({ instance_type: 'm5.large', vcpu: 2 });
    expect(full.implementation_steps).toHaveLength(3);
    expect(full.ai_model).toBe('claude-opus-4');
    expect(full.file_path).toBe('modules/compute/main.tf');

    // empty and unknown scan
    expect(listRecommendations(db, 'scan-unknown')).toHaveLength(0);

    // ordered by estimated_savings DESC
    insertRecommendations(db, 'scan-1', [
      makeRec('rec-low', { estimated_savings: 50 }),
      makeRec('rec-high', { estimated_savings: 1200 }),
      makeRec('rec-mid', { estimated_savings: 400 }),
    ]);
    const ordered = listRecommendations(db, 'scan-1').filter((r) => ['rec-low', 'rec-high', 'rec-mid'].includes(r.id));
    expect(ordered[0]!.id).toBe('rec-high');

    // per-scan isolation
    insertScan(db, makeScan('scan-2'));
    insertRecommendations(db, 'scan-2', [makeRec('rec-b'), makeRec('rec-c')]);
    expect(listRecommendations(db, 'scan-1').length).toBeGreaterThanOrEqual(1);
    expect(listRecommendations(db, 'scan-2')).toHaveLength(2);
  });
});

// ─── 2B: redaction in storage — current_config ───────────────────────────────
// insertRecommendations runs redactObject(r.current_config, 'moderate') before
// serialising to JSON. The key 'aws_access_key' matches the compound pattern
// ['access','key'] in isSensitiveKey, so its value is replaced with [REDACTED].
// Mutation check: comment out the redactObject call on the current_config line in
// src/storage/queries/recommendations.ts and this test will fail.

describe('storage — redaction of sensitive values in current_config (2B)', () => {
  let db: Driver;

  beforeEach(() => {
    db = createTestDb();
    insertScan(db, makeScan('scan-1'));
  });

  afterEach(() => { db.close(); });

  it('does not store raw AWS access key in current_config', () => {
    const rec = makeRec('rec-sensitive', {
      current_config: { aws_access_key: 'AKIAIOSFODNN7EXAMPLE', instance_type: 't3.large' },
    });
    insertRecommendations(db, 'scan-1', [rec]);

    const stored = listRecommendations(db, 'scan-1').find(r => r.id === 'rec-sensitive')!;
    expect(stored).toBeDefined();

    // The sensitive value must not appear in the stored config
    expect(JSON.stringify(stored.current_config)).not.toContain('AKIAIOSFODNN7EXAMPLE');

    // The key name is preserved; the value is replaced with [REDACTED]
    // (isSensitiveKey matches 'aws_access_key' via the ['access','key'] compound pattern)
    expect(stored.current_config?.['aws_access_key']).toBe('[REDACTED]');

    // Non-sensitive fields pass through unchanged
    expect(stored.current_config?.['instance_type']).toBe('t3.large');
  });
});

// ─── filters ─────────────────────────────────────────────────────────────────

describe('storage — listRecommendations filters', () => {
  let db: Driver;

  beforeEach(() => {
    db = createTestDb();
    insertScan(db, makeScan('scan-1'));
    insertRecommendations(db, 'scan-1', [
      makeRec('rec-right', { type: 'rightsizing', impact: 'high', status: 'draft' }),
      makeRec('rec-idle', { type: 'idle_resource', impact: 'medium', status: 'applied' }),
      makeRec('rec-storage', { type: 'storage_optimization', impact: 'low', status: 'draft' }),
    ]);
  });

  afterEach(() => { db.close(); });

  it('filters by type, impact, status, combined, and handles no-match', () => {
    expect(listRecommendations(db, 'scan-1', { type: 'rightsizing' })).toHaveLength(1);
    expect(listRecommendations(db, 'scan-1', { impact: 'high' })[0]!.id).toBe('rec-right');
    expect(listRecommendations(db, 'scan-1', { status: 'applied' })[0]!.id).toBe('rec-idle');
    expect(listRecommendations(db, 'scan-1', { type: 'rightsizing', impact: 'high' })).toHaveLength(1);
    expect(listRecommendations(db, 'scan-1', { type: 'nonexistent' })).toHaveLength(0);
  });
});

// ─── updateRecommendationStatus ───────────────────────────────────────────────

describe('storage — updateRecommendationStatus', () => {
  let db: Driver;

  beforeEach(() => {
    db = createTestDb();
    insertScan(db, makeScan('scan-1'));
    insertRecommendations(db, 'scan-1', [makeRec('rec-1')]);
  });

  afterEach(() => { db.close(); });

  it('marks as applied, dismissed with reason, and dismissed without reason', () => {
    updateRecommendationStatus(db, 'rec-1', 'applied');
    const applied = listRecommendations(db, 'scan-1', { status: 'applied' });
    expect(applied).toHaveLength(1);
    expect(applied[0]!.applied_at).not.toBeNull();

    // re-insert for dismiss test
    insertRecommendations(db, 'scan-1', [makeRec('rec-2')]);
    updateRecommendationStatus(db, 'rec-2', 'dismissed', 'Not applicable to workload');
    const dismissed = listRecommendations(db, 'scan-1', { status: 'dismissed' });
    expect(dismissed[0]!.dismiss_reason).toBe('Not applicable to workload');
    expect(dismissed[0]!.dismissed_at).not.toBeNull();

    insertRecommendations(db, 'scan-1', [makeRec('rec-3')]);
    updateRecommendationStatus(db, 'rec-3', 'dismissed');
    const dismissedNoReason = listRecommendations(db, 'scan-1').find((r) => r.id === 'rec-3');
    expect(dismissedNoReason?.dismiss_reason).toBeNull();
  });
});

// ─── upsertRecommendations contract tests ─────────────────────────────────────

describe('storage — upsertRecommendations contracts', () => {
  let db: Driver;

  beforeEach(() => {
    db = createTestDb();
    insertScan(db, makeScan('scan-1'));
    insertScan(db, makeScan('scan-2'));
  });

  afterEach(() => { db.close(); });

  it('contract 1: re-scan updates draft in-place, preserving original id and created_at', () => {
    // Insert initial draft recommendation via upsert (scan-1)
    const original = makeRec('orig-id', { resource_id: 'i-0a1b2c3d', type: 'rightsizing', estimated_savings: 100 });
    upsertRecommendations(db, 'scan-1', [original]);

    const before = listRecommendations(db, 'scan-1').find((r) => r.id === 'orig-id')!;
    expect(before).toBeDefined();
    const originalCreatedAt = before.created_at;

    // Re-scan (scan-2) with same resource_id + type — should UPDATE in place
    const updated = makeRec('new-id', {
      resource_id: 'i-0a1b2c3d',
      type: 'rightsizing',
      estimated_savings: 150,
      title: 'Updated recommendation title',
    });
    upsertRecommendations(db, 'scan-2', [updated]);

    // After update, scan_id is changed to scan-2 but original row id is preserved
    // Query scan-2 to find the updated row
    const after = listRecommendations(db, 'scan-2').find((r) => r.id === 'orig-id')!;
    expect(after).toBeDefined();
    expect(after.id).toBe('orig-id');
    expect(after.created_at).toBe(originalCreatedAt);
    expect(after.estimated_savings).toBe(150);
    expect(after.title).toBe('Updated recommendation title');

    // The new-id row must NOT exist (upsert reused the original slot)
    const newRow = listRecommendations(db, 'scan-2').find((r) => r.id === 'new-id');
    expect(newRow).toBeUndefined();
  });

  it('contract 2: rec with no resource_id always inserts a new row', () => {
    // Two upsert calls with resource_id=null should produce two separate rows
    const rec1 = makeRec('general-rec-1', { resource_id: null, type: 'general', title: 'General rec 1' });
    const rec2 = makeRec('general-rec-2', { resource_id: null, type: 'general', title: 'General rec 2' });

    upsertRecommendations(db, 'scan-1', [rec1]);
    upsertRecommendations(db, 'scan-1', [rec2]);

    const all = listRecommendations(db, 'scan-1');
    const generalRecs = all.filter((r) => r.type === 'general');
    // Both rows must exist independently
    expect(generalRecs).toHaveLength(2);
    expect(generalRecs.map((r) => r.id)).toContain('general-rec-1');
    expect(generalRecs.map((r) => r.id)).toContain('general-rec-2');
  });

  it('contract 3: applied/dismissed rec is not overwritten on re-scan', () => {
    // Insert and immediately mark as applied
    const appliedRec = makeRec('applied-rec', { resource_id: 'i-applied01', type: 'rightsizing' });
    upsertRecommendations(db, 'scan-1', [appliedRec]);
    updateRecommendationStatus(db, 'applied-rec', 'applied');

    const before = listRecommendations(db, 'scan-1').find((r) => r.id === 'applied-rec')!;
    expect(before.status).toBe('applied');
    expect(before.applied_at).not.toBeNull();

    // Re-scan with same resource_id+type but a different id
    // findExisting only matches status='draft', so applied rec is invisible → INSERT new row
    const rescan = makeRec('rescan-rec', {
      resource_id: 'i-applied01',
      type: 'rightsizing',
      estimated_savings: 999,
    });
    upsertRecommendations(db, 'scan-2', [rescan]);

    // Applied row must be untouched
    const appliedAfter = listRecommendations(db, 'scan-1').find((r) => r.id === 'applied-rec')!;
    expect(appliedAfter.status).toBe('applied');
    expect(appliedAfter.applied_at).not.toBeNull();
    // The applied rec's savings must NOT have been updated to 999
    expect(appliedAfter.estimated_savings).toBe(345.67);
  });
});
