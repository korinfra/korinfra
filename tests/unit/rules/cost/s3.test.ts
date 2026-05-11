import { describe, it, expect } from 'vitest';
import { checkS3001, checkS3002, checkS3003, checkS3004 } from '../../../../src/rules/cost/s3.js';
import { THRESHOLDS } from '../../../../src/rules/config.js';
import type { Resource } from '../../../../src/aws/types.js';

const cfg = THRESHOLDS;

function makeS3Bucket(overrides: Partial<Resource> = {}): Resource {
  return {
    id: 'my-app-data-bucket',
    arn: 'arn:aws:s3:::my-app-data-bucket',
    type: 's3_bucket',
    name: 'my-app-data-bucket',
    region: 'us-east-1',
    state: 'active',
    instanceType: '',
    tags: { Environment: 'production', Team: 'data', Project: 'analytics' },
    launchTime: new Date(Date.now() - 365 * 86_400_000).toISOString(),
    collectedAt: new Date().toISOString(),
    configuration: {
      monthlyCost: 50,
      lifecycle_rules_count: 0,
      has_lifecycle: false,
      has_intelligent_tiering: false,
      versioning_enabled: true,
      encryption_enabled: true,
    },
    ...overrides,
  };
}

// ─── S3-001: No lifecycle policy ──────────────────────────────────────────────

