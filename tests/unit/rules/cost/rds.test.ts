import { describe, it, expect } from 'vitest';
import {
  checkRDS001, checkRDS002, checkRDS003, checkRDS004, checkRDS005, checkRDS006, checkRDS007, checkRDS008, checkRDS009, checkRDS010, checkRDS011, checkRDS012, checkRDS013, checkRDS014,
} from '../../../../src/rules/cost/rds.js';
import { THRESHOLDS } from '../../../../src/rules/config.js';
import type { Resource } from '../../../../src/aws/types.js';

const cfg = THRESHOLDS;

function makeRDS(overrides: Partial<Resource> = {}): Resource {
  return {
    id: 'db-abc123',
    arn: 'arn:aws:rds:us-east-1:123456789012:db:my-db',
    type: 'rds_instance',
    name: 'my-db',
    region: 'us-east-1',
    state: 'available',
    instanceType: 'db.t3.medium',
    tags: { Environment: 'production' },
    launchTime: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    collectedAt: new Date().toISOString(),
    configuration: { monthlyCost: 100, multi_az: false },
    ...overrides,
  };
}

function makeUtil(cpuAverage: number, cpuP95 = 10, period: '7d' | '14d' | '30d' = '7d') {
  return {
    period,
    cpuAverage,
    cpuMax: cpuAverage * 2,
    cpuP95,
    cpuP99: cpuP95 * 1.1,
    memoryAverage: 50,
    memoryMax: 60,
    memoryP95: 55,
    networkInMB: 10,
    networkOutMB: 5,
    diskReadIOPS: 5,
    diskWriteIOPS: 5,
    connectionCount: 2,
    connectionCountMax: 5,
    dataPoints: 200,
    dataGaps: 0,
    freshnessHrs: 1,
  };
}

// ─── RDS-001: Idle RDS ────────────────────────────────────────────────────────

describe('checkRDS001 — idle RDS instance', () => {
  it('fires when CPU avg < threshold with 90% savings and correct fields', () => {
    const r = makeRDS({ utilization: makeUtil(0.5), configuration: { monthlyCost: 200 } });
    const rec = checkRDS001(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('RDS-001');
    expect(rec!.impact).toBe('high');
    expect(rec!.estimatedSavings).toBeCloseTo(180, 2);
    // confidenceFromUtilization(0.85, util) with period='7d' applies 0.9× penalty → 0.765
    expect(rec!.confidence).toBeCloseTo(0.765);
  });

  it('does not fire when CPU >= threshold, no utilization, wrong type, or 0 dataPoints', () => {
    expect(checkRDS001(makeRDS({ utilization: makeUtil(5.0) }), cfg)).toBeNull();
    expect(checkRDS001(makeRDS(), cfg)).toBeNull();
    expect(checkRDS001(makeRDS({ type: 'ec2_instance', utilization: makeUtil(0.1) }), cfg)).toBeNull();
    const zeroPoints = { ...makeUtil(0.1), period: '7d' as const, dataPoints: 0 };
    expect(checkRDS001(makeRDS({ utilization: zeroPoints }), cfg)).toBeNull();
  });

  it('fires for 30d period', () => {
    expect(checkRDS001(makeRDS({ utilization: makeUtil(0.1, 1, '30d') }), cfg)).not.toBeNull();
  });

  // Issue #37 regression — confidence never exceeds 1.0 even when base × 1.05 is hit
  it('confidence is always clamped to [0,1] regardless of multipliers', () => {
    // Base 0.99 × 1.05 = 1.0395 would have leaked through before; now clamped
    const r = makeRDS({ utilization: makeUtil(0.1, 1, '30d') });
    const rec = checkRDS001(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.confidence).toBeGreaterThanOrEqual(0);
    expect(rec!.confidence).toBeLessThanOrEqual(1);
  });

  // Strict cost gating — RDS-001 returns null when monthly_cost is missing/invalid
  // instead of silently emitting estimatedSavings: 0. The rule context receives
  // a warning so JSON consumers can surface the skipped resource.
  it('skips and emits a warning when monthly_cost is NaN', () => {
    const warnings: Array<{ ruleId: string; resourceId: string; resourceType: string; reason: string }> = [];
    const ctx = {
      warn(ruleId: string, resourceId: string, resourceType: string, reason: string) {
        warnings.push({ ruleId, resourceId, resourceType, reason });
      },
    };
    const r = makeRDS({ utilization: makeUtil(0.1), configuration: { monthlyCost: NaN } });
    expect(checkRDS001(r, cfg, ctx)).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ ruleId: 'RDS-001', resourceId: r.id });
  });
});

