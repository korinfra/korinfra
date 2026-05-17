import { describe, it, expect } from 'vitest';
import { confidenceFromUtilization, getMonthlyCost, getMonthlyCostStrict, triStateConfig } from '../../../../src/rules/cost/helpers.js';
import { checkEBS001 } from '../../../../src/rules/cost/ebs.js';
import { checkELB001 } from '../../../../src/rules/cost/elb.js';
import { checkELC003 } from '../../../../src/rules/cost/elasticache.js';
import { THRESHOLDS } from '../../../../src/rules/config.js';
import type { Resource } from '../../../../src/aws/types.js';

function makeUtil(partial: Partial<Resource['utilization']> = {}): NonNullable<Resource['utilization']> {
  return {
    period: '30d',
    cpuAverage: 0,
    cpuMax: 0,
    cpuP95: 0,
    cpuP99: 0,
    memoryAverage: 0,
    memoryMax: 0,
    memoryP95: 0,
    networkInMB: 0,
    networkOutMB: 0,
    diskReadIOPS: 0,
    diskWriteIOPS: 0,
    connectionCount: 0,
    connectionCountMax: 0,
    dataPoints: 100,
    dataGaps: 0,
    freshnessHrs: 1,
    ...partial,
  };
}

describe('confidenceFromUtilization — clamp + NaN safety (issue #37)', () => {
  it('never returns a value above 1.0 even when the base × 1.05 multiplier kicks in', () => {
    // base = 1.0 with 30d high-coverage window would raise to 1.05 without clamping
    const result = confidenceFromUtilization(1.0, makeUtil({ period: '30d', dataPoints: 1000, dataGaps: 1 }));
    expect(result).toBeLessThanOrEqual(1);
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it('never returns a value below 0 even when input base is negative', () => {
    const result = confidenceFromUtilization(-0.5, makeUtil());
    expect(result).toBe(0);
  });

  it('returns 0 when base is NaN', () => {
    expect(confidenceFromUtilization(NaN, makeUtil())).toBe(0);
  });

  it('returns 0 when base is Infinity', () => {
    expect(confidenceFromUtilization(Infinity, makeUtil())).toBe(0);
    expect(confidenceFromUtilization(-Infinity, makeUtil())).toBe(0);
  });

  it('returns clamped base when dataPoints is NaN', () => {
    const result = confidenceFromUtilization(0.8, makeUtil({ dataPoints: NaN }));
    expect(result).toBe(0.8);
  });

  it('returns clamped base when dataGaps is NaN (cannot produce NaN coverageRatio)', () => {
    const result = confidenceFromUtilization(0.8, makeUtil({ dataPoints: 100, dataGaps: NaN }));
    expect(result).toBe(0.8);
  });

  it('passes through valid values unchanged', () => {
    expect(confidenceFromUtilization(0.85, undefined)).toBe(0.85);
    expect(confidenceFromUtilization(0.5, makeUtil({ dataPoints: 0 }))).toBe(0.45);
  });
});

function makeResource(monthlyCost: unknown): Resource {
  return {
    id: 'r-test',
    arn: 'arn:test',
    type: 'ec2_instance',
    name: 'test',
    region: 'us-east-1',
    state: 'running',
    instanceType: 't3.micro',
    tags: {},
    launchTime: new Date().toISOString(),
    collectedAt: new Date().toISOString(),
    configuration: { monthlyCost },
  };
}

describe('getMonthlyCost — guards against bad values (issue #37 finding #2)', () => {
  it('returns the value for positive numbers', () => {
    expect(getMonthlyCost(makeResource(50))).toBe(50);
    expect(getMonthlyCost(makeResource(0.01))).toBe(0.01);
  });

  it('returns 0 for zero (valid baseline)', () => {
    expect(getMonthlyCost(makeResource(0))).toBe(0);
  });

  it('returns 0 for NaN / Infinity / negative', () => {
    expect(getMonthlyCost(makeResource(NaN))).toBe(0);
    expect(getMonthlyCost(makeResource(Infinity))).toBe(0);
    expect(getMonthlyCost(makeResource(-10))).toBe(0);
  });

  it('returns 0 for missing / non-numeric values', () => {
    expect(getMonthlyCost(makeResource(undefined))).toBe(0);
    expect(getMonthlyCost(makeResource('50'))).toBe(0);
    expect(getMonthlyCost(makeResource(null))).toBe(0);
  });
});

describe('getMonthlyCostStrict — null on missing or invalid (issue #37 finding #4)', () => {
  it('returns the value for positive numbers', () => {
    expect(getMonthlyCostStrict(makeResource(50))).toBe(50);
  });

  it('returns null for zero (caller must distinguish missing vs zero)', () => {
    expect(getMonthlyCostStrict(makeResource(0))).toBeNull();
  });

  it('returns null for NaN / Infinity / negative / missing', () => {
    expect(getMonthlyCostStrict(makeResource(NaN))).toBeNull();
    expect(getMonthlyCostStrict(makeResource(Infinity))).toBeNull();
    expect(getMonthlyCostStrict(makeResource(-10))).toBeNull();
    expect(getMonthlyCostStrict(makeResource(undefined))).toBeNull();
  });
});

describe('confidenceFromUtilization — coverage gap edge cases', () => {
  it('handles dataPoints=1, dataGaps=1000 (extreme low-coverage)', () => {
    const result = confidenceFromUtilization(0.85, makeUtil({ dataPoints: 1, dataGaps: 1000 }));
    expect(result).toBeLessThanOrEqual(0.55);
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it('handles freshnessHrs = NaN as if stale', () => {
    const result = confidenceFromUtilization(0.85, makeUtil({ freshnessHrs: NaN }));
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });
});

// Strict cost gating: cost-saving rules skip and emit warnings when
// monthly_cost is missing, instead of silently emitting savings=0.
describe('strict cost gating in cost-saving rules', () => {
  const cfg = THRESHOLDS;

  function captureWarnings() {
    const warnings: Array<{ ruleId: string; resourceId: string; resourceType: string; reason: string }> = [];
    return {
      ctx: { warn: (a: string, b: string, c: string, d: string) => warnings.push({ ruleId: a, resourceId: b, resourceType: c, reason: d }) },
      warnings,
    };
  }

  function makeRes(type: string, overrides: Partial<Resource> = {}): Resource {
    return {
      id: 'r-1',
      arn: 'arn:test',
      type,
      name: 'test',
      region: 'us-east-1',
      state: type === 'ebs_volume' ? 'available' : type === 'load_balancer' ? 'active' : 'active',
      instanceType: type === 'elasticache_cluster' ? 'cache.r5.large' : '',
      tags: {},
      launchTime: new Date(Date.now() - 365 * 86_400_000).toISOString(),
      collectedAt: new Date().toISOString(),
      configuration: {},
      ...overrides,
    };
  }

  it('checkEBS001 skips and warns when monthly_cost is missing', () => {
    const { ctx, warnings } = captureWarnings();
    const r = makeRes('ebs_volume', { configuration: { volume_type: 'gp3' } });
    expect(checkEBS001(r, cfg, ctx)).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ ruleId: 'EBS-001', resourceId: 'r-1' });
  });

  it('checkELB001 skips and warns when monthly_cost is null', () => {
    const { ctx, warnings } = captureWarnings();
    const r = makeRes('load_balancer', {
      configuration: { healthy_target_count: 0, monthlyCost: null },
    });
    expect(checkELB001(r, cfg, ctx)).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.ruleId).toBe('ELB-001');
  });

  it('checkELC003 skips and warns when monthly_cost is NaN', () => {
    const { ctx, warnings } = captureWarnings();
    const r = makeRes('elasticache_cluster', {
      configuration: { monthlyCost: NaN },
      utilization: {
        period: '30d', cpuAverage: 0.5, cpuMax: 1, cpuP95: 1, cpuP99: 1,
        memoryAverage: 0.5, memoryMax: 1, memoryP95: 1, networkInMB: 0,
        networkOutMB: 0, diskReadIOPS: 0, diskWriteIOPS: 0,
        connectionCount: 0, connectionCountMax: 0,
        dataPoints: 100, dataGaps: 0, freshnessHrs: 1,
      },
    });
    expect(checkELC003(r, cfg, ctx)).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.ruleId).toBe('ELC-003');
  });

  it('cost-saving rule emits recommendation when monthly_cost is valid (no warning)', () => {
    const { ctx, warnings } = captureWarnings();
    const r = makeRes('ebs_volume', {
      configuration: { volume_type: 'gp3', monthlyCost: 25 },
    });
    expect(checkEBS001(r, cfg, ctx)).not.toBeNull();
    expect(warnings).toHaveLength(0);
  });
});

