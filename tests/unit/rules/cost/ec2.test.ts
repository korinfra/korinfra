import { describe, it, expect } from 'vitest';
import {
  checkEC2001,
  checkEC2002,
  checkEC2003,
  checkEC2004,
  checkEC2005,
  checkEC2006,
  checkEC2007,
  checkEC2008,
  checkEC2009,
  checkEC2010,
  checkEC2011,
  checkEC2012,
  checkEC2013,
} from '../../../../src/rules/cost/ec2.js';
import { suggestRDSRightsize, suggestCacheRightsize } from '../../../../src/rules/cost/helpers.js';
import { THRESHOLDS } from '../../../../src/rules/config.js';
import type { Resource } from '../../../../src/aws/types.js';

const cfg = THRESHOLDS;

function makeEC2(overrides: Partial<Resource> = {}): Resource {
  return {
    id: 'i-abc123',
    arn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-abc123',
    type: 'ec2_instance',
    name: 'web',
    region: 'us-east-1',
    state: 'running',
    instanceType: 't3.large',
    tags: {},
    launchTime: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    collectedAt: new Date().toISOString(),
    configuration: { monthlyCost: 100 },
    ...overrides,
  };
}

function makeUtil(cpuAverage: number, cpuP95 = 50, period: '7d' | '14d' | '30d' = '7d') {
  return {
    period,
    cpuAverage,
    cpuMax: cpuAverage * 1.5,
    cpuP95,
    cpuP99: cpuP95 * 1.1,
    memoryAverage: 50,
    memoryMax: 60,
    memoryP95: 55,
    networkInMB: 100,
    networkOutMB: 50,
    diskReadIOPS: 10,
    diskWriteIOPS: 10,
    connectionCount: 5,
    connectionCountMax: 10,
    dataPoints: 200,
    dataGaps: 0,
    freshnessHrs: 1,
  };
}

// ─── EC2-001: Idle instance ────────────────────────────────────────────────────