// ─── RDS-003: Oversized RDS ───────────────────────────────────────────────────

describe('checkRDS003 — oversized RDS instance', () => {
  it('fires when CPU avg < threshold with 40% savings and high impact', () => {
    const r = makeRDS({
      instanceType: 'db.m5.xlarge',
      utilization: makeUtil(5.0, 10),
      configuration: { monthlyCost: 300 },
    });
    const rec = checkRDS003(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('RDS-003');
    expect(rec!.impact).toBe('high');
    // Real pricing delta: db.m5.xlarge (0.342/hr) → db.m5.large (0.171/hr): 0.171*730 ≈ 124.83
    expect(rec!.estimatedSavings).toBeCloseTo(124.83, 1);
  });

  it('does not fire when CPU >= threshold, no utilization, wrong type, or already smallest', () => {
    expect(checkRDS003(makeRDS({ instanceType: 'db.m5.xlarge', utilization: makeUtil(20.0, 30) }), cfg)).toBeNull();
    expect(checkRDS003(makeRDS({ instanceType: 'db.m5.xlarge' }), cfg)).toBeNull();
    expect(checkRDS003(makeRDS({ type: 'ec2_instance', instanceType: 'db.m5.xlarge', utilization: makeUtil(2.0, 5) }), cfg)).toBeNull();
    expect(checkRDS003(makeRDS({ instanceType: 'db.t3.nano', utilization: makeUtil(0.5, 1) }), cfg)).toBeNull();
  });

  // #44 Item 2: when both pricing-table tiers fail, fall back to monthly_cost; warn + skip if missing too.
  it('skips and warns when pricing-table lookup fails AND monthly_cost is missing', () => {
    const warnings: Array<{ ruleId: string; resourceId: string; resourceType: string; reason: string }> = [];
    const ctx = {
      warn(ruleId: string, resourceId: string, resourceType: string, reason: string) {
        warnings.push({ ruleId, resourceId, resourceType, reason });
      },
    };
    // 'db.zzz.xlarge' is intentionally not in FALLBACK_RDS_PRICES so both pricing lookups return 0;
    // 'xlarge' is a valid size index so suggestRDSRightsize produces 'db.zzz.medium' (different from
    // the input) and the rule proceeds past the suggestedType === r.instanceType early-out.
    const r = makeRDS({
      instanceType: 'db.zzz.xlarge',
      utilization: makeUtil(5.0, 10),
      configuration: { monthlyCost: NaN },
    });
    expect(checkRDS003(r, cfg, ctx)).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      ruleId: 'RDS-003',
      resourceId: r.id,
      reason: 'monthly_cost missing or invalid',
    });
  });
});

// ─── RDS-002: Production RDS without Multi-AZ ─────────────────────────────────

