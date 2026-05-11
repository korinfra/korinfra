import { describe, it, expect } from 'vitest';
import {
  suggestSmallerInstance,
  suggestSmallerRDS,
  suggestGravitonEquivalent,
  analyzeRightsizing,
  instanceSizeOrder,
} from '../../../src/classifier/rightsize.js';
import { THRESHOLDS } from '../../../src/rules/config.js';
import type { Resource } from '../../../src/aws/types.js';

// ─── suggestSmallerInstance ───────────────────────────────────────────────────

describe('suggestSmallerInstance', () => {
  it('steps down one or two sizes, preserves family', () => {
    expect(suggestSmallerInstance('t3.large')).toBe('t3.medium');
    expect(suggestSmallerInstance('t3.xlarge', 2)).toBe('t3.medium');
    expect(suggestSmallerInstance('m5.xlarge')).toBe('m5.large');
    expect(suggestSmallerInstance('m6i.2xlarge')).toBe('m6i.xlarge');
    expect(suggestSmallerInstance('c5.4xlarge')).toBe('c5.2xlarge');
  });

  it('clamps to nano and returns null when already at smallest', () => {
    expect(suggestSmallerInstance('t3.nano')).toBeNull();
    expect(suggestSmallerInstance('t3.micro')).toBe('t3.nano');
    expect(suggestSmallerInstance('t3.small', 10)).toBe('t3.nano');
  });

  it('returns null for unparseable or unknown types', () => {
    expect(suggestSmallerInstance('t3large')).toBeNull();
    expect(suggestSmallerInstance('t3.huge')).toBeNull();
  });
});

// ─── suggestSmallerRDS ────────────────────────────────────────────────────────

describe('suggestSmallerRDS', () => {
  it('steps down RDS instance classes', () => {
    expect(suggestSmallerRDS('db.m5.large')).toBe('db.m5.medium');
    expect(suggestSmallerRDS('db.r5.xlarge')).toBe('db.r5.large');
    expect(suggestSmallerRDS('db.t3.micro')).toBe('db.t3.nano');
    expect(suggestSmallerRDS('db.m5.xlarge', 2)).toBe('db.m5.medium');
  });

  it('returns null at smallest or missing db. prefix', () => {
    expect(suggestSmallerRDS('db.t3.nano')).toBeNull();
    expect(suggestSmallerRDS('m5.large')).toBeNull();
  });
});

// ─── suggestGravitonEquivalent ────────────────────────────────────────────────

describe('suggestGravitonEquivalent', () => {
  it('maps x86 families to Graviton equivalents', () => {
    expect(suggestGravitonEquivalent('m5.large')).toBe('m6g.large');
    expect(suggestGravitonEquivalent('m5.xlarge')).toBe('m6g.xlarge');
    expect(suggestGravitonEquivalent('c5.large')).toBe('c6g.large');
    expect(suggestGravitonEquivalent('c5.2xlarge')).toBe('c6g.2xlarge');
    expect(suggestGravitonEquivalent('t3.medium')).toBe('t4g.medium');
    expect(suggestGravitonEquivalent('r5.large')).toBe('r6g.large');
    expect(suggestGravitonEquivalent('db.m5.large')).toBe('db.m6g.large');
  });

  it('returns null for unknown, already-Graviton, or unparseable types', () => {
    expect(suggestGravitonEquivalent('p4d.24xlarge')).toBeNull();
    expect(suggestGravitonEquivalent('m6g.large')).toBeNull();
    expect(suggestGravitonEquivalent('t3large')).toBeNull();
  });
});

// ─── instanceSizeOrder ────────────────────────────────────────────────────────

describe('instanceSizeOrder', () => {
  it('is ordered from nano to 48xlarge with expected entries', () => {
    expect(instanceSizeOrder[0]).toBe('nano');
    expect(instanceSizeOrder[instanceSizeOrder.length - 1]).toBe('48xlarge');
    expect(instanceSizeOrder).toContain('medium');
    const largeIdx = instanceSizeOrder.indexOf('large');
    const xlargeIdx = instanceSizeOrder.indexOf('xlarge');
    expect(largeIdx).toBeLessThan(xlargeIdx);
  });
});

// ─── suggestGravitonEquivalent — RDS additional coverage ─────────────────────

describe('suggestGravitonEquivalent — additional RDS families', () => {
  it('maps db.r5.large to db.r6g.large', () => {
    expect(suggestGravitonEquivalent('db.r5.large')).toBe('db.r6g.large');
  });

  it('maps db.t3.medium to db.t4g.medium', () => {
    expect(suggestGravitonEquivalent('db.t3.medium')).toBe('db.t4g.medium');
  });

  it('maps db.m5.xlarge to db.m6g.xlarge', () => {
    expect(suggestGravitonEquivalent('db.m5.xlarge')).toBe('db.m6g.xlarge');
  });
});

