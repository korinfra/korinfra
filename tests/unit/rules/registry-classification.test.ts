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
import type { CostGating } from '../../../src/rules/types.js';

/** The 11 rules that #44 Item 2 designates as strict cost-saving rules. */
const STRICT_RULES: ReadonlySet<string> = new Set([
  'EBS-001',
  'EBS-002',
  'SNAP-001',
  'SNAP-002',
  'RDS-001',
  'RDS-003',
  'RDS-009',
  'ELC-001',
  'ELC-003',
  'ELB-001',
  'LB-002',
]);

describe('Rule registry — costGating classification (#44)', () => {
  it('every rule has an explicit costGating classification', () => {
    const unclassified = ruleRegistry.filter((r) => r.costGating === undefined);
    expect(unclassified).toEqual([]);
  });

  it('only the 11 #44-designated rules are marked strict', () => {
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
