/**
 * Additional EBS rule coverage — EBS-005, EBS-007, SNAP-001, SNAP-002.
 */

import { describe, it, expect } from 'vitest';
import {
  checkEBS005,
  checkEBS007,
  checkSNAP001,
  checkSNAP002,
} from '../../../../src/rules/cost/ebs.js';
import { THRESHOLDS } from '../../../../src/rules/config.js';
import type { Resource } from '../../../../src/aws/types.js';

const cfg = THRESHOLDS;

function makeVolume(overrides: Partial<Resource> = {}): Resource {
  return {
    id: 'vol-0a1b2c3d4e5f67890',
    arn: 'arn:aws:ec2:us-east-1:123456789012:volume/vol-0a1b2c3d4e5f67890',
    type: 'ebs_volume',
    name: 'prod-data',
    region: 'us-east-1',
    state: 'in-use',
    instanceType: '',
    tags: {},
    launchTime: new Date(Date.now() - 60 * 86_400_000).toISOString(),
    collectedAt: new Date().toISOString(),
    configuration: { volume_type: 'gp3', size_gb: 500, iops: 3000, throughput_mbps: 128, monthlyCost: 40 },
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<Resource> = {}): Resource {
  return {
    id: 'snap-0a1b2c3d4e5f67890',
    arn: 'arn:aws:ec2:us-east-1:123456789012:snapshot/snap-0a1b2c3d4e5f67890',
    type: 'ebs_snapshot',
    name: 'snap-prod-data',
    region: 'us-east-1',
    state: 'available',
    instanceType: '',
    tags: {},
    launchTime: new Date(Date.now() - 100 * 86_400_000).toISOString(),
    collectedAt: new Date().toISOString(),
    configuration: { size_gb: 500, volume_id: 'vol-0a1b2c3d4e5f67890', monthlyCost: 25 },
    ...overrides,
  };
}

// ─── EBS-005: io1/io2 → gp3 when IOPS <= 3000 baseline ──────────────────────

describe('checkEBS005 — io1/io2 → gp3 downgrade', () => {
  it('fires for io1/io2 with IOPS <= 3000 with 70% savings and correct config/fields', () => {
    const io1 = makeVolume({ configuration: { volume_type: 'io1', size_gb: 500, iops: 2000, monthlyCost: 100 } });
    const rec = checkEBS005(io1, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('EBS-005');
    expect(rec!.impact).toBe('high');
    expect(rec!.risk).toBe('medium');
    // Savings = monthlyCost * 0.80 (io1/io2→gp3 precise savings are 80-90%): 100 * 0.80 = 80
    expect(rec!.estimatedSavings).toBeCloseTo(80, 2);
    expect(rec!.suggestedConfig!.volume_type).toBe('gp3');
    expect(rec!.suggestedConfig!.iops).toBe(cfg.gp3IOPSBaseline);
    expect(rec!.currentConfig!.volume_type).toBe('io1');
    expect(rec!.currentConfig!.iops).toBe(2000);
    expect(rec!.title).toContain('io1');
    expect(rec!.title).toContain('gp3');

    const io2 = makeVolume({ configuration: { volume_type: 'io2', size_gb: 200, iops: 1000, monthlyCost: 80 } });
    const rec2 = checkEBS005(io2, cfg);
    expect(rec2).not.toBeNull();
    expect(rec2!.currentConfig!.volume_type).toBe('io2');
  });

  it('does not fire when IOPS > 3000, wrong volume type, or wrong resource type', () => {
    expect(checkEBS005(makeVolume({ configuration: { volume_type: 'io1', size_gb: 500, iops: 8000, monthlyCost: 200 } }), cfg)).toBeNull();
    expect(checkEBS005(makeVolume({ configuration: { volume_type: 'gp3', size_gb: 500, iops: 3000, monthlyCost: 40 } }), cfg)).toBeNull();
    expect(checkEBS005(makeVolume({ configuration: { volume_type: 'gp2', size_gb: 500, iops: 1500, monthlyCost: 50 } }), cfg)).toBeNull();
    expect(checkEBS005(makeVolume({ type: 'ec2_instance', configuration: { volume_type: 'io1', iops: 1000 } }), cfg)).toBeNull();
  });
});

// ─── EBS-007: gp3 over-provisioned IOPS ──────────────────────────────────────

describe('checkEBS007 — gp3 over-provisioned IOPS', () => {
  function makeGP3WithUtil(provisionedIops: number, readIops: number, writeIops: number): Resource {
    return makeVolume({
      configuration: { volume_type: 'gp3', size_gb: 500, iops: provisionedIops, monthlyCost: 50 },
      utilization: {
        period: '14d',
        cpuAverage: 0, cpuMax: 0, cpuP95: 0, cpuP99: 0,
        memoryAverage: 0, memoryMax: 0, memoryP95: 0,
        networkInMB: 0, networkOutMB: 0,
        diskReadIOPS: readIops, diskWriteIOPS: writeIops,
        connectionCount: 0, connectionCountMax: 0,
        dataPoints: 100, dataGaps: 0, freshnessHrs: 1,
      },
    });
  }

  it('fires for 6000 provisioned IOPS with <100 actual IOPS, calculates savings and config correctly', () => {
    const r = makeGP3WithUtil(6000, 10, 5);
    const rec = checkEBS007(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('EBS-007');
    // excess = 3000, savings = 3000 * 0.005 = 15
    expect(rec!.estimatedSavings).toBeCloseTo(15, 2);
    expect(rec!.suggestedConfig!.iops).toBe(3000);

    const r2 = makeGP3WithUtil(5000, 30, 40);
    expect(checkEBS007(r2, cfg)!.currentConfig!.iops).toBe(5000);
    expect(checkEBS007(r2, cfg)!.currentConfig!.actual_iops_avg).toBeCloseTo(70, 0);
  });

  it('does not fire when actual IOPS >= 100, provisioned <= 3000, wrong type, or no utilization', () => {
    expect(checkEBS007(makeGP3WithUtil(6000, 60, 50), cfg)).toBeNull(); // 110 total
    expect(checkEBS007(makeGP3WithUtil(3000, 10, 5), cfg)).toBeNull();
    expect(checkEBS007(makeGP3WithUtil(8000, 20, 10), cfg)).not.toBeNull(); // sanity
    expect(checkEBS007(makeVolume({ type: 'ec2_instance' }), cfg)).toBeNull();
    expect(checkEBS007(makeVolume({ configuration: { volume_type: 'gp3', size_gb: 500, iops: 6000, monthlyCost: 50 } }), cfg)).toBeNull();
  });
});

// ─── SNAP-001: Orphaned snapshot ──────────────────────────────────────────────

describe('checkSNAP001 — orphaned snapshot', () => {
  it('fires for available snapshot with correct fields and savings logic', () => {
    const rec = checkSNAP001(makeSnapshot(), cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('SNAP-001');
    expect(rec!.confidence).toBeCloseTo(0.4);
    expect(rec!.estimatedSavings).toBeCloseTo(25, 2);
    expect(rec!.currentConfig!.volume_id).toBe('vol-0a1b2c3d4e5f67890');
    expect(rec!.currentConfig!.size_gb).toBe(500);

    // uses monthlyCost when provided
    expect(checkSNAP001(makeSnapshot({ configuration: { size_gb: 500, volume_id: 'vol-abc', monthlyCost: 30 } }), cfg)!.estimatedSavings).toBeCloseTo(30, 2);
    // falls back to size_gb * 0.05
    expect(checkSNAP001(makeSnapshot({ configuration: { size_gb: 200, volume_id: 'vol-abc', monthlyCost: 0 } }), cfg)!.estimatedSavings).toBeCloseTo(10, 2);
    // post-#44: skips with null when BOTH monthly_cost and size_gb are missing (no savings signal)
    expect(checkSNAP001(makeSnapshot({ configuration: { size_gb: 0, volume_id: 'vol-abc', monthlyCost: 0 } }), cfg)).toBeNull();
  });

  it('does not fire for wrong type, non-available state, or empty volume_id', () => {
    expect(checkSNAP001(makeSnapshot({ type: 'ebs_volume' }), cfg)).toBeNull();
    expect(checkSNAP001(makeSnapshot({ state: 'pending' }), cfg)).toBeNull();
    expect(checkSNAP001(makeSnapshot({ configuration: { size_gb: 500, volume_id: '', monthlyCost: 25 } }), cfg)).toBeNull();
  });

  it('skips and warns when both monthly_cost and size_gb are missing (#44 Item 2)', () => {
    const warnings: Array<{ ruleId: string; resourceId: string; resourceType: string; reason: string }> = [];
    const ctx = {
      warn(ruleId: string, resourceId: string, resourceType: string, reason: string) {
        warnings.push({ ruleId, resourceId, resourceType, reason });
      },
    };
    const r = makeSnapshot({ configuration: { size_gb: 0, volume_id: 'vol-abc', monthlyCost: 0 } });
    expect(checkSNAP001(r, cfg, ctx)).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      ruleId: 'SNAP-001',
      resourceId: r.id,
      reason: 'monthly_cost missing and size_gb unavailable',
    });
  });
});

// ─── SNAP-002: Snapshot older than 1 year ────────────────────────────────────

describe('checkSNAP002 — very old snapshot', () => {
  function makeOldSnapshot(ageDays: number): Resource {
    return makeSnapshot({ launchTime: new Date(Date.now() - ageDays * 86_400_000).toISOString() });
  }

  it('fires for old snapshots with correct fields, savings logic, and age in title', () => {
    const rec = checkSNAP002(makeOldSnapshot(400), cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('SNAP-002');
    expect(rec!.impact).toBe('medium');
    expect(rec!.risk).toBe('low');
    expect(rec!.confidence).toBeCloseTo(0.8);
    expect(rec!.estimatedSavings).toBeCloseTo(25, 2);
    expect(rec!.title).toMatch(/\d+ days/);

    // falls back to size_gb * 0.05
    const r2 = makeOldSnapshot(400);
    r2.configuration = { size_gb: 300, volume_id: 'vol-abc', monthlyCost: 0 };
    expect(checkSNAP002(r2, cfg)!.estimatedSavings).toBeCloseTo(15, 2);
  });

  it('does not fire within age threshold, missing launchTime, or wrong type', () => {
    expect(checkSNAP002(makeOldSnapshot(300), cfg)).toBeNull();
    expect(checkSNAP002(makeSnapshot({ launchTime: '' }), cfg)).toBeNull();
    const old = makeOldSnapshot(400);
    old.type = 'ebs_volume';
    expect(checkSNAP002(old, cfg)).toBeNull();
  });

  it('skips and warns when both monthly_cost and size_gb are missing (#44 Item 2)', () => {
    const warnings: Array<{ ruleId: string; resourceId: string; resourceType: string; reason: string }> = [];
    const ctx = {
      warn(ruleId: string, resourceId: string, resourceType: string, reason: string) {
        warnings.push({ ruleId, resourceId, resourceType, reason });
      },
    };
    const r = makeOldSnapshot(400);
    r.configuration = { size_gb: 0, volume_id: 'vol-abc', monthlyCost: 0 };
    expect(checkSNAP002(r, cfg, ctx)).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      ruleId: 'SNAP-002',
      resourceId: r.id,
      reason: 'monthly_cost missing and size_gb unavailable',
    });
  });
});
