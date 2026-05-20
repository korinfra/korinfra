import { describe, it, expect } from 'vitest';
import { checkELB001, checkLB002, checkELB002, checkELB003 } from '../../../../src/rules/cost/elb.js';
import { THRESHOLDS } from '../../../../src/rules/config.js';
import type { Resource } from '../../../../src/aws/types.js';

const cfg = THRESHOLDS;

function makeALB(overrides: Partial<Resource> = {}): Resource {
  const oldLaunch = new Date(Date.now() - 14 * 86_400_000).toISOString();
  return {
    id: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/abc123',
    arn: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/abc123',
    type: 'load_balancer',
    name: 'my-alb',
    region: 'us-east-1',
    state: 'active',
    instanceType: '',
    tags: { Environment: 'staging' },
    launchTime: oldLaunch,
    collectedAt: new Date().toISOString(),
    configuration: {},
    ...overrides,
  };
}

function makeUtil(networkInMB: number) {
  return {
    period: '7d' as const,
    cpuAverage: 0, cpuMax: 0, cpuP95: 0, cpuP99: 0,
    memoryAverage: 0, memoryMax: 0, memoryP95: 0,
    networkInMB, networkOutMB: 0,
    diskReadIOPS: 0, diskWriteIOPS: 0,
    connectionCount: 0, connectionCountMax: 0,
    dataPoints: 100, dataGaps: 0, freshnessHrs: 1,
  };
}

// ─── ELB-001: No healthy targets ──────────────────────────────────────────────

describe('checkELB001 — load balancer with 0 healthy targets', () => {
  it('fires when healthy_target_count = 0 and LB is old enough with correct fields', () => {
    const r = makeALB({ configuration: { healthy_target_count: 0, lb_type: 'application', monthlyCost: 18 } });
    const rec = checkELB001(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('ELB-001');
    expect(rec!.suggestedAction).toBe('delete');

    // NLB and ALB types also fire
    expect(checkELB001(makeALB({ type: 'nlb', configuration: { healthy_target_count: 0, lb_type: 'network', monthlyCost: 16 } }), cfg)).not.toBeNull();
    expect(checkELB001(makeALB({ type: 'alb', configuration: { healthy_target_count: 0, monthlyCost: 17 } }), cfg)).not.toBeNull();
  });

  it('does not fire when targets present, LB too new, no target data, or wrong type', () => {
    expect(checkELB001(makeALB({ configuration: { healthy_target_count: 5, monthlyCost: 25 } }), cfg)).toBeNull();
    expect(checkELB001(makeALB({ configuration: { healthy_target_count: 1, monthlyCost: 20 } }), cfg)).toBeNull();
    const newLaunch = new Date(Date.now() - 3 * 86_400_000).toISOString();
    expect(checkELB001(makeALB({ launchTime: newLaunch, configuration: { healthy_target_count: 0, monthlyCost: 18 } }), cfg)).toBeNull();
    expect(checkELB001(makeALB({ configuration: { lb_type: 'application', monthlyCost: 18 } }), cfg)).toBeNull();
    expect(checkELB001(makeALB({ type: 'ec2_instance', configuration: { healthy_target_count: 0 } }), cfg)).toBeNull();
  });
});

// ─── LB-002: Idle load balancer ──────────────────────────────────────────────

describe('checkLB002 — idle load balancer with negligible traffic', () => {
  it('fires for near-zero traffic with monthlyCost provided (post-#44: strict cost gating)', () => {
    expect(checkLB002(makeALB({ configuration: { lb_type: 'application', monthlyCost: 18 }, utilization: makeUtil(0.05) }), cfg)).not.toBeNull();
    expect(checkLB002(makeALB({ configuration: { lb_type: 'application', monthlyCost: 18 }, utilization: makeUtil(0) }), cfg)).not.toBeNull();
    // NLB also fires
    expect(checkLB002(makeALB({ type: 'nlb', configuration: { lb_type: 'network', monthlyCost: 16 }, utilization: makeUtil(0) }), cfg)).not.toBeNull();
  });

  it('skips and warns when monthlyCost is missing (#44 Item 2 — replaces ALB_BASE_HOURLY fallback)', () => {
    // Pre-#44 the rule fell back to ALB_BASE_HOURLY * HOURS_PER_MONTH = $16.425/mo when monthlyCost
    // was absent. Post-#44 the rule strict-skips because the fixed rate is misleading for NLBs
    // ($0.006/hr base) and LCU-heavy ALBs (which exceed the $16/mo base by 3x or more).
    const warnings: Array<{ ruleId: string; resourceId: string; resourceType: string; reason: string }> = [];
    const ctx = {
      warn(ruleId: string, resourceId: string, resourceType: string, reason: string) {
        warnings.push({ ruleId, resourceId, resourceType, reason });
      },
    };
    const noMonthlyCost = makeALB({ configuration: { lb_type: 'application' }, utilization: makeUtil(0) });
    expect(checkLB002(noMonthlyCost, cfg, ctx)).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      ruleId: 'LB-002',
      resourceId: noMonthlyCost.id,
      reason: 'monthly_cost missing or invalid',
    });
  });

  it('does not fire when traffic exceeds threshold, wrong period, zero healthy targets, or classic LB', () => {
    expect(checkLB002(makeALB({ configuration: { lb_type: 'application', monthlyCost: 30 }, utilization: makeUtil(0.5) }), cfg)).toBeNull();
    expect(checkLB002(makeALB({ configuration: { lb_type: 'application', monthlyCost: 50 }, utilization: makeUtil(100) }), cfg)).toBeNull();
    expect(checkLB002(makeALB({ configuration: { healthy_target_count: 0, lb_type: 'application', monthlyCost: 18 }, utilization: makeUtil(0) }), cfg)).toBeNull();
    expect(checkLB002(makeALB({ type: 'classic_load_balancer', configuration: { monthlyCost: 18 }, utilization: makeUtil(0) }), cfg)).toBeNull();
    const highTraffic = makeALB({ configuration: { lb_type: 'application', monthlyCost: 18 }, utilization: { ...makeUtil(0.2), period: '7d' } });
    expect(checkLB002(highTraffic, cfg)).toBeNull();
  });
});

