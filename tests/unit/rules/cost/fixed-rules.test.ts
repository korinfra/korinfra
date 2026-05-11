/**
 * Tests for rules that were previously broken because their required
 * configuration fields were not populated by collectors.
 * Fixed in the 2026-04-07 review.
 */

import { describe, it, expect } from 'vitest';
import { checkEC2012 } from '../../../../src/rules/cost/ec2.js';
import { checkRDS009, checkRDS013 } from '../../../../src/rules/cost/rds.js';
import { checkS3002, checkS3004 } from '../../../../src/rules/cost/s3.js';
import { THRESHOLDS } from '../../../../src/rules/config.js';
import {
  ec2Production,
  rdsProduction,
  rdsIdle,
  s3DataLake,
  s3Unencrypted,
  makeUtil,
} from '../../../fixtures/realistic-data.js';
import type { Resource } from '../../../../src/aws/types.js';

const cfg = THRESHOLDS;

// ─── EC2-012: IMDSv2 enforcement ─────────────────────────────────────────────

describe('checkEC2012 — IMDSv2 enforcement', () => {
  it('fires when metadata_options_http_tokens is "optional"', () => {
    const rec = checkEC2012(ec2Production, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('EC2-012');
    expect(rec!.impact).toBe('high');
  });

  it('does NOT fire when metadata_options_http_tokens is "required"', () => {
    const r: Resource = {
      ...ec2Production,
      configuration: {
        ...ec2Production.configuration,
        metadata_options_http_tokens: 'required',
      },
    };
    expect(checkEC2012(r, cfg)).toBeNull();
  });

  it('does NOT fire when metadata_options_http_tokens is missing', () => {
    const r: Resource = {
      ...ec2Production,
      configuration: { platform: 'Linux/UNIX' },
    };
    expect(checkEC2012(r, cfg)).toBeNull();
  });

  it('does NOT fire for non-EC2 resources', () => {
    const r: Resource = { ...ec2Production, type: 'rds_instance' };
    expect(checkEC2012(r, cfg)).toBeNull();
  });
});

// ─── S3-002: Intelligent-Tiering ─────────────────────────────────────────────

describe('checkS3002 — Intelligent-Tiering', () => {
  it('fires when bucket has lifecycle but no Intelligent-Tiering', () => {
    const rec = checkS3002(s3DataLake, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('S3-002');
  });

  it('does NOT fire when bucket already has Intelligent-Tiering', () => {
    const r: Resource = {
      ...s3DataLake,
      configuration: {
        ...s3DataLake.configuration,
        has_intelligent_tiering: true,
      },
    };
    expect(checkS3002(r, cfg)).toBeNull();
  });

  it('does NOT fire when bucket has no lifecycle rules (S3-001 handles that)', () => {
    expect(checkS3002(s3Unencrypted, cfg)).toBeNull();
  });

  it('does NOT fire for non-S3 resources', () => {
    const r: Resource = { ...s3DataLake, type: 'ec2_instance' };
    expect(checkS3002(r, cfg)).toBeNull();
  });
});

// ─── S3-004: Encryption ──────────────────────────────────────────────────────

describe('checkS3004 — server-side encryption', () => {
  it('fires when encryption_enabled is false', () => {
    const rec = checkS3004(s3Unencrypted, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('S3-004');
    expect(rec!.impact).toBe('high');
  });

  it('does NOT fire when encryption_enabled is true', () => {
    const r: Resource = {
      ...s3Unencrypted,
      configuration: {
        ...s3Unencrypted.configuration,
        encryption_enabled: true,
      },
    };
    expect(checkS3004(r, cfg)).toBeNull();
  });

  it('does NOT fire for non-S3 resources', () => {
    const r: Resource = { ...s3Unencrypted, type: 'rds_instance' };
    expect(checkS3004(r, cfg)).toBeNull();
  });
});

// ─── RDS-009: Idle by connection count ───────────────────────────────────────

describe('checkRDS009 — idle by connections', () => {
  it('fires when connectionCount < threshold', () => {
    const rec = checkRDS009(rdsIdle, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('RDS-009');
    expect(rec!.impact).toBe('high');
  });

  it('does NOT fire when connectionCount >= threshold', () => {
    const rec = checkRDS009(rdsProduction, cfg);
    expect(rec).toBeNull();
  });

  it('does NOT fire for non-RDS resources', () => {
    const r: Resource = { ...rdsIdle, type: 'ec2_instance' };
    expect(checkRDS009(r, cfg)).toBeNull();
  });

  it('does NOT fire without utilization', () => {
    const r: Resource = { ...rdsIdle, utilization: undefined };
    expect(checkRDS009(r, cfg)).toBeNull();
  });

  it('does NOT fire when CPU < 1 (RDS-001 handles that case)', () => {
    const r: Resource = {
      ...rdsIdle,
      utilization: makeUtil({ cpuAverage: 0.5, connectionCount: 0, period: '7d' }),
    };
    expect(checkRDS009(r, cfg)).toBeNull();
  });
});

// ─── RDS-013: Low storage utilization ────────────────────────────────────────

describe('checkRDS013 — low storage utilization', () => {
  it('fires when free storage > rdsFreeStorageRatio and allocated > rdsMinStorageGB', () => {
    const rec = checkRDS013(rdsProduction, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('RDS-013');
    expect(rec!.estimatedSavings).toBeGreaterThan(0);
  });

  it('includes savings estimate based on $0.115/GB gp3 pricing', () => {
    const rec = checkRDS013(rdsProduction, cfg)!;
    // 500 GB allocated, 420 free, 80 used → suggested = 80*1.3 = 104 → savings = (500-104)*0.115
    expect(rec.estimatedSavings).toBeCloseTo((500 - 104) * 0.115, 0);
  });

  it('does NOT fire when storage is smaller than rdsMinStorageGB', () => {
    const r: Resource = {
      ...rdsProduction,
      configuration: {
        ...rdsProduction.configuration,
        allocated_storage: 50, // below rdsMinStorageGB (100)
        free_storage_gb: 45,
      },
    };
    expect(checkRDS013(r, cfg)).toBeNull();
  });

  it('does NOT fire when free ratio is below threshold', () => {
    const r: Resource = {
      ...rdsProduction,
      configuration: {
        ...rdsProduction.configuration,
        allocated_storage: 200,
        free_storage_gb: 80, // 40% free, below rdsFreeStorageRatio (70%)
      },
    };
    expect(checkRDS013(r, cfg)).toBeNull();
  });

  it('does NOT fire when free_storage_gb is 0 (not populated)', () => {
    const r: Resource = {
      ...rdsProduction,
      configuration: {
        ...rdsProduction.configuration,
        free_storage_gb: 0,
      },
    };
    expect(checkRDS013(r, cfg)).toBeNull();
  });
});
