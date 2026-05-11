import { describe, it, expect } from 'vitest';
import { checkELC001, checkELC002, checkELC003 } from '../../../../src/rules/cost/elasticache.js';
import { THRESHOLDS } from '../../../../src/rules/config.js';
import type { Resource } from '../../../../src/aws/types.js';

const cfg = THRESHOLDS;

function makeElastiCache(overrides: Partial<Resource> = {}): Resource {
  return {
    id: 'my-redis-cluster',
    arn: 'arn:aws:elasticache:us-east-1:123456789012:cluster:my-redis-cluster',
    type: 'elasticache_cluster',
    name: 'my-redis-cluster',
    region: 'us-east-1',
    state: 'available',
    instanceType: 'cache.r6g.large',
    tags: { Environment: 'production', Team: 'platform', Project: 'korinfra' },
    launchTime: new Date(Date.now() - 60 * 86_400_000).toISOString(),
    collectedAt: new Date().toISOString(),
    configuration: { engine: 'redis', engine_version: '7.0.7', num_cache_nodes: 1, monthlyCost: 152.57 },
    ...overrides,
  };
}

function makeUtil(cpuAverage: number, memoryAverage: number, period: '7d' | '14d' | '30d' = '14d') {
  return {
    period,
    cpuAverage,
    cpuMax: cpuAverage * 1.5,
    cpuP95: cpuAverage * 1.3,
    cpuP99: cpuAverage * 1.4,
    memoryAverage,
    memoryMax: memoryAverage * 1.2,
    memoryP95: memoryAverage * 1.1,
    networkInMB: 50, networkOutMB: 30,
    diskReadIOPS: 0, diskWriteIOPS: 0,
    connectionCount: 10, connectionCountMax: 20,
    dataPoints: 288, dataGaps: 0, freshnessHrs: 1,
  };
}

// ─── ELC-001: Overprovisioned cluster ─────────────────────────────────────────

