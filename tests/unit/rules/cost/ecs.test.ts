import { describe, it, expect } from 'vitest';
import { checkECS001, checkECS002, checkECS003, checkECS004 } from '../../../../src/rules/cost/ecs.js';
import { THRESHOLDS } from '../../../../src/rules/config.js';
import type { Resource } from '../../../../src/aws/types.js';

const cfg = THRESHOLDS;

function makeECSService(overrides: Partial<Resource> = {}): Resource {
  return {
    id: 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
    arn: 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service',
    type: 'ecs_service',
    name: 'my-service',
    region: 'us-east-1',
    state: 'active',
    instanceType: '',
    tags: { Environment: 'production', Team: 'platform', Project: 'korinfra' },
    launchTime: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    collectedAt: new Date().toISOString(),
    configuration: { launch_type: 'FARGATE', desired_count: 2, running_count: 2, cpu: '256', memory: '512', monthlyCost: 200 },
    ...overrides,
  };
}

function makeUtil(cpuAverage: number, period: '7d' | '14d' | '30d' = '14d') {
  return {
    period,
    cpuAverage,
    cpuMax: cpuAverage * 1.5,
    cpuP95: cpuAverage * 1.3,
    cpuP99: cpuAverage * 1.4,
    memoryAverage: 40, memoryMax: 55, memoryP95: 50,
    networkInMB: 500, networkOutMB: 250,
    diskReadIOPS: 0, diskWriteIOPS: 0,
    connectionCount: 0, connectionCountMax: 0,
    dataPoints: 336, dataGaps: 0, freshnessHrs: 1,
  };
}

// ─── ECS-001: Idle service ─────────────────────────────────────────────────────