describe('triStateConfig — true/false/unknown handling (issue #37 finding #7)', () => {
  function makeS3(value: unknown): Resource {
    return {
      ...makeResource(0),
      type: 's3_bucket',
      configuration: { encryption_enabled: value },
    };
  }

  it('returns booleans verbatim', () => {
    expect(triStateConfig(makeS3(true), 'encryption_enabled')).toBe(true);
    expect(triStateConfig(makeS3(false), 'encryption_enabled')).toBe(false);
  });

  it('recognises the "unknown" sentinel string', () => {
    expect(triStateConfig(makeS3('unknown'), 'encryption_enabled')).toBe('unknown');
  });

  it('parses "true" / "false" strings (Terraform-state compatibility)', () => {
    expect(triStateConfig(makeS3('true'), 'encryption_enabled')).toBe(true);
    expect(triStateConfig(makeS3('false'), 'encryption_enabled')).toBe(false);
    expect(triStateConfig(makeS3('TRUE'), 'encryption_enabled')).toBe(true);
  });

  it('returns undefined when the key is missing or unrecognised', () => {
    expect(triStateConfig(makeS3(undefined), 'encryption_enabled')).toBeUndefined();
    expect(triStateConfig(makeS3('garbage'), 'encryption_enabled')).toBeUndefined();
    expect(triStateConfig(makeS3(42), 'encryption_enabled')).toBeUndefined();
  });
});
