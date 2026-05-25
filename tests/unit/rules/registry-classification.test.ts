/**
 * Registry classification invariants (#44 Item 2).
 *
 * These tests enforce that the `costGating` field on `RuleInfo` stays in sync
 * with the actual rule implementations. If a new rule is added to the registry
 * without a classification, or a rule changes its gating behaviour without the
 * registry being updated, the diff is caught here.
 */

import { describe, it, expect } from 'vitest';
import { ruleRegistry } from '../../../src/rules/registry.js';
import { evaluateRules } from '../../../src/rules/index.js';
import type { CostGating } from '../../../src/rules/types.js';
import type { Resource } from '../../../src/aws/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal resource with monthlyCost set so strict rules can fire. */
function makeResource(type: Resource['type'], overrides: Partial<Resource> = {}): Resource {
  return {
    id: `test-${type}-001`,
    arn: `arn:aws:test:us-east-1:123456789012:${type}/test`,
    type,
    name: `test-${type}`,
    region: 'us-east-1',
    state: 'running',
    instanceType: 't3.medium',
    tags: {},
    launchTime: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    collectedAt: new Date().toISOString(),
    configuration: { monthlyCost: 100 },
    ...overrides,
  };
}

/** The 33 rules designated as strict cost-saving rules (#44 Item 2 original 11 + 22 added by #75). */
const STRICT_RULES: ReadonlySet<string> = new Set([
  'EBS-001',
  'EBS-002',
  'EBS-003',
  'SNAP-001',
  'SNAP-002',
  'RDS-001',
  'RDS-003',
  'RDS-006',
  'RDS-007',
  'RDS-008',
  'RDS-009',
  'ELC-001',
  'ELC-002',
  'ELC-003',
  'ELB-001',
  'ELB-002',
  'LB-002',
  'S3-001',
  'S3-002',
  'DDB-001',
  'DDB-002',
  'ECS-001',
  'ECS-002',
  'ECS-003',
  'LAM-005',
  'EC2-001',
  'EC2-002',
  'EC2-003',
  'EC2-004',
  'EC2-005',
  'EC2-006',
  'EC2-007',
  'EC2-008',
]);

describe('Rule registry — costGating classification (#44)', () => {
  it('every rule has an explicit costGating classification', () => {
    const unclassified = ruleRegistry.filter((r) => r.costGating === undefined);
    expect(unclassified).toEqual([]);
  });

  it('only the 33 #44/#75-designated rules are marked strict', () => {
    const strictInRegistry = ruleRegistry
      .filter((r) => r.costGating === 'strict')
      .map((r) => r.id)
      .sort();
    expect(strictInRegistry).toEqual([...STRICT_RULES].sort());
  });

  it('costGating values are within the closed enum', () => {
    const valid: ReadonlySet<CostGating> = new Set(['strict', 'security', 'fixed-rate', 'cost-graduated']);
    for (const r of ruleRegistry) {
      expect(valid.has(r.costGating!)).toBe(true);
    }
  });

  it('partitions the registry into 4 non-overlapping buckets that sum to the total', () => {
    const strict = ruleRegistry.filter((r) => r.costGating === 'strict').length;
    const security = ruleRegistry.filter((r) => r.costGating === 'security').length;
    const fixedRate = ruleRegistry.filter((r) => r.costGating === 'fixed-rate').length;
    const costGraduated = ruleRegistry.filter((r) => r.costGating === 'cost-graduated').length;
    expect(strict + security + fixedRate + costGraduated).toBe(ruleRegistry.length);
  });
});

describe('Rule registry — structural invariants', () => {
  it('all rule IDs are unique (no duplicates)', () => {
    const ids = ruleRegistry.map((r) => r.id);
    const unique = new Set(ids);
    const duplicates = ids.filter((id) => {
      const first = ids.indexOf(id);
      const last = ids.lastIndexOf(id);
      return first !== last;
    });
    expect(duplicates).toEqual([]);
    expect(unique.size).toBe(ruleRegistry.length);
  });

  it('all rule IDs match the CATEGORY-NNN pattern', () => {
    const pattern = /^[A-Z0-9]+-\d{3}$/;
    const malformed = ruleRegistry.filter((r) => !pattern.test(r.id)).map((r) => r.id);
    expect(malformed).toEqual([]);
  });

  it('all rules have non-empty required fields', () => {
    for (const r of ruleRegistry) {
      expect(r.title.length, `${r.id} title is empty`).toBeGreaterThan(0);
      expect(r.description.length, `${r.id} description is empty`).toBeGreaterThan(0);
      expect(['low', 'medium', 'high'], `${r.id} impact invalid`).toContain(r.impact);
      expect(['low', 'medium', 'high'], `${r.id} risk invalid`).toContain(r.risk);
    }
  });
});

describe('Rule runner — evaluateRules invariants', () => {
  it('all emitted recommendations have non-negative estimatedSavings', () => {
    const resources: Resource[] = [
      makeResource('ec2_instance', { utilization: { period: '30d', cpuAverage: 1, cpuMax: 2, cpuP95: 1.5, cpuP99: 1.8, memoryAverage: 0, memoryMax: 0, memoryP95: 0, networkInMB: 0, networkOutMB: 0, diskReadIOPS: 0, diskWriteIOPS: 0, connectionCount: 0, connectionCountMax: 0, dataPoints: 500, dataGaps: 0, freshnessHrs: 1 } }),
      makeResource('ebs_volume', { configuration: { volume_type: 'gp2', size_gb: 100, monthlyCost: 10 }, state: 'available' }),
      makeResource('rds_instance', { configuration: { engine: 'mysql', multi_az: false, allocated_storage: 20, monthlyCost: 100 } }),
      makeResource('s3_bucket', { configuration: { size_gb: 1000, storage_class: 'STANDARD', monthlyCost: 23 } }),
      makeResource('load_balancer', { configuration: { type: 'application', monthlyCost: 20 } }),
      makeResource('dynamodb_table', { configuration: { billing_mode: 'PROVISIONED', read_capacity_units: 5, write_capacity_units: 5, monthlyCost: 10 } }),
    ];

    const { recommendations } = evaluateRules(resources);
    for (const rec of recommendations) {
      expect(
        rec.estimatedSavings,
        `${rec.ruleId} on ${rec.resourceId} produced negative savings: ${rec.estimatedSavings}`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        Number.isFinite(rec.estimatedSavings),
        `${rec.ruleId} on ${rec.resourceId} produced non-finite savings: ${rec.estimatedSavings}`,
      ).toBe(true);
    }
  });

  it('evaluateRules does not throw for any known resource type', () => {
    const types: Resource['type'][] = [
      'ec2_instance', 'ebs_volume', 'ebs_snapshot', 'elastic_ip', 'rds_instance',
      's3_bucket', 'lambda_function', 'load_balancer', 'elasticache_cluster',
      'dynamodb_table', 'nat_gateway', 'ecs_service',
    ];
    const resources = types.map((t) => makeResource(t));
    expect(() => evaluateRules(resources)).not.toThrow();
  });
});