describe('checkECS001 — idle ECS service', () => {
  it('fires when desired > 0 but running = 0 with correct fields and full savings', () => {
    const r = makeECSService({ name: 'payment-processor', configuration: { launch_type: 'FARGATE', desired_count: 1, running_count: 0, cpu: '256', memory: '512', monthlyCost: 120 } });
    const rec = checkECS001(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('ECS-001');
    expect(rec!.impact).toBe('medium');
    expect(rec!.risk).toBe('low');
    expect(rec!.suggestedAction).toBe('set_desired_count_zero');
    expect(rec!.confidence).toBe(0.85);
    expect(rec!.estimatedSavings).toBe(120);
    expect(rec!.title).toContain('payment-processor');
    expect(rec!.description).toContain('payment-processor');

    // desired count in configs
    const r2 = makeECSService({ configuration: { launch_type: 'FARGATE', desired_count: 3, running_count: 0, monthlyCost: 150 } });
    expect(checkECS001(r2, cfg)!.currentConfig).toMatchObject({ desired_count: 3, running_count: 0 });
    expect(checkECS001(r2, cfg)!.suggestedConfig).toMatchObject({ desired_count: 0 });
  });

  it('does not fire when running, already stopped, too new, or wrong type', () => {
    expect(checkECS001(makeECSService({ configuration: { launch_type: 'FARGATE', desired_count: 2, running_count: 2, monthlyCost: 100 } }), cfg)).toBeNull();
    expect(checkECS001(makeECSService({ configuration: { launch_type: 'FARGATE', desired_count: 0, running_count: 0, monthlyCost: 0 } }), cfg)).toBeNull();
    expect(checkECS001(makeECSService({ launchTime: new Date(Date.now() - 1 * 86_400_000).toISOString(), configuration: { launch_type: 'FARGATE', desired_count: 2, running_count: 0, monthlyCost: 100 } }), cfg)).toBeNull();
    expect(checkECS001(makeECSService({ type: 'ec2_instance', configuration: { desired_count: 2, running_count: 0, monthlyCost: 100 } }), cfg)).toBeNull();
  });
});

// ─── ECS-002: EC2 launch type ────────────────────────────────────────────────

describe('checkECS002 — EC2 launch type', () => {
  it('fires for EC2 launch type with 30% savings and Fargate suggestion', () => {
    const r = makeECSService({ configuration: { launch_type: 'EC2', desired_count: 4, running_count: 4, cpu: '1024', memory: '2048', monthlyCost: 500 } });
    const rec = checkECS002(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('ECS-002');
    // Savings = ec2Cost − fargateMonthlyCost. With cpu=1024 (1 vCPU), memory=2048 (2 GB),
    // desired_count=4: fargate = (1*0.04048 + 2*0.004445)*730*4 ≈ 144.16 → savings ≈ 355.84
    expect(rec!.estimatedSavings).toBeCloseTo(355.84, 0);
    expect(rec!.suggestedAction).toBe('migrate_to_fargate');
    expect(rec!.confidence).toBe(0.7);
    expect(rec!.currentConfig).toMatchObject({ launch_type: 'EC2' });
    expect(rec!.suggestedConfig).toMatchObject({ launch_type: 'FARGATE' });
    expect(rec!.implementationSteps.some((s) => s.includes('FARGATE'))).toBe(true);

    // $0 cost still fires
    expect(checkECS002(makeECSService({ configuration: { launch_type: 'EC2', desired_count: 2, running_count: 2, monthlyCost: 0 } }), cfg)!.estimatedSavings).toBe(0);
  });

  it('does not fire for FARGATE, EXTERNAL, or wrong type', () => {
    expect(checkECS002(makeECSService({ configuration: { launch_type: 'FARGATE', desired_count: 2, running_count: 2, monthlyCost: 300 } }), cfg)).toBeNull();
    expect(checkECS002(makeECSService({ configuration: { launch_type: 'EXTERNAL', desired_count: 2, running_count: 2, monthlyCost: 200 } }), cfg)).toBeNull();
    expect(checkECS002(makeECSService({ type: 'rds_instance', configuration: { launch_type: 'EC2', monthlyCost: 300 } }), cfg)).toBeNull();
  });
});

// ─── ECS-003: Over-provisioned service ───────────────────────────────────────

describe('checkECS003 — over-provisioned ECS service', () => {
  it('fires when CPU < 20% and desired_count >= 3, with 30% savings and halved count', () => {
    const r = makeECSService({ utilization: makeUtil(8.0), configuration: { launch_type: 'FARGATE', desired_count: 6, running_count: 6, cpu: '4096', memory: '8192', monthlyCost: 800 } });
    const rec = checkECS003(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('ECS-003');
    expect(rec!.impact).toBe('medium');
    expect(rec!.estimatedSavings).toBeCloseTo(240);

    // halves desired_count
    const r2 = makeECSService({ utilization: makeUtil(5.0), configuration: { launch_type: 'FARGATE', desired_count: 8, running_count: 8, monthlyCost: 600 } });
    expect(checkECS003(r2, cfg)!.suggestedConfig).toMatchObject({ desired_count: 4 });

    // minimum 1 when desired = 3
    const r3 = makeECSService({ utilization: makeUtil(3.0), configuration: { launch_type: 'FARGATE', desired_count: 3, running_count: 3, monthlyCost: 200 } });
    expect(checkECS003(r3, cfg)!.suggestedConfig).toMatchObject({ desired_count: 1 });

    // currentConfig includes cpu_avg_pct
    const r4 = makeECSService({ utilization: makeUtil(7.5), configuration: { launch_type: 'FARGATE', desired_count: 4, running_count: 4, cpu: '4096', memory: '8192', monthlyCost: 577 } });
    expect(checkECS003(r4, cfg)!.currentConfig).toMatchObject({ desired_count: 4, cpu_avg_pct: 7.5 });
  });

  it('does not fire when CPU >= 20%, desired_count < 3, no utilization, or wrong type', () => {
    expect(checkECS003(makeECSService({ utilization: makeUtil(25.0), configuration: { launch_type: 'FARGATE', desired_count: 4, running_count: 4, monthlyCost: 500 } }), cfg)).toBeNull();
    expect(checkECS003(makeECSService({ utilization: makeUtil(5.0), configuration: { launch_type: 'FARGATE', desired_count: 2, running_count: 2, monthlyCost: 200 } }), cfg)).toBeNull();
    expect(checkECS003(makeECSService({ configuration: { launch_type: 'FARGATE', desired_count: 5, running_count: 5, monthlyCost: 400 } }), cfg)).toBeNull();
    expect(checkECS003(makeECSService({ type: 'lambda_function', utilization: makeUtil(5.0), configuration: { desired_count: 5, monthlyCost: 400 } }), cfg)).toBeNull();
  });
});

// ─── ECS-004: Degraded service ─────────────────────────────────────────────────

describe('checkECS004 — degraded ECS service', () => {
  it('fires when running < desired with no pending tasks after degradedDays', () => {
    const r = makeECSService({
      configuration: { launch_type: 'FARGATE', desired_count: 4, running_count: 2, pending_count: 0, monthlyCost: 400 },
    });
    const rec = checkECS004(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('ECS-004');
    expect(rec!.impact).toBe('high');
    expect(rec!.risk).toBe('low');
    expect(rec!.confidence).toBe(0.9);
    expect(rec!.estimatedSavings).toBe(0);
    expect(rec!.suggestedAction).toBe('investigate_task_failures');
    expect(rec!.title).toContain('2/4 tasks running');
    expect(rec!.description).toContain('2 running tasks but desired_count=4');
    expect(rec!.currentConfig).toMatchObject({ desired_count: 4, running_count: 2, pending_count: 0 });
    expect(rec!.implementationSteps.some((s) => s.includes('describe-services'))).toBe(true);
  });

  it('does not fire when fully running, fully stopped, tasks are pending, too new, or wrong type', () => {
    // fully running — healthy
    expect(checkECS004(makeECSService({ configuration: { launch_type: 'FARGATE', desired_count: 4, running_count: 4, pending_count: 0, monthlyCost: 400 } }), cfg)).toBeNull();
    // zero running — covered by ECS-001 instead
    expect(checkECS004(makeECSService({ configuration: { launch_type: 'FARGATE', desired_count: 4, running_count: 0, pending_count: 0, monthlyCost: 400 } }), cfg)).toBeNull();
    // desired = 0 — already stopped
    expect(checkECS004(makeECSService({ configuration: { launch_type: 'FARGATE', desired_count: 0, running_count: 0, pending_count: 0, monthlyCost: 0 } }), cfg)).toBeNull();
    // tasks are pending — still launching, wait for stability
    expect(checkECS004(makeECSService({ configuration: { launch_type: 'FARGATE', desired_count: 4, running_count: 2, pending_count: 2, monthlyCost: 400 } }), cfg)).toBeNull();
    // too new (less than ecsDegradedDays = 1 day)
    expect(checkECS004(makeECSService({ launchTime: new Date(Date.now() - 3_600_000).toISOString(), configuration: { launch_type: 'FARGATE', desired_count: 4, running_count: 2, pending_count: 0, monthlyCost: 400 } }), cfg)).toBeNull();
    // wrong resource type
    expect(checkECS004(makeECSService({ type: 'ecs_cluster', configuration: { desired_count: 4, running_count: 2, pending_count: 0, monthlyCost: 400 } }), cfg)).toBeNull();
  });
});