// ─── suggestSmallerInstance — steps=0 edge case ───────────────────────────────

describe('suggestSmallerInstance — steps=0 edge case', () => {
  it('returns null when steps=0', () => {
    expect(suggestSmallerInstance('t3.large', 0)).toBeNull();
  });
});

// ─── analyzeRightsizing ───────────────────────────────────────────────────────

function makeEC2Resource(overrides: Partial<Resource> = {}): Resource {
  return {
    id: 'i-test123',
    arn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-test123',
    type: 'ec2_instance',
    name: 'test-instance',
    region: 'us-east-1',
    state: 'running',
    instanceType: 'm5.xlarge',
    tags: {},
    launchTime: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    collectedAt: new Date().toISOString(),
    configuration: { monthlyCost: 100 },
    ...overrides,
  };
}

function makeUtilization(cpuAverage: number, cpuP95: number, dataPoints = 200) {
  return {
    period: '7d' as const,
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
    dataPoints,
    dataGaps: 0,
    freshnessHrs: 1,
  };
}

describe('analyzeRightsizing', () => {
  it('returns a rightsize recommendation for EC2 with CPU avg < 10% (underutilized)', () => {
    const resource = makeEC2Resource({
      instanceType: 'm5.xlarge',
      utilization: makeUtilization(8, 15),
      configuration: { monthlyCost: 100 },
    });
    const recs = analyzeRightsizing([resource]);
    expect(recs.length).toBe(1);
    const rec = recs[0]!;
    expect(rec.resourceId).toBe('i-test123');
    expect(rec.resourceType).toBe('ec2_instance');
    expect(rec.type).toBe('rightsize');
    expect(rec.scenario).toBe('B');
    // m5.xlarge underutilized (1 step down) → m5.large
    expect(rec.suggestedConfig?.instance_type).toBe('m5.large');
    expect(rec.currentConfig?.instance_type).toBe('m5.xlarge');
    expect(rec.estimatedSavings).toBeCloseTo(100 * THRESHOLDS.rdsRightsizeMultiplier, 2);
  });

  it('returns a rightsize recommendation for EC2 with CPU avg < 5% (idle, 2-step drop)', () => {
    const resource = makeEC2Resource({
      instanceType: 'm5.2xlarge',
      utilization: makeUtilization(2, 4),
      configuration: { monthlyCost: 200 },
    });
    const recs = analyzeRightsizing([resource]);
    expect(recs.length).toBe(1);
    const rec = recs[0]!;
    // m5.2xlarge idle (2 steps down) → m5.large
    expect(rec.suggestedConfig?.instance_type).toBe('m5.large');
    expect(rec.estimatedSavings).toBeCloseTo(200 * THRESHOLDS.ec2RightsizeMultiplier, 2);
    expect(rec.confidence).toBeCloseTo(0.9);
  });

  it('returns null (no recommendation) for EC2 with CPU > 80%', () => {
    const resource = makeEC2Resource({
      instanceType: 'm5.xlarge',
      utilization: makeUtilization(85, 90),
      configuration: { monthlyCost: 100 },
    });
    const recs = analyzeRightsizing([resource]);
    expect(recs).toHaveLength(0);
  });

  it('returns empty array when no utilization data is provided', () => {
    const resource = makeEC2Resource({ utilization: undefined });
    expect(analyzeRightsizing([resource])).toHaveLength(0);
  });

  it('returns empty array when dataPoints < minDataPoints threshold', () => {
    const resource = makeEC2Resource({
      utilization: makeUtilization(2, 5, 50), // 50 < 168 minimum
    });
    expect(analyzeRightsizing([resource])).toHaveLength(0);
  });

  it('skips non-EC2/RDS resource types', () => {
    const ebsResource = makeEC2Resource({
      type: 'ebs_volume',
      utilization: makeUtilization(2, 5),
    });
    expect(analyzeRightsizing([ebsResource])).toHaveLength(0);
  });

  it('processes multiple resources and returns one recommendation per underutilized resource', () => {
    const idle = makeEC2Resource({
      id: 'i-idle',
      instanceType: 'm5.2xlarge',
      utilization: makeUtilization(2, 4),
      configuration: { monthlyCost: 200 },
    });
    const busy = makeEC2Resource({
      id: 'i-busy',
      instanceType: 'm5.xlarge',
      utilization: makeUtilization(85, 90),
      configuration: { monthlyCost: 100 },
    });
    const recs = analyzeRightsizing([idle, busy]);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.resourceId).toBe('i-idle');
  });
});