describe('checkELC001 — overprovisioned ElastiCache', () => {
  it('fires when memory utilization < 10% and smaller node available, with 40% savings', () => {
    const r = makeElastiCache({ instanceType: 'cache.r6g.large', utilization: makeUtil(5, 4.0), configuration: { engine: 'redis', num_cache_nodes: 1, monthlyCost: 152.57 } });
    const rec = checkELC001(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('ELC-001');
    expect(rec!.impact).toBe('medium');
    expect(rec!.estimatedSavings).toBeCloseTo(152.57 * 0.5);

    const r2 = makeElastiCache({ instanceType: 'cache.m5.xlarge', utilization: makeUtil(4, 3.0), configuration: { engine: 'memcached', num_cache_nodes: 2, monthlyCost: 185.42 } });
    expect(checkELC001(r2, cfg)!.currentConfig).toMatchObject({ node_type: 'cache.m5.xlarge' });
    expect(checkELC001(r2, cfg)!.suggestedConfig.node_type).toContain('cache.m5');
  });

  it('does not fire when memory >= 10%, no utilization, wrong type, or already smallest node', () => {
    expect(checkELC001(makeElastiCache({ instanceType: 'cache.r6g.large', utilization: makeUtil(15, 12.0), configuration: { monthlyCost: 152.57 } }), cfg)).toBeNull();
    expect(checkELC001(makeElastiCache({ instanceType: 'cache.r6g.large', configuration: { monthlyCost: 152.57 } }), cfg)).toBeNull();
    expect(checkELC001(makeElastiCache({ type: 'rds_instance', instanceType: 'cache.r6g.large', utilization: makeUtil(3, 2.0), configuration: { monthlyCost: 152.57 } }), cfg)).toBeNull();
    expect(checkELC001(makeElastiCache({ instanceType: 'cache.t3.nano', utilization: makeUtil(2, 3.0), configuration: { engine: 'redis', monthlyCost: 12.41 } }), cfg)).toBeNull();
  });
});

// ─── ELC-002: Previous-generation node ───────────────────────────────────────

describe('checkELC002 — previous-gen ElastiCache node type', () => {
  it('fires for r5/m5/t3 families and suggests Graviton equivalent with 5% savings', () => {
    // r5 → r7g
    const r1 = makeElastiCache({ instanceType: 'cache.r5.large', configuration: { engine: 'redis', monthlyCost: 180 } });
    const rec1 = checkELC002(r1, cfg);
    expect(rec1).not.toBeNull();
    expect(rec1!.ruleId).toBe('ELC-002');
    expect(rec1!.suggestedConfig).toMatchObject({ node_type: 'cache.r7g.large' });
    expect(rec1!.estimatedSavings).toBeCloseTo(9);

    // m5 → m7g
    const r2 = makeElastiCache({ instanceType: 'cache.m5.xlarge', configuration: { engine: 'redis', monthlyCost: 185.42 } });
    expect(checkELC002(r2, cfg)!.suggestedConfig).toMatchObject({ node_type: 'cache.m7g.xlarge' });
    expect(checkELC002(r2, cfg)!.confidence).toBe(0.8);

    // t3 → t4g
    const r3 = makeElastiCache({ instanceType: 'cache.t3.micro', configuration: { engine: 'redis', monthlyCost: 12.41 } });
    expect(checkELC002(r3, cfg)!.suggestedConfig).toMatchObject({ node_type: 'cache.t4g.micro' });

    // multi-node — savings on total cost
    const r4 = makeElastiCache({ instanceType: 'cache.r5.large', configuration: { engine: 'redis', num_cache_nodes: 3, monthlyCost: 540 } });
    expect(checkELC002(r4, cfg)!.estimatedSavings).toBeCloseTo(27);
  });

  it('does not fire for Graviton types, empty instanceType, or wrong resource type', () => {
    expect(checkELC002(makeElastiCache({ instanceType: 'cache.r7g.large', configuration: { engine: 'redis', monthlyCost: 153 } }), cfg)).toBeNull();
    expect(checkELC002(makeElastiCache({ instanceType: 'cache.t4g.micro', configuration: { monthlyCost: 10.51 } }), cfg)).toBeNull();
    expect(checkELC002(makeElastiCache({ instanceType: '', configuration: { monthlyCost: 100 } }), cfg)).toBeNull();
    expect(checkELC002(makeElastiCache({ type: 'ec2_instance', instanceType: 'cache.m5.large', configuration: { monthlyCost: 130 } }), cfg)).toBeNull();
  });
});

// ─── ELC-003: Idle cluster ─────────────────────────────────────────────────────

describe('checkELC003 — idle ElastiCache cluster', () => {
  it('fires when CPU < 2% AND memory < 5% with 90% savings and correct fields', () => {
    const r = makeElastiCache({ instanceType: 'cache.t3.micro', utilization: makeUtil(0.5, 1.2), configuration: { engine: 'redis', num_cache_nodes: 1, monthlyCost: 12.41 } });
    const rec = checkELC003(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('ELC-003');
    expect(rec!.impact).toBe('high');
    expect(rec!.suggestedAction).toBe('delete');
    expect(rec!.confidence).toBe(0.85);
    expect(rec!.estimatedSavings).toBeCloseTo(11.17, 1);
    expect(rec!.currentConfig).toMatchObject({ node_type: 'cache.t3.micro' });

    // title includes cluster name and utilization percentages
    const r2 = makeElastiCache({ name: 'session-cache', instanceType: 'cache.m5.xlarge', utilization: makeUtil(1.0, 2.5), configuration: { engine: 'memcached', num_cache_nodes: 2, monthlyCost: 370 } });
    const rec2 = checkELC003(r2, cfg);
    expect(rec2!.title).toContain('session-cache');
    expect(rec2!.title).toContain('1.0%');
    expect(rec2!.title).toContain('2.5%');
  });

  it('does not fire when CPU >= 2%, memory >= 5%, no utilization, or wrong type', () => {
    expect(checkELC003(makeElastiCache({ instanceType: 'cache.t3.micro', utilization: makeUtil(2.5, 1.0), configuration: { monthlyCost: 12.41 } }), cfg)).toBeNull();
    expect(checkELC003(makeElastiCache({ instanceType: 'cache.t3.micro', utilization: makeUtil(0.5, 6.0), configuration: { monthlyCost: 12.41 } }), cfg)).toBeNull();
    expect(checkELC003(makeElastiCache({ instanceType: 'cache.r6g.large', configuration: { monthlyCost: 152 } }), cfg)).toBeNull();
    expect(checkELC003(makeElastiCache({ type: 'rds_instance', instanceType: 'cache.r6g.large', utilization: makeUtil(0.1, 0.5), configuration: { monthlyCost: 152 } }), cfg)).toBeNull();
  });
});
