import { describe, it, expect } from 'vitest';
import { listRulesTool } from '../../../src/tools/list-rules.js';
import { ruleRegistry } from '../../../src/rules/registry.js';
import { evaluateRulesTool } from '../../../src/tools/evaluate-rules.js';
import { detectAnomalesTool } from '../../../src/tools/detect-anomalies.js';
import type { Resource } from '../../../src/aws/types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

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

function makeUtil(cpuAverage: number, cpuP95 = 50) {
  return {
    period: '7d' as const,
    cpuAverage,
    cpuMax: cpuAverage * 2,
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

function makeCostPoints(count: number, baseAmount = 100): Array<{ date: string; amount: number }> {
  return Array.from({ length: count }, (_, i) => {
    const d = new Date('2024-01-01');
    d.setDate(d.getDate() + i);
    // Add small natural variance so stddev > 0 (required for z-score computation)
    const variance = baseAmount * 0.05 * (i % 3 === 0 ? 1 : -1);
    return { date: d.toISOString().slice(0, 10), amount: baseAmount + variance };
  });
}

// ─── list_rules tool ──────────────────────────────────────────────────────────

describe('list_rules MCP tool', () => {
  it('returns all rules from registry', async () => {
    const result = await listRulesTool.handler({});
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.count).toBe(ruleRegistry.length);
    expect(data.rules).toHaveLength(ruleRegistry.length);
  });

  it('returns rules with required fields', async () => {
    const result = await listRulesTool.handler({});
    const data = JSON.parse(result.content[0]!.text);
    for (const rule of data.rules) {
      expect(rule.id).toBeTruthy();
      expect(rule.category).toBeTruthy();
      expect(rule.title).toBeTruthy();
      expect(['low', 'medium', 'high']).toContain(rule.impact);
    }
  });

  it('includes EC2-001', async () => {
    const result = await listRulesTool.handler({});
    const data = JSON.parse(result.content[0]!.text);
    expect(data.rules.some((r: { id: string }) => r.id === 'EC2-001')).toBe(true);
  });

  it('is marked readOnly', () => {
    expect(listRulesTool.annotations?.readOnlyHint).toBe(true);
  });

  it('returns content array with text type', async () => {
    const result = await listRulesTool.handler({});
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe('text');
  });
});

// ─── evaluate_rules tool ──────────────────────────────────────────────────────

describe('evaluate_rules MCP tool', () => {
  it('returns empty recommendations for empty resources array', async () => {
    const result = await evaluateRulesTool.handler({ resources: [] });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.recommendations).toHaveLength(0);
    expect(data.summary.recommendationsFound).toBe(0);
  });

  it('fires EC2-001 for idle instance', async () => {
    const resource = makeEC2({ utilization: makeUtil(1.0, 2) });
    const result = await evaluateRulesTool.handler({ resources: [resource] });
    const data = JSON.parse(result.content[0]!.text);
    const ruleIds = data.recommendations.map((r: { ruleId: string }) => r.ruleId);
    expect(ruleIds).toContain('EC2-001');
  });

  it('fires EBS-001 for unattached volume', async () => {
    const volume: Resource = {
      id: 'vol-abc',
      arn: '',
      type: 'ebs_volume',
      name: 'orphan-vol',
      region: 'us-east-1',
      state: 'available',
      instanceType: '',
      tags: {},
      launchTime: new Date().toISOString(),
      collectedAt: new Date().toISOString(),
      configuration: { volume_type: 'gp3', monthlyCost: 10 },
    };
    const result = await evaluateRulesTool.handler({ resources: [volume] });
    const data = JSON.parse(result.content[0]!.text);
    const ruleIds = data.recommendations.map((r: { ruleId: string }) => r.ruleId);
    expect(ruleIds).toContain('EBS-001');
  });

  it('respects ruleIds filter', async () => {
    const resource = makeEC2({ utilization: makeUtil(1.0) });
    const result = await evaluateRulesTool.handler({
      resources: [resource],
      ruleIds: ['EC2-001'],
    });
    const data = JSON.parse(result.content[0]!.text);
    // All returned rules should be EC2-001
    for (const rec of data.recommendations) {
      expect(rec.ruleId).toBe('EC2-001');
    }
  });

  it('returns estimatedSavings as a number in summary', async () => {
    const resource = makeEC2({
      utilization: makeUtil(1.0),
      configuration: { monthlyCost: 100 },
    });
    const result = await evaluateRulesTool.handler({ resources: [resource] });
    const data = JSON.parse(result.content[0]!.text);
    expect(typeof data.summary.estimatedSavings).toBe('number');
    expect(data.summary.estimatedSavings).toBeGreaterThanOrEqual(0);
  });

  it('returns error result when resources is not an array', async () => {
    const result = await evaluateRulesTool.handler({ resources: 'not-an-array' });
    expect(result.isError).toBe(true);
  });

  it('recommendations have qualityScore', async () => {
    const resource = makeEC2({ utilization: makeUtil(1.0) });
    const result = await evaluateRulesTool.handler({ resources: [resource] });
    const data = JSON.parse(result.content[0]!.text);
    if (data.recommendations.length > 0) {
      expect(data.recommendations[0].qualityScore).toBeDefined();
      expect(typeof data.recommendations[0].qualityScore).toBe('number');
    }
  });

  it('handles threshold overrides', async () => {
    // With idleCPUThreshold raised to 50%, even a 10% CPU instance is "idle"
    const resource = makeEC2({ utilization: makeUtil(10.0) });
    const normalResult = await evaluateRulesTool.handler({ resources: [resource] });
    const normalData = JSON.parse(normalResult.content[0]!.text);
    const normalHasEC2001 = normalData.recommendations.some((r: { ruleId: string }) => r.ruleId === 'EC2-001');

    const overrideResult = await evaluateRulesTool.handler({
      resources: [resource],
      thresholds: { idleCPUThreshold: 50 },
    });
    const overrideData = JSON.parse(overrideResult.content[0]!.text);
    const overrideHasEC2001 = overrideData.recommendations.some((r: { ruleId: string }) => r.ruleId === 'EC2-001');

    // Without override: 10% CPU is NOT idle (threshold 5%)
    expect(normalHasEC2001).toBe(false);
    // With override: 10% CPU IS idle (threshold 50%)
    expect(overrideHasEC2001).toBe(true);
  });
});

