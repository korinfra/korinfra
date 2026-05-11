import { describe, it, expect } from 'vitest';
import { checkEBS001, checkEBS002, checkEBS003, checkEBS004 } from '../../../../src/rules/cost/ebs.js';
import { THRESHOLDS } from '../../../../src/rules/config.js';
import { EBS_SNAPSHOT_PER_GB } from '../../../../src/pricing/resources.js';
import type { Resource } from '../../../../src/aws/types.js';

const cfg = THRESHOLDS;

function makeEBSVolume(overrides: Partial<Resource> = {}): Resource {
  return {
    id: 'vol-abc123',
    arn: 'arn:aws:ec2:us-east-1:123456789012:volume/vol-abc123',
    type: 'ebs_volume',
    name: 'my-volume',
    region: 'us-east-1',
    state: 'in-use',
    instanceType: '',
    tags: {},
    launchTime: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    collectedAt: new Date().toISOString(),
    configuration: { volume_type: 'gp3', size_gb: 100, monthlyCost: 8 },
    ...overrides,
  };
}

// ─── EBS-001: Unattached volume ───────────────────────────────────────────────

describe('checkEBS001 — unattached volume', () => {
  it('fires when state=available with correct fields and full savings', () => {
    const r = makeEBSVolume({ state: 'available', configuration: { monthlyCost: 25, volume_type: 'gp2' } });
    const rec = checkEBS001(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('EBS-001');
    expect(rec!.impact).toBe('high');
    expect(rec!.confidence).toBeCloseTo(0.98);
    expect(rec!.estimatedSavings).toBeCloseTo(25, 2);
    expect(rec!.currentConfig!.volume_type).toBe('gp2');
    expect(rec!.suggestedConfig!.action).toBe('delete');
  });

  it('does not fire when in-use or wrong resource type', () => {
    expect(checkEBS001(makeEBSVolume({ state: 'in-use' }), cfg)).toBeNull();
    expect(checkEBS001(makeEBSVolume({ type: 'ec2_instance', state: 'available' }), cfg)).toBeNull();
  });
});

// ─── EBS-003: gp2 → gp3 migration ────────────────────────────────────────────

describe('checkEBS003 — gp2 to gp3 migration', () => {
  it('fires for gp2 with 20% savings, low risk, and correct config', () => {
    const r = makeEBSVolume({ configuration: { volume_type: 'gp2', monthlyCost: 100 } });
    const rec = checkEBS003(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('EBS-003');
    expect(rec!.estimatedSavings).toBeCloseTo(20, 2);
    expect(rec!.confidence).toBeCloseTo(0.95);
    expect(rec!.risk).toBe('low');
    expect(rec!.suggestedConfig!.volume_type).toBe('gp3');
    expect(rec!.currentConfig!.volume_type).toBe('gp2');
  });

  it('does not fire for non-gp2 volume types or wrong resource type', () => {
    expect(checkEBS003(makeEBSVolume({ configuration: { volume_type: 'gp3', monthlyCost: 8 } }), cfg)).toBeNull();
    expect(checkEBS003(makeEBSVolume({ configuration: { volume_type: 'io1', monthlyCost: 50 } }), cfg)).toBeNull();
    expect(checkEBS003(makeEBSVolume({ configuration: { volume_type: 'sc1', monthlyCost: 2 } }), cfg)).toBeNull();
    expect(checkEBS003(makeEBSVolume({ type: 'ec2_instance', configuration: { volume_type: 'gp2' } }), cfg)).toBeNull();
  });
});

// ─── EBS-002: Old snapshot > 90 days ─────────────────────────────────────────

function makeSnapshot(overrides: Partial<Resource> = {}): Resource {
  return {
    id: 'snap-abc123',
    arn: 'arn:aws:ec2:us-east-1:123456789012:snapshot/snap-abc123',
    type: 'ebs_snapshot',
    name: 'snap-prod',
    region: 'us-east-1',
    state: 'available',
    instanceType: '',
    tags: {},
    launchTime: new Date(Date.now() - 100 * 86_400_000).toISOString(),
    collectedAt: new Date().toISOString(),
    configuration: { size_gb: 200, monthlyCost: 10 },
    ...overrides,
  };
}

describe('checkEBS002 — old snapshot (>90 days)', () => {
  it('fires for snapshot older than snapshotRetentionDays with correct fields', () => {
    const rec = checkEBS002(makeSnapshot(), cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('EBS-002');
    expect(rec!.impact).toBe('low');
    expect(rec!.risk).toBe('low');
    expect(rec!.confidence).toBeCloseTo(0.6);
    expect(rec!.estimatedSavings).toBeCloseTo(10, 2);
    expect(rec!.currentConfig!.age_days).toBeGreaterThan(90);
    expect(rec!.title).toMatch(/snap-prod/);
    expect(rec!.description).toContain(String(EBS_SNAPSHOT_PER_GB));
  });

  it('fires and includes age_days matching actual age', () => {
    const ageDays = 120;
    const r = makeSnapshot({
      launchTime: new Date(Date.now() - ageDays * 86_400_000).toISOString(),
      configuration: { size_gb: 100, monthlyCost: 5 },
    });
    const rec = checkEBS002(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.currentConfig!.age_days).toBeGreaterThanOrEqual(ageDays - 1);
  });

  it('does not fire for recent snapshot (<= 90 days), wrong type, or null launchTime', () => {
    // 30 days old — within retention threshold
    expect(checkEBS002(makeSnapshot({
      launchTime: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    }), cfg)).toBeNull();
    // wrong resource type
    expect(checkEBS002(makeSnapshot({ type: 'ebs_volume' }), cfg)).toBeNull();
    // null launchTime
    expect(checkEBS002(makeSnapshot({ launchTime: '' }), cfg)).toBeNull();
  });
});

// ─── EBS-004: Unencrypted EBS volume ─────────────────────────────────────────

describe('checkEBS004 — unencrypted EBS volume', () => {
  it('fires when encrypted=false with correct fields and zero savings', () => {
    const r = makeEBSVolume({ configuration: { volume_type: 'gp3', size_gb: 100, encrypted: false, monthlyCost: 8 } });
    const rec = checkEBS004(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('EBS-004');
    expect(rec!.impact).toBe('high');
    expect(rec!.risk).toBe('medium');
    expect(rec!.confidence).toBeCloseTo(0.99);
    expect(rec!.estimatedSavings).toBe(0);
    expect(rec!.currentConfig!.encrypted).toBe(false);
    expect(rec!.suggestedConfig!.encrypted).toBe(true);
  });

  it('fires when encrypted key is absent (falsy = unencrypted)', () => {
    const r = makeEBSVolume({ configuration: { volume_type: 'gp3', size_gb: 100, monthlyCost: 8 } });
    expect(checkEBS004(r, cfg)).not.toBeNull();
  });

  it('does not fire when encrypted=true or wrong resource type', () => {
    expect(checkEBS004(makeEBSVolume({ configuration: { volume_type: 'gp3', size_gb: 100, encrypted: true, monthlyCost: 8 } }), cfg)).toBeNull();
    expect(checkEBS004(makeEBSVolume({ type: 'ebs_snapshot', configuration: { encrypted: false } }), cfg)).toBeNull();
    expect(checkEBS004(makeEBSVolume({ type: 'ec2_instance', configuration: { encrypted: false } }), cfg)).toBeNull();
  });
});