describe('checkEC2001 — idle instance', () => {
  it('fires when CPU avg < idleCPUThreshold and calculates 80% savings', () => {
    const r = makeEC2({ utilization: makeUtil(2.0), configuration: { monthlyCost: 200 } });
    const rec = checkEC2001(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('EC2-001');
    expect(rec!.impact).toBe('high');
    // Savings = monthlyCost − ebsMonthlyCost. No EBS volumes set → savings = full cost = 200.
    expect(rec!.estimatedSavings).toBeCloseTo(200, 2);
  });

  it('does not fire when CPU >= threshold, no utilization data, wrong type, or 0 dataPoints', () => {
    expect(checkEC2001(makeEC2({ utilization: makeUtil(10.0) }), cfg)).toBeNull();
    expect(checkEC2001(makeEC2(), cfg)).toBeNull();
    expect(checkEC2001(makeEC2({ type: 'rds_instance', utilization: makeUtil(1.0) }), cfg)).toBeNull();
    const zeroPoints = { ...makeUtil(1.0), period: '7d' as const, dataPoints: 0 };
    expect(checkEC2001(makeEC2({ utilization: zeroPoints }), cfg)).toBeNull();
  });

  it('fires for 14d and 30d periods', () => {
    expect(checkEC2001(makeEC2({ utilization: makeUtil(1.0, 2, '14d') }), cfg)).not.toBeNull();
    expect(checkEC2001(makeEC2({ utilization: makeUtil(0.5, 1, '30d') }), cfg)).not.toBeNull();
  });
});

// ─── EC2-002: Stopped instance ────────────────────────────────────────────────

describe('checkEC2002 — stopped instance', () => {
  it('fires when stopped > threshold and falls back to $5 min savings', () => {
    const r = makeEC2({
      state: 'stopped',
      launchTime: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      configuration: { monthlyCost: 100, stopped_at: new Date(Date.now() - 8 * 86_400_000).toISOString() },
    });
    const rec = checkEC2002(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('EC2-002');

    // min savings fallback
    const r2 = makeEC2({
      state: 'stopped',
      launchTime: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      configuration: { monthlyCost: 0, stopped_at: new Date(Date.now() - 30 * 86_400_000).toISOString() },
    });
    expect(checkEC2002(r2, cfg)!.estimatedSavings).toBe(5);
  });

  it('does not fire when stopped < threshold, running, or wrong type', () => {
    const stopped3d = makeEC2({
      state: 'stopped',
      launchTime: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      configuration: { monthlyCost: 50, stopped_at: new Date(Date.now() - 3 * 86_400_000).toISOString() },
    });
    expect(checkEC2002(stopped3d, cfg)).toBeNull();
    expect(checkEC2002(makeEC2({ state: 'running', launchTime: new Date(Date.now() - 30 * 86_400_000).toISOString() }), cfg)).toBeNull();
    expect(checkEC2002(makeEC2({ type: 'ebs_volume', state: 'stopped', launchTime: new Date(Date.now() - 30 * 86_400_000).toISOString() }), cfg)).toBeNull();
  });
});

// ─── EC2-003: Previous-generation instance ────────────────────────────────────

describe('checkEC2003 — previous-gen instance', () => {
  it('fires for m3/m4 families and suggests m5 equivalent with 15% savings', () => {
    const m3 = makeEC2({ instanceType: 'm3.large', configuration: { monthlyCost: 100 } });
    const rec = checkEC2003(m3, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('EC2-003');
    expect(rec!.suggestedConfig).toMatchObject({ instance_type: 'm5.large' });
    expect(rec!.estimatedSavings).toBeCloseTo(15, 2);

    const m4 = makeEC2({ instanceType: 'm4.xlarge' });
    expect(checkEC2003(m4, cfg)!.suggestedConfig!.instance_type).toBe('m5.xlarge');
  });

  it('does not fire for current-gen or wrong type', () => {
    expect(checkEC2003(makeEC2({ instanceType: 'm6g.large' }), cfg)).toBeNull();
    expect(checkEC2003(makeEC2({ type: 'rds_instance', instanceType: 'm3.large' }), cfg)).toBeNull();
  });
});

// ─── EC2-006: Graviton migration ─────────────────────────────────────────────

describe('checkEC2006 — Graviton migration', () => {
  it('suggests Graviton equivalent for x86_64 instances with 20% savings', () => {
    const r = makeEC2({
      instanceType: 't3.large',
      configuration: { architecture: 'x86_64', monthlyCost: 200 },
    });
    const rec = checkEC2006(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('EC2-006');
    expect(rec!.suggestedConfig!.instance_type).toBe('t4g.large');
    // Savings from real pricing: t3.large (0.0832/hr) → t4g.large (0.0672/hr): (0.016)*730 ≈ 11.68
    expect(rec!.estimatedSavings).toBeCloseTo(11.68, 1);

    const t3m = makeEC2({ instanceType: 't3.medium', configuration: { architecture: 'x86_64', monthlyCost: 50 } });
    expect(checkEC2006(t3m, cfg)!.suggestedConfig!.instance_type).toBe('t4g.medium');
  });

  it('does not fire for arm64, non-x86_64, no Graviton equivalent, or wrong type', () => {
    expect(checkEC2006(makeEC2({ instanceType: 'm6g.large', configuration: { architecture: 'arm64' } }), cfg)).toBeNull();
    expect(checkEC2006(makeEC2({ instanceType: 'm5.large', configuration: { architecture: 'i386' } }), cfg)).toBeNull();
    expect(checkEC2006(makeEC2({ instanceType: 'm3.large', configuration: { architecture: 'x86_64' } }), cfg)).toBeNull();
    expect(checkEC2006(makeEC2({ instanceType: 'p4d.24xlarge', configuration: { architecture: 'x86_64' } }), cfg)).toBeNull();
    expect(checkEC2006(makeEC2({ type: 'rds_instance', configuration: { architecture: 'x86_64' } }), cfg)).toBeNull();
  });
});

// ─── EC2-004: Oversized instance ──────────────────────────────────────────────

describe('checkEC2004 — oversized instance (CPU P95 < rightsizeCPUThreshold)', () => {
  it('fires when CPU P95 < 30% and suggests a smaller type', () => {
    const r = makeEC2({
      instanceType: 'm5.xlarge',
      configuration: { monthlyCost: 100 },
      utilization: makeUtil(10, 20),
    });
    const rec = checkEC2004(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('EC2-004');
    expect(rec!.impact).toBe('high');
    expect(rec!.suggestedConfig!.instance_type).toBe('m5.large');
    expect(rec!.currentConfig!.cpu_p95_pct).toBe(20);
    expect(rec!.estimatedSavings).toBeGreaterThan(0);
  });

  it('does not fire when CPU P95 >= 30%, metal type, memory-bound, network-intensive, or IOPS-intensive', () => {
    // P95 above threshold
    expect(checkEC2004(makeEC2({ utilization: makeUtil(40, 35) }), cfg)).toBeNull();
    // metal instance
    expect(checkEC2004(makeEC2({ instanceType: 'i3.metal', utilization: makeUtil(5, 10) }), cfg)).toBeNull();
    // memory-bound (> 2000 MB)
    expect(checkEC2004(makeEC2({
      utilization: { ...makeUtil(5, 10), memoryAverage: 2500 },
    }), cfg)).toBeNull();
    // network-intensive (> 100000 MB)
    expect(checkEC2004(makeEC2({
      utilization: { ...makeUtil(5, 10), networkOutMB: 150_000 },
    }), cfg)).toBeNull();
    // IOPS-intensive (> 5000 combined)
    expect(checkEC2004(makeEC2({
      utilization: { ...makeUtil(5, 10), diskReadIOPS: 3000, diskWriteIOPS: 3000 },
    }), cfg)).toBeNull();
    // no utilization
    expect(checkEC2004(makeEC2(), cfg)).toBeNull();
    // wrong type
    expect(checkEC2004(makeEC2({ type: 'rds_instance', utilization: makeUtil(5, 10) }), cfg)).toBeNull();
  });
});

// ─── EC2-005: On-demand > 30 days ─────────────────────────────────────────────

describe('checkEC2005 — on-demand instance running 30+ days', () => {
  it('fires for on-demand instance running >= 30 days with RI savings', () => {
    const r = makeEC2({
      state: 'running',
      launchTime: new Date(Date.now() - 35 * 86_400_000).toISOString(),
      configuration: { monthlyCost: 200 },
    });
    const rec = checkEC2005(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('EC2-005');
    expect(rec!.impact).toBe('high');
    expect(rec!.estimatedSavings).toBeCloseTo(200 * cfg.ec2RIDiscountMultiplier, 2);
    expect(rec!.suggestedConfig!.pricing).toBe('reserved_1yr_no_upfront');
  });

  it('does not fire when running < 30 days, spot lifecycle, not running, or wrong type', () => {
    // too young
    expect(checkEC2005(makeEC2({ state: 'running', launchTime: new Date(Date.now() - 10 * 86_400_000).toISOString() }), cfg)).toBeNull();
    // spot
    expect(checkEC2005(makeEC2({
      state: 'running',
      launchTime: new Date(Date.now() - 35 * 86_400_000).toISOString(),
      configuration: { monthlyCost: 100, lifecycle: 'spot' },
    }), cfg)).toBeNull();
    // stopped
    expect(checkEC2005(makeEC2({ state: 'stopped', launchTime: new Date(Date.now() - 35 * 86_400_000).toISOString() }), cfg)).toBeNull();
    // wrong type
    expect(checkEC2005(makeEC2({ type: 'rds_instance', state: 'running', launchTime: new Date(Date.now() - 35 * 86_400_000).toISOString() }), cfg)).toBeNull();
  });
});

// ─── EC2-007: t2 → t3 migration ───────────────────────────────────────────────

describe('checkEC2007 — t2 to t3 upgrade', () => {
  it('fires for any t2 instance and suggests t3 equivalent', () => {
    const r = makeEC2({ instanceType: 't2.large', configuration: { monthlyCost: 80 } });
    const rec = checkEC2007(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('EC2-007');
    expect(rec!.suggestedConfig!.instance_type).toBe('t3.large');
    expect(rec!.currentConfig!.instance_type).toBe('t2.large');
    expect(rec!.estimatedSavings).toBeGreaterThanOrEqual(0);

    expect(checkEC2007(makeEC2({ instanceType: 't2.medium' }), cfg)!.suggestedConfig!.instance_type).toBe('t3.medium');
    expect(checkEC2007(makeEC2({ instanceType: 't2.xlarge' }), cfg)!.suggestedConfig!.instance_type).toBe('t3.xlarge');
  });

  it('does not fire for non-t2 families or wrong resource type', () => {
    expect(checkEC2007(makeEC2({ instanceType: 't3.large' }), cfg)).toBeNull();
    expect(checkEC2007(makeEC2({ instanceType: 'm5.large' }), cfg)).toBeNull();
    expect(checkEC2007(makeEC2({ type: 'rds_instance', instanceType: 't2.large' }), cfg)).toBeNull();
  });
});

// ─── EC2-008: GPU/specialty previous-gen upgrade ──────────────────────────────

describe('checkEC2008 — GPU/specialty previous-gen upgrade', () => {
  it('fires for g2, g3, p2, p3, inf1 families and suggests current-gen equivalents', () => {
    const g2 = makeEC2({ instanceType: 'g2.2xlarge', configuration: { monthlyCost: 200 } });
    const rec = checkEC2008(g2, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('EC2-008');
    expect(rec!.suggestedConfig!.instance_type).toBe('g5.2xlarge');

    expect(checkEC2008(makeEC2({ instanceType: 'p2.xlarge' }), cfg)!.suggestedConfig!.instance_type).toBe('p5.xlarge');
    expect(checkEC2008(makeEC2({ instanceType: 'inf1.xlarge' }), cfg)!.suggestedConfig!.instance_type).toBe('inf2.xlarge');
  });

  it('does not fire for current-gen, EC2-003 families, or wrong type', () => {
    expect(checkEC2008(makeEC2({ instanceType: 'g5.2xlarge' }), cfg)).toBeNull();
    // m3 is handled by EC2-003 (isPreviousGen), so EC2-008 skips it
    expect(checkEC2008(makeEC2({ instanceType: 'm3.large' }), cfg)).toBeNull();
    expect(checkEC2008(makeEC2({ type: 'rds_instance', instanceType: 'g2.2xlarge' }), cfg)).toBeNull();
  });
});

// ─── EC2-009: Stopped instance with EBS charges ───────────────────────────────

describe('checkEC2009 — stopped instance incurring EBS charges', () => {
  it('fires for recently-stopped instance (before EC2-002 threshold) with EBS cost', () => {
    const r = makeEC2({
      state: 'stopped',
      configuration: {
        monthlyCost: 50,
        ebs_volumes_total_gb: 100,
        stopped_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      },
    });
    const rec = checkEC2009(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('EC2-009');
    expect(rec!.impact).toBe('medium');
    // 100 GB * $0.08 = $8/mo
    expect(rec!.estimatedSavings).toBeCloseTo(8, 2);
    expect(rec!.currentConfig!.ebs_volumes_total_gb).toBe(100);
  });

  it('uses baseline savings when no EBS GB data is available', () => {
    const r = makeEC2({
      state: 'stopped',
      configuration: {
        monthlyCost: 50,
        stopped_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      },
    });
    const rec = checkEC2009(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.estimatedSavings).toBe(20); // 4 * EBS_MINIMUM_MONTHLY_USD
  });

  it('does not fire when stopped >= 7 days (EC2-002 owns that case), running, or wrong type', () => {
    const longStopped = makeEC2({
      state: 'stopped',
      configuration: { stopped_at: new Date(Date.now() - 8 * 86_400_000).toISOString() },
    });
    expect(checkEC2009(longStopped, cfg)).toBeNull();
    expect(checkEC2009(makeEC2({ state: 'running' }), cfg)).toBeNull();
    expect(checkEC2009(makeEC2({ type: 'ebs_volume', state: 'stopped' }), cfg)).toBeNull();
  });
});

// ─── EC2-010: High outbound data transfer ─────────────────────────────────────

describe('checkEC2010 — high outbound data transfer', () => {
  // threshold is 1 TB/month = 1_048_576 MB
  it('fires when outbound > 1 TB/month (normalized to 30-day equivalent)', () => {
    // 7d period: need > 1_048_576 MB/mo → raw > 1_048_576 * (7/30) ≈ 244,812 MB
    const r = makeEC2({
      utilization: { ...makeUtil(10, 20), networkOutMB: 300_000, period: '7d' },
    });
    const rec = checkEC2010(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('EC2-010');
    expect(rec!.estimatedSavings).toBe(0); // informational rule
    expect(rec!.currentConfig!.network_out_gb_mo_estimated).toBeGreaterThan(1000);
  });

  it('does not fire below threshold, with no utilization, or wrong type', () => {
    expect(checkEC2010(makeEC2({ utilization: makeUtil(10, 20) }), cfg)).toBeNull(); // networkOutMB=50
    expect(checkEC2010(makeEC2(), cfg)).toBeNull();
    expect(checkEC2010(makeEC2({ type: 'rds_instance', utilization: { ...makeUtil(10, 20), networkOutMB: 300_000 } }), cfg)).toBeNull();
  });
});

// ─── EC2-011: No EBS optimization ─────────────────────────────────────────────

describe('checkEC2011 — EBS optimization not enabled', () => {
  it('fires for non-burstable instance without EBS optimization', () => {
    const r = makeEC2({
      instanceType: 'm5.large',
      configuration: { monthlyCost: 80, ebs_optimized: false },
    });
    const rec = checkEC2011(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('EC2-011');
    expect(rec!.impact).toBe('medium');
    expect(rec!.estimatedSavings).toBe(0);
    expect(rec!.currentConfig!.ebs_optimized).toBe(false);
    expect(rec!.suggestedConfig!.ebs_optimized).toBe(true);
  });

  it('does not fire when ebs_optimized=true, burstable family, key absent, or wrong type', () => {
    // already optimized
    expect(checkEC2011(makeEC2({ instanceType: 'm5.large', configuration: { monthlyCost: 80, ebs_optimized: true } }), cfg)).toBeNull();
    // burstable families are excluded
    expect(checkEC2011(makeEC2({ instanceType: 't3.large', configuration: { monthlyCost: 80, ebs_optimized: false } }), cfg)).toBeNull();
    expect(checkEC2011(makeEC2({ instanceType: 't2.large', configuration: { monthlyCost: 80, ebs_optimized: false } }), cfg)).toBeNull();
    expect(checkEC2011(makeEC2({ instanceType: 't4g.medium', configuration: { monthlyCost: 80, ebs_optimized: false } }), cfg)).toBeNull();
    // key not present in configuration — rule requires explicit presence
    expect(checkEC2011(makeEC2({ instanceType: 'm5.large', configuration: { monthlyCost: 80 } }), cfg)).toBeNull();
    // wrong resource type
    expect(checkEC2011(makeEC2({ type: 'rds_instance', instanceType: 'm5.large', configuration: { ebs_optimized: false } }), cfg)).toBeNull();
  });
});

// ─── EC2-012: IMDSv2 not enforced ─────────────────────────────────────────────

describe('checkEC2012 — IMDSv2 not enforced', () => {
  it('fires when metadata_options_http_tokens is optional', () => {
    const r = makeEC2({
      configuration: { monthlyCost: 100, metadata_options_http_tokens: 'optional' },
    });
    const rec = checkEC2012(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('EC2-012');
    expect(rec!.impact).toBe('high');
    expect(rec!.estimatedSavings).toBe(0);
    expect(rec!.suggestedConfig!.metadata_options_http_tokens).toBe('required');
  });

  it('fires for any non-required value including empty string', () => {
    expect(checkEC2012(makeEC2({ configuration: { metadata_options_http_tokens: '' } }), cfg)).not.toBeNull();
  });

  it('does not fire when http_tokens=required, key absent, or wrong type', () => {
    expect(checkEC2012(makeEC2({ configuration: { metadata_options_http_tokens: 'required' } }), cfg)).toBeNull();
    // key not in configuration
    expect(checkEC2012(makeEC2({ configuration: { monthlyCost: 100 } }), cfg)).toBeNull();
    expect(checkEC2012(makeEC2({ type: 'rds_instance', configuration: { metadata_options_http_tokens: 'optional' } }), cfg)).toBeNull();
  });
});

// ─── EC2-013: Running > 1 year ────────────────────────────────────────────────

describe('checkEC2013 — instance running more than 1 year', () => {
  it('fires for running instance older than 365 days', () => {
    const r = makeEC2({
      state: 'running',
      launchTime: new Date(Date.now() - 400 * 86_400_000).toISOString(),
      configuration: { monthlyCost: 150 },
    });
    const rec = checkEC2013(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('EC2-013');
    expect(rec!.impact).toBe('low');
    expect(rec!.estimatedSavings).toBe(0);
    expect(rec!.currentConfig!.state).toBe('running');
    expect((rec!.currentConfig!.age_days as number)).toBeGreaterThan(365);
  });

  it('does not fire when running < 365 days, stopped, missing launchTime, or wrong type', () => {
    expect(checkEC2013(makeEC2({
      state: 'running',
      launchTime: new Date(Date.now() - 100 * 86_400_000).toISOString(),
    }), cfg)).toBeNull();
    expect(checkEC2013(makeEC2({
      state: 'stopped',
      launchTime: new Date(Date.now() - 400 * 86_400_000).toISOString(),
    }), cfg)).toBeNull();
    expect(checkEC2013(makeEC2({ state: 'running', launchTime: '' }), cfg)).toBeNull();
    expect(checkEC2013(makeEC2({ type: 'rds_instance', state: 'running', launchTime: new Date(Date.now() - 400 * 86_400_000).toISOString() }), cfg)).toBeNull();
  });
});

// ─── suggestPrefixedRightsize — early-return when already at minimum size ─────

describe('suggestRDSRightsize / suggestCacheRightsize — early-return at minimum size', () => {
  it('returns the original class unchanged when the instance is already the smallest size', () => {
    // db.t3.nano is the smallest in the order; suggestRightsize returns "t3.nano" unchanged
    // so suggestPrefixedRightsize returns the original "db.t3.nano"
    const result = suggestRDSRightsize('db.t3.nano', 5, cfg.rdsRightsizeCPUThreshold);
    expect(result).toBe('db.t3.nano');
  });

  it('returns the original type unchanged for cache prefix when already minimum size', () => {
    const result = suggestCacheRightsize('cache.t3.nano', 5, cfg.rdsRightsizeCPUThreshold);
    expect(result).toBe('cache.t3.nano');
  });

  it('returns a smaller class when the instance is not at minimum size', () => {
    const result = suggestRDSRightsize('db.m5.large', 5, cfg.rdsRightsizeCPUThreshold);
    expect(result).not.toBe('db.m5.large');
    expect(result.startsWith('db.')).toBe(true);
  });
});