// ─── ELB-003: HTTP-only ALB ────────────────────────────────────────────────────

describe('checkELB003 — ALB without HTTPS listener', () => {
  it('fires for ALB/alb type without HTTPS with correct fields', () => {
    const r = makeALB({ type: 'load_balancer', configuration: { lb_type: 'application', has_https_listener: false } });
    const rec = checkELB003(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('ELB-003');
    expect(rec!.suggestedAction).toBe('add_https_listener');
    expect(rec!.estimatedSavings).toBe(0);
    expect(rec!.impact).toBe('high');

    // alb type and empty lb_type also fire
    expect(checkELB003(makeALB({ type: 'alb', configuration: { lb_type: 'application', has_https_listener: false } }), cfg)).not.toBeNull();
    expect(checkELB003(makeALB({ type: 'load_balancer', configuration: { lb_type: '', has_https_listener: false } }), cfg)).not.toBeNull();
  });

  it('does not fire when HTTPS is present, absent, NLB, classic, or gateway', () => {
    expect(checkELB003(makeALB({ configuration: { lb_type: 'application', has_https_listener: true } }), cfg)).toBeNull();
    expect(checkELB003(makeALB({ configuration: { lb_type: 'application' } }), cfg)).toBeNull();
    expect(checkELB003(makeALB({ type: 'nlb', configuration: { lb_type: 'network', has_https_listener: false } }), cfg)).toBeNull();
    expect(checkELB003(makeALB({ type: 'classic_load_balancer', configuration: { lb_type: 'classic', has_https_listener: false } }), cfg)).toBeNull();
    expect(checkELB003(makeALB({ configuration: { lb_type: 'gateway', has_https_listener: false } }), cfg)).toBeNull();
  });
});

// ─── ELB-002: Classic Load Balancer migration ──────────────────────────────────

describe('checkELB002 — Classic Load Balancer migration', () => {
  it('fires for classic_load_balancer type with migration to ALB suggestion', () => {
    const r = makeALB({
      type: 'classic_load_balancer',
      configuration: { monthlyCost: 25 },
    });
    const rec = checkELB002(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('ELB-002');
    expect(rec!.suggestedAction).toBe('migrate_to_alb');
    expect(rec!.impact).toBe('medium');
    expect(rec!.risk).toBe('medium');
    expect(rec!.confidence).toBe(0.85);
    // elbClassicToALBMultiplier is 0.10 (10% savings)
    expect(rec!.estimatedSavings).toBeCloseTo(2.5, 1);
  });

  it('does not fire for ALB, NLB, or load_balancer type', () => {
    expect(checkELB002(makeALB({ type: 'alb', configuration: { monthlyCost: 25 } }), cfg)).toBeNull();
    expect(checkELB002(makeALB({ type: 'nlb', configuration: { monthlyCost: 25 } }), cfg)).toBeNull();
    expect(checkELB002(makeALB({ type: 'load_balancer', configuration: { monthlyCost: 25 } }), cfg)).toBeNull();
  });
});