// ─── detect_cost_anomalies tool ───────────────────────────────────────────────

describe('detect_cost_anomalies MCP tool', () => {
  it('accepts empty array costData without error', async () => {
    // Empty array is valid — handler coalesces non-array to [] so isError is never set
    const result = await detectAnomalesTool.handler({ costData: [] });
    expect(result.isError).toBeUndefined();
  });

  it('returns empty anomalies for fewer than minDataPoints', async () => {
    const costData = makeCostPoints(3); // only 3, min is 7
    const result = await detectAnomalesTool.handler({ costData });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.anomalies).toHaveLength(0);
    expect(data.summary.totalAnomalies).toBe(0);
  });

  it('detects a cost spike in sample data', async () => {
    const costData = makeCostPoints(20, 100);
    // Add a spike 50× above baseline — guaranteed to exceed any z-score threshold
    costData.push({ date: '2024-01-21', amount: 5000 });

    const result = await detectAnomalesTool.handler({
      costData,
      windowSize: 14,
      minDataPoints: 3,
    });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.anomalies.length).toBeGreaterThan(0);
    expect(data.anomalies[0].direction).toBe('spike');
    expect(data.anomalies[0].zScore).toBeGreaterThan(0);
    expect(data.summary.totalAnomalies).toBe(data.anomalies.length);
  });

  it('returns a trend object with direction and forecast', async () => {
    const costData = Array.from({ length: 10 }, (_, i) => ({
      date: `2024-01-${String(i + 1).padStart(2, '0')}`,
      amount: 100 + i * 10,
    }));
    const result = await detectAnomalesTool.handler({ costData });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.trend).toBeDefined();
    expect(['increasing', 'decreasing', 'stable']).toContain(data.trend.direction);
    expect(typeof data.trend.forecast30d).toBe('number');
    expect(typeof data.trend.slope).toBe('number');
    expect(typeof data.trend.r2).toBe('number');
  });

  it('returns bySeverity breakdown in summary', async () => {
    const costData = makeCostPoints(20, 100);
    costData.push({ date: '2024-01-21', amount: 5000 });
    const result = await detectAnomalesTool.handler({ costData, windowSize: 0, minDataPoints: 7 });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.summary.bySeverity).toBeDefined();
    expect(typeof data.summary.bySeverity.critical).toBe('number');
    expect(typeof data.summary.bySeverity.high).toBe('number');
    expect(typeof data.summary.bySeverity.medium).toBe('number');
    expect(typeof data.summary.bySeverity.low).toBe('number');
  });

  it('respects custom minDataPoints parameter', async () => {
    const costData = makeCostPoints(5, 100); // 5 points
    // With minDataPoints=3, 5 points should be enough
    const result = await detectAnomalesTool.handler({ costData, minDataPoints: 3 });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0]!.text);
    // Just verify structure is correct
    expect(data.anomalies).toBeDefined();
    expect(data.trend).toBeDefined();
  });

  it('is marked readOnly', () => {
    expect(detectAnomalesTool.annotations?.readOnlyHint).toBe(true);
  });

  it('anomaly objects have all expected fields', async () => {
    const costData = makeCostPoints(20, 100);
    // 500× baseline spike guarantees detection
    costData.push({ date: '2024-01-21', amount: 50000 });
    const result = await detectAnomalesTool.handler({ costData, windowSize: 14, minDataPoints: 3 });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.anomalies.length).toBeGreaterThan(0);
    const anomaly = data.anomalies[0];
    expect(typeof anomaly.date).toBe('string');
    expect(typeof anomaly.amount).toBe('number');
    expect(typeof anomaly.zScore).toBe('number');
    expect(['low', 'medium', 'high', 'critical']).toContain(anomaly.severity);
    expect(['spike', 'drop']).toContain(anomaly.direction);
    expect(typeof anomaly.expectedAmount).toBe('number');
    expect(typeof anomaly.deviation).toBe('number');
  });
});