describe('checkS3001 — no lifecycle policy', () => {
  it('fires with correct fields, 15% savings, implementation steps, and handles $0 cost', () => {
    const r = makeS3Bucket({ configuration: { monthlyCost: 200, lifecycle_rules_count: 0, has_lifecycle: false } });
    const rec = checkS3001(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('S3-001');
    expect(rec!.suggestedAction).toBe('add_lifecycle_policy');
    expect(rec!.confidence).toBe(0.7);
    expect(rec!.impact).toBe('medium');
    expect(rec!.risk).toBe('low');
    expect(rec!.estimatedSavings).toBeCloseTo(30);
    const steps = rec!.implementationSteps.join(' ');
    expect(steps).toContain('STANDARD_IA');
    expect(steps).toContain('GLACIER');

    // $0 cost
    const rec0 = checkS3001(makeS3Bucket({ configuration: { monthlyCost: 0, lifecycle_rules_count: 0, has_lifecycle: false } }), cfg);
    expect(rec0).not.toBeNull();
    expect(rec0!.estimatedSavings).toBe(0);
  });

  it('does not fire when lifecycle is configured or wrong resource type', () => {
    expect(checkS3001(makeS3Bucket({ configuration: { monthlyCost: 100, lifecycle_rules_count: 2, has_lifecycle: false } }), cfg)).toBeNull();
    expect(checkS3001(makeS3Bucket({ configuration: { monthlyCost: 100, lifecycle_rules_count: 0, has_lifecycle: true } }), cfg)).toBeNull();
    expect(checkS3001(makeS3Bucket({ type: 'ebs_volume', configuration: { monthlyCost: 100, lifecycle_rules_count: 0, has_lifecycle: false } }), cfg)).toBeNull();
  });
});

// ─── S3-002: Missing Intelligent-Tiering ──────────────────────────────────────

describe('checkS3002 — missing Intelligent-Tiering', () => {
  it('fires when lifecycle present but no Intelligent-Tiering, with 10% savings and correct fields', () => {
    const r = makeS3Bucket({ configuration: { monthlyCost: 300, lifecycle_rules_count: 2, has_lifecycle: true, has_intelligent_tiering: false } });
    const rec = checkS3002(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('S3-002');
    expect(rec!.suggestedAction).toBe('add_intelligent_tiering');
    expect(rec!.suggestedConfig).toMatchObject({ storage_class: 'INTELLIGENT_TIERING' });
    expect(rec!.confidence).toBe(0.6);
    expect(rec!.estimatedSavings).toBeCloseTo(30);
    expect(rec!.currentConfig).toMatchObject({ lifecycle_rules_count: 2, has_intelligent_tiering: false });

    // has_lifecycle=true with 0 count also fires
    expect(checkS3002(makeS3Bucket({ configuration: { monthlyCost: 100, lifecycle_rules_count: 0, has_lifecycle: true, has_intelligent_tiering: false } }), cfg)).not.toBeNull();
  });

  it('does not fire when Intelligent-Tiering present, no lifecycle, or wrong type', () => {
    expect(checkS3002(makeS3Bucket({ configuration: { monthlyCost: 150, lifecycle_rules_count: 2, has_lifecycle: true, has_intelligent_tiering: true } }), cfg)).toBeNull();
    expect(checkS3002(makeS3Bucket({ configuration: { monthlyCost: 100, lifecycle_rules_count: 0, has_lifecycle: false, has_intelligent_tiering: false } }), cfg)).toBeNull();
    expect(checkS3002(makeS3Bucket({ type: 'ebs_volume', configuration: { monthlyCost: 100, lifecycle_rules_count: 1, has_intelligent_tiering: false } }), cfg)).toBeNull();
  });
});

// ─── S3-003: No versioning ────────────────────────────────────────────────────

describe('checkS3003 — versioning not enabled', () => {
  it('fires with correct fields (0 savings, medium impact) and current/suggested config', () => {
    const r = makeS3Bucket({ configuration: { monthlyCost: 100, versioning_enabled: false, lifecycle_rules_count: 1, has_lifecycle: true } });
    const rec = checkS3003(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('S3-003');
    expect(rec!.suggestedAction).toBe('enable_versioning');
    expect(rec!.confidence).toBe(0.8);
    expect(rec!.estimatedSavings).toBe(0);
    expect(rec!.impact).toBe('medium');
    expect(rec!.risk).toBe('low');
    expect(rec!.currentConfig).toMatchObject({ versioning_enabled: false });
    expect(rec!.suggestedConfig).toMatchObject({ versioning_enabled: true });

    // fires when key absent (defaults false)
    expect(checkS3003(makeS3Bucket({ configuration: { monthlyCost: 80, lifecycle_rules_count: 1 } }), cfg)).not.toBeNull();
  });

  it('does not fire when versioning enabled or wrong type', () => {
    expect(checkS3003(makeS3Bucket({ configuration: { monthlyCost: 100, versioning_enabled: true } }), cfg)).toBeNull();
    expect(checkS3003(makeS3Bucket({ type: 'rds_instance', configuration: { monthlyCost: 100, versioning_enabled: false } }), cfg)).toBeNull();
  });
});

// ─── S3-004: No encryption ───────────────────────────────────────────────────

describe('checkS3004 — encryption not enabled', () => {
  it('fires with correct fields, 0 savings, AES256 suggestion, and name in title', () => {
    const r = makeS3Bucket({ name: 'prod-financial-data', configuration: { monthlyCost: 500, encryption_enabled: false } });
    const rec = checkS3004(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('S3-004');
    expect(rec!.suggestedAction).toBe('enable_default_encryption');
    expect(rec!.confidence).toBe(0.95);
    expect(rec!.impact).toBe('high');
    expect(rec!.estimatedSavings).toBe(0);
    expect(rec!.currentConfig).toMatchObject({ encryption_enabled: false });
    expect(rec!.suggestedConfig).toMatchObject({ encryption_enabled: true, encryption_algorithm: 'AES256' });
    expect(rec!.title).toContain('prod-financial-data');
  });

  it('does not fire when encryption enabled, key absent, or wrong type', () => {
    expect(checkS3004(makeS3Bucket({ configuration: { monthlyCost: 100, encryption_enabled: true } }), cfg)).toBeNull();
    expect(checkS3004(makeS3Bucket({ configuration: { monthlyCost: 100, versioning_enabled: true } }), cfg)).toBeNull();
    expect(checkS3004(makeS3Bucket({ type: 'ec2_instance', configuration: { monthlyCost: 100, encryption_enabled: false } }), cfg)).toBeNull();
  });
});
