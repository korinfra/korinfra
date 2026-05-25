/**
 * Tests for EBS-006 — io1/io2 over-provisioned IOPS.
 *
 * EBS-006 has two branches that both emit ruleId 'EBS-006':
 *   A) High-confidence: CloudWatch data available AND actual IOPS < 50% provisioned
 *      → specific IOPS reduction recommendation with real savings
 *   B) Low-confidence: no CloudWatch data
 *      → review hint with estimatedSavings = 0
 *
 * Both branches are tested via the evaluateRules public API (checkEBS006 is
 * not exported; it's an internal function in the ebsRules array).
 */

import { describe, it, expect } from 'vitest';
import { evaluateRules } from '../../../../src/rules/index.js';
import { THRESHOLDS } from '../../../../src/rules/config.js';
import type { Resource } from '../../../../src/aws/types.js';

const cfg = THRESHOLDS;

function makeIO1Volume(overrides: Partial<Resource> = {}): Resource {
  return {
    id: 'vol-io1-test',
    arn: 'arn:aws:ec2:us-east-1:123456789012:volume/vol-io1-test',
    type: 'ebs_volume',
    name: 'prod-db-vol',
    region: 'us-east-1',
    state: 'in-use',
    instanceType: '',
    tags: {},
    launchTime: new Date(Date.now() - 60 * 86_400_000).toISOString(),
    collectedAt: new Date().toISOString(),
    // io1 with 10 000 provisioned IOPS — well above the 3000 gp3 baseline
    configuration: { volume_type: 'io1', size_gb: 500, iops: 10_000, monthlyCost: 700 },
    ...overrides,
  };
}

function withCloudWatch(r: Resource, diskReadIOPS: number, diskWriteIOPS: number): Resource {
  return {
    ...r,
    utilization: {
      period: '30d',
      cpuAverage: 0, cpuMax: 0, cpuP95: 0, cpuP99: 0,
      memoryAverage: 0, memoryMax: 0, memoryP95: 0,
      networkInMB: 0, networkOutMB: 0,
      diskReadIOPS,
      diskWriteIOPS,
      connectionCount: 0, connectionCountMax: 0,
      dataPoints: 720, dataGaps: 0, freshnessHrs: 1,
    },
  };
}

function getEBS006(r: Resource) {
  const { recommendations } = evaluateRules([r], cfg, ['EBS-006']);
  return recommendations[0] ?? null;
}

// ─── EBS-006 Branch A: CloudWatch data available, actual IOPS < threshold ────

describe('checkEBS006 — Branch A (CloudWatch available, under-utilized)', () => {
  it('fires with strong signal when actual IOPS < 50% of provisioned', () => {
    // 10 000 provisioned, 2000 actual P95 → well under 50%
    const r = withCloudWatch(makeIO1Volume(), 1200, 800); // 2000 total actual
    const rec = getEBS006(r);

    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('EBS-006');
    expect(rec!.suggestedAction).toBe('reduce_provisioned_iops');
    // recommendedIops = max(3000, ceil(2000 * 1.2)) = max(3000, 2400) = 3000
    expect(rec!.suggestedConfig!['iops']).toBe(3000);
    // Savings = (10000 - 3000) * $0.065 = $455
    expect(rec!.estimatedSavings).toBeCloseTo(455, 0);
    expect(rec!.impact).toBe('medium');
    expect(rec!.risk).toBe('low');
    expect(rec!.confidence).toBe(0.80); // CONF_COST_OPT (CW data available)
  });

  it('falls through to review hint when actual IOPS >= 50% of provisioned', () => {
    // 10 000 provisioned, 6000 actual P95 → 60% utilization — over the 50% threshold
    const r = withCloudWatch(makeIO1Volume(), 3000, 3000); // 6000 total
    const rec = getEBS006(r);
    expect(rec).not.toBeNull();
    // 6000 >= 10000 * 0.5 = 5000 → above threshold → falls through to low-confidence branch
    expect(rec!.suggestedAction).toBe('review_provisioned_iops');
    expect(rec!.estimatedSavings).toBe(0);
  });

  it('fires for io2 as well as io1', () => {
    const r = withCloudWatch(
      makeIO1Volume({ configuration: { volume_type: 'io2', size_gb: 200, iops: 8000, monthlyCost: 500 } }),
      500, 500, // 1000 actual — well under 50% of 8000
    );
    const rec = getEBS006(r);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('EBS-006');
    expect(rec!.currentConfig!['volume_type']).toBe('io2');
    // io2 first-tier: (8000 - 3000) * $0.065 = $325
    expect(rec!.estimatedSavings).toBeCloseTo(325, 0);
  });
});

// ─── EBS-006 Branch B: No CloudWatch data ────────────────────────────────────

describe('checkEBS006 — Branch B (no CloudWatch data)', () => {
  it('emits a low-confidence review hint with zero savings when no CW data', () => {
    const r = makeIO1Volume(); // no utilization property
    const rec = getEBS006(r);

    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('EBS-006');
    expect(rec!.suggestedAction).toBe('review_provisioned_iops');
    expect(rec!.estimatedSavings).toBe(0);
    expect(rec!.confidence).toBeLessThan(0.7); // low-to-medium confidence
    expect(rec!.suggestedConfig!['action']).toBe('review_in_cloudwatch');
  });

  it('branch B suggestion differs from branch A — same (ruleId, resourceId) key', () => {
    const withData = withCloudWatch(makeIO1Volume(), 500, 500); // Branch A
    const withoutData = makeIO1Volume(); // Branch B

    const recA = getEBS006(withData);
    const recB = getEBS006(withoutData);

    expect(recA).not.toBeNull();
    expect(recB).not.toBeNull();
    // Both share the same ruleId and resourceId — deduplicators must be aware
    expect(recA!.ruleId).toBe(recB!.ruleId);
    expect(recA!.resourceId).toBe(recB!.resourceId);
    // But they differ in action and savings
    expect(recA!.suggestedAction).toBe('reduce_provisioned_iops');
    expect(recB!.suggestedAction).toBe('review_provisioned_iops');
    expect(recA!.estimatedSavings).toBeGreaterThan(recB!.estimatedSavings);
  });
});

// ─── Guard conditions ─────────────────────────────────────────────────────────

describe('checkEBS006 — guard conditions', () => {
  it('does not fire for gp2/gp3 volumes', () => {
    expect(getEBS006(makeIO1Volume({ configuration: { volume_type: 'gp3', size_gb: 500, iops: 10_000 } }))).toBeNull();
    expect(getEBS006(makeIO1Volume({ configuration: { volume_type: 'gp2', size_gb: 500, iops: 3000 } }))).toBeNull();
  });

  it('does not fire when IOPS <= gp3 baseline (EBS-005 handles those)', () => {
    const r = makeIO1Volume({ configuration: { volume_type: 'io1', size_gb: 100, iops: 3000 } });
    expect(getEBS006(r)).toBeNull();
  });

  it('does not fire for non-EBS resource types', () => {
    const r = makeIO1Volume({ type: 'ec2_instance', configuration: { volume_type: 'io1', size_gb: 100, iops: 5000 } });
    expect(getEBS006(r)).toBeNull();
  });
});