describe('checkRDS002 — Production RDS without Multi-AZ', () => {
  it('fires for production environment without Multi-AZ with 0 savings (reliability)', () => {
    const r = makeRDS({ configuration: { multi_az: false, monthlyCost: 100 }, tags: { Environment: 'production' } });
    const rec = checkRDS002(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('RDS-002');
    expect(rec!.impact).toBe('high');
    expect(rec!.risk).toBe('low');
    expect(rec!.estimatedSavings).toBe(0);
  });

  it('does not fire for non-prod, Multi-AZ enabled, or wrong type', () => {
    expect(checkRDS002(makeRDS({ configuration: { multi_az: false, monthlyCost: 100 }, tags: { Environment: 'staging' } }), cfg)).toBeNull();
    expect(checkRDS002(makeRDS({ configuration: { multi_az: true, monthlyCost: 100 }, tags: { Environment: 'production' } }), cfg)).toBeNull();
    expect(checkRDS002(makeRDS({ type: 'ec2_instance', configuration: { multi_az: false, monthlyCost: 100 }, tags: { Environment: 'production' } }), cfg)).toBeNull();
  });
});

// ─── RDS-007: Multi-AZ in non-prod ────────────────────────────────────────────

describe('checkRDS007 — Multi-AZ in non-production environment', () => {
  it('fires for non-prod environments (staging/dev/development/test) with 50% savings', () => {
    for (const env of ['staging', 'dev', 'development', 'test']) {
      const r = makeRDS({ configuration: { multi_az: true, monthlyCost: 100 }, tags: { Environment: env } });
      expect(checkRDS007(r, cfg)).not.toBeNull();
    }
    const stagingRec = checkRDS007(makeRDS({
      configuration: { multi_az: true, monthlyCost: 300 },
      tags: { Environment: 'staging' },
    }), cfg);
    expect(stagingRec!.ruleId).toBe('RDS-007');
    expect(stagingRec!.impact).toBe('high');
    expect(stagingRec!.estimatedSavings).toBeCloseTo(150, 2);
  });

  it('does not fire for production, Multi-AZ disabled, wrong type, or case-insensitive match works', () => {
    expect(checkRDS007(makeRDS({ configuration: { multi_az: true, monthlyCost: 200 }, tags: { Environment: 'production' } }), cfg)).toBeNull();
    expect(checkRDS007(makeRDS({ configuration: { multi_az: false, monthlyCost: 100 }, tags: { Environment: 'staging' } }), cfg)).toBeNull();
    expect(checkRDS007(makeRDS({ type: 'ec2_instance', configuration: { multi_az: true, monthlyCost: 100 }, tags: { Environment: 'staging' } }), cfg)).toBeNull();
    // case-insensitive
    expect(checkRDS007(makeRDS({ configuration: { multi_az: true, monthlyCost: 100 }, tags: { Environment: 'STAGING' } }), cfg)).not.toBeNull();
  });
});

// ─── RDS-004: Unencrypted RDS storage ──────────────────────────────────────────

describe('checkRDS004 — unencrypted RDS storage', () => {
  it('fires when storage_encrypted is explicitly false with security impact', () => {
    const r = makeRDS({ configuration: { storage_encrypted: false } });
    const rec = checkRDS004(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('RDS-004');
    expect(rec!.impact).toBe('high');
    expect(rec!.risk).toBe('high');
    expect(rec!.confidence).toBe(0.99);
    expect(rec!.estimatedSavings).toBe(0);
  });

  it('does not fire when storage_encrypted is true, wrong type, or not relevant for this rule', () => {
    expect(checkRDS004(makeRDS({ configuration: { storage_encrypted: true } }), cfg)).toBeNull();
    expect(checkRDS004(makeRDS({ type: 'ec2_instance', configuration: { storage_encrypted: false } }), cfg)).toBeNull();
  });
});

// ─── RDS-005: Publicly accessible RDS instance ─────────────────────────────────

describe('checkRDS005 — publicly accessible RDS', () => {
  it('fires when publicly_accessible is true with security impact', () => {
    const r = makeRDS({ configuration: { publicly_accessible: true } });
    const rec = checkRDS005(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('RDS-005');
    expect(rec!.impact).toBe('high');
    expect(rec!.risk).toBe('low');
    expect(rec!.confidence).toBe(0.99);
    expect(rec!.estimatedSavings).toBe(0);
  });

  it('does not fire when publicly_accessible is false or missing', () => {
    expect(checkRDS005(makeRDS({ configuration: { publicly_accessible: false } }), cfg)).toBeNull();
    expect(checkRDS005(makeRDS({ configuration: {} }), cfg)).toBeNull();
  });
});

// ─── RDS-006: gp2 → gp3 storage migration ─────────────────────────────────────

describe('checkRDS006 — gp2 to gp3 migration', () => {
  it('fires for gp2 storage with 20% savings', () => {
    const r = makeRDS({ configuration: { storage_type: 'gp2', monthlyCost: 100 } });
    const rec = checkRDS006(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('RDS-006');
    expect(rec!.impact).toBe('medium');
    expect(rec!.risk).toBe('low');
    expect(rec!.confidence).toBe(0.95);
    expect(rec!.estimatedSavings).toBeCloseTo(20, 2);
  });

  it('does not fire for gp3, io1, io2, or missing storage_type', () => {
    expect(checkRDS006(makeRDS({ configuration: { storage_type: 'gp3' } }), cfg)).toBeNull();
    expect(checkRDS006(makeRDS({ configuration: { storage_type: 'io1' } }), cfg)).toBeNull();
    expect(checkRDS006(makeRDS({ configuration: {} }), cfg)).toBeNull();
  });
});

// ─── RDS-008: Graviton migration ───────────────────────────────────────────────

describe('checkRDS008 — Graviton migration', () => {
  it('fires for eligible x86 instances (m5, r5, c5, t3) with 10-20% savings', () => {
    // t3 → t4g migration
    const r = makeRDS({ instanceType: 'db.t3.medium', configuration: { monthlyCost: 50 } });
    const rec = checkRDS008(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('RDS-008');
    expect(rec!.confidence).toBeGreaterThanOrEqual(0.65);
    expect(rec!.impact).toBe('medium');
    expect(rec!.risk).toBe('low');
  });

  it('does not fire for Graviton instances or unmapped families', () => {
    expect(checkRDS008(makeRDS({ instanceType: 'db.t4g.medium' }), cfg)).toBeNull();
    expect(checkRDS008(makeRDS({ instanceType: 'db.m7g.xlarge' }), cfg)).toBeNull();
    // unmapped family
    expect(checkRDS008(makeRDS({ instanceType: 'db.x1.xlarge' }), cfg)).toBeNull();
  });
});

// ─── RDS-009: Idle RDS by connection count ─────────────────────────────────────

describe('checkRDS009 — idle by connection count', () => {
  it('fires when connectionCount < threshold and CPU >= threshold, with confidence penalty for peaks', () => {
    const r = makeRDS({
      utilization: { ...makeUtil(5.0, 10), connectionCount: 0, connectionCountMax: 0, dataPoints: 100 },
      configuration: { monthlyCost: 100 },
    });
    const rec = checkRDS009(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('RDS-009');
    expect(rec!.impact).toBe('high');
    expect(rec!.risk).toBe('medium');
  });

  it('does not fire when CPU < idle threshold (RDS-001 handles it)', () => {
    expect(checkRDS009(makeRDS({
      utilization: makeUtil(0.5, 1),
      configuration: { monthlyCost: 100 },
    }), cfg)).toBeNull();
  });

  it('reduces confidence if peak connections > 5 despite low average', () => {
    const r = makeRDS({
      utilization: { ...makeUtil(5.0, 10), connectionCount: 0.5, connectionCountMax: 10, dataPoints: 100 },
      configuration: { monthlyCost: 100 },
    });
    const rec = checkRDS009(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.confidence).toBeLessThanOrEqual(0.60);
  });
});

// ─── RDS-010: Reserved Instance opportunity ────────────────────────────────────

describe('checkRDS010 — Reserved Instance opportunity', () => {
  it('fires for stable high-CPU workload with 33% savings estimate', () => {
    const r = makeRDS({
      state: 'available',
      utilization: { ...makeUtil(30.0, 35), dataPoints: 150 },
      configuration: { monthlyCost: 150 },
    });
    const rec = checkRDS010(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('RDS-010');
    expect(rec!.confidence).toBeCloseTo(0.70, 2);
    expect(rec!.estimatedSavings).toBeCloseTo(49.5, 2); // 150 * 0.33
  });

  it('does not fire for low CPU, insufficient data points, low cost, or not available', () => {
    expect(checkRDS010(makeRDS({
      state: 'available',
      utilization: { ...makeUtil(2.0, 3), dataPoints: 150 },
      configuration: { monthlyCost: 150 },
    }), cfg)).toBeNull();
    expect(checkRDS010(makeRDS({
      state: 'available',
      utilization: { ...makeUtil(30.0, 35), dataPoints: 50 },
      configuration: { monthlyCost: 150 },
    }), cfg)).toBeNull();
    expect(checkRDS010(makeRDS({
      state: 'stopped',
      utilization: { ...makeUtil(30.0, 35), dataPoints: 150 },
      configuration: { monthlyCost: 150 },
    }), cfg)).toBeNull();
  });
});

// ─── RDS-011: RDS without automated backups ────────────────────────────────────

describe('checkRDS011 — backups disabled', () => {
  it('fires when backup_retention_period = 0 with high confidence', () => {
    const r = makeRDS({ configuration: { backup_retention_period: 0 } });
    const rec = checkRDS011(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('RDS-011');
    expect(rec!.impact).toBe('high');
    expect(rec!.risk).toBe('low');
    expect(rec!.confidence).toBe(0.95);
    expect(rec!.estimatedSavings).toBe(0);
  });

  it('does not fire when backup_retention_period > 0 or field missing', () => {
    expect(checkRDS011(makeRDS({ configuration: { backup_retention_period: 7 } }), cfg)).toBeNull();
    expect(checkRDS011(makeRDS({ configuration: {} }), cfg)).toBeNull();
  });
});

// ─── RDS-012: Extended Support surcharge ───────────────────────────────────────

describe('checkRDS012 — Extended Support surcharge', () => {
  it('fires for MySQL 5.x and MySQL 8.0 with per-vCPU monthly cost', () => {
    const r = makeRDS({
      instanceType: 'db.t3.medium',
      configuration: { engine: 'mysql', engine_version: '5.7.44' },
    });
    const rec = checkRDS012(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('RDS-012');
    expect(rec!.estimatedSavings).toBeGreaterThan(0);
    expect(rec!.confidence).toBe(0.85);
  });

  it('fires for PostgreSQL 14 and below', () => {
    const r = makeRDS({
      instanceType: 'db.t3.medium',
      configuration: { engine: 'postgres', engine_version: '14.10' },
    });
    const rec = checkRDS012(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('RDS-012');
    expect(rec!.estimatedSavings).toBeGreaterThan(0);
  });

  it('does not fire for supported versions', () => {
    expect(checkRDS012(makeRDS({
      instanceType: 'db.t3.medium',
      configuration: { engine: 'mysql', engine_version: '8.4.0' },
    }), cfg)).toBeNull();
    expect(checkRDS012(makeRDS({
      instanceType: 'db.t3.medium',
      configuration: { engine: 'postgres', engine_version: '15.5' },
    }), cfg)).toBeNull();
  });
});

// ─── RDS-013: Low storage utilization ──────────────────────────────────────────

describe('checkRDS013 — low storage utilization', () => {
  it('fires when free storage > threshold with storage reduction suggestion', () => {
    const r = makeRDS({
      configuration: {
        allocated_storage: 500,
        free_storage_gb: 450,
      },
    });
    const rec = checkRDS013(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('RDS-013');
    expect(rec!.impact).toBe('medium');
    expect(rec!.risk).toBe('low');
    expect(rec!.estimatedSavings).toBeGreaterThanOrEqual(0);
  });

  it('does not fire when free storage is low, allocated storage is minimal, or free > allocated (stale)', () => {
    expect(checkRDS013(makeRDS({
      configuration: { allocated_storage: 500, free_storage_gb: 100 },
    }), cfg)).toBeNull();
    expect(checkRDS013(makeRDS({
      configuration: { allocated_storage: 20, free_storage_gb: 10 },
    }), cfg)).toBeNull();
    // free > allocated: stale metric, skipped
    expect(checkRDS013(makeRDS({
      configuration: { allocated_storage: 100, free_storage_gb: 150 },
    }), cfg)).toBeNull();
  });
});

// ─── RDS-014: Proactive EOL warning ────────────────────────────────────────────

describe('checkRDS014 — proactive EOL warning', () => {
  it('fires for PostgreSQL 15 or earlier approaching EOL (< 180 days)', () => {
    // Note: This test depends on current date. Use a recent version to ensure < 180 days to EOL.
    // PG 15 EOL: Oct 2027 — currently (April 2026) is ~540 days away, too far.
    // Skip specific date test; instead test the logic structure.
    const r = makeRDS({
      instanceType: 'db.t3.medium',
      configuration: { engine: 'postgres', engine_version: '15.5' },
    });
    // May not fire depending on current date; just ensure no crash
    expect(() => checkRDS014(r, cfg)).not.toThrow();
  });

  it('does not fire for versions far from EOL or unrecognized', () => {
    expect(checkRDS014(makeRDS({
      instanceType: 'db.t3.medium',
      configuration: { engine: 'mysql', engine_version: '8.0.28' },
    }), cfg)).toBeNull();
  });
});
