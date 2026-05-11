/**
 * Unit tests for diffResources and diffRecommendations from compare-scans.ts
 */

import { describe, it, expect } from 'vitest';
import { diffResources, diffRecommendations } from '../../../src/tools/compare-scans.js';
import type { Resource } from '../../../src/storage/queries/resources.js';
import type { Recommendation } from '../../../src/storage/queries/recommendations.js';

function makeResource(overrides: Partial<Resource> & { resource_id?: string | null }): Resource {
  return {
    id: `scan:${overrides.resource_id}`,
    scan_id: 'scan-1',
    type: 'ec2_instance',
    state: 'running',
    monthly_cost: 100,
    ...overrides,
  };
}

function makeRec(overrides: Partial<Recommendation> & { resource_id?: string | null; type: string }): Recommendation {
  return {
    id: `rec-${overrides.resource_id}`,
    scan_id: 'scan-1',
    title: `Rec for ${overrides.resource_id}`,
    ...overrides,
  };
}

// ─── diffResources ───────────────────────────────────────────────────────────

describe('diffResources', () => {
  it('detects added resources', () => {
    const before = [makeResource({ resource_id: 'i-aaa' })];
    const after = [
      makeResource({ resource_id: 'i-aaa' }),
      makeResource({ resource_id: 'i-bbb' }),
    ];
    const diff = diffResources(before, after);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]!.resource_id).toBe('i-bbb');
    expect(diff.removed).toHaveLength(0);
  });

  it('detects removed resources', () => {
    const before = [
      makeResource({ resource_id: 'i-aaa' }),
      makeResource({ resource_id: 'i-bbb' }),
    ];
    const after = [makeResource({ resource_id: 'i-aaa' })];
    const diff = diffResources(before, after);
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0]!.resource_id).toBe('i-bbb');
    expect(diff.added).toHaveLength(0);
  });

  it('detects changed resources by cost delta', () => {
    const before = [makeResource({ resource_id: 'i-aaa', monthly_cost: 100 })];
    const after = [makeResource({ resource_id: 'i-aaa', monthly_cost: 150 })];
    const diff = diffResources(before, after);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]!.cost_delta).toBeCloseTo(50);
  });

  it('detects changed resources by state change', () => {
    const before = [makeResource({ resource_id: 'i-aaa', state: 'running' })];
    const after = [makeResource({ resource_id: 'i-aaa', state: 'stopped' })];
    const diff = diffResources(before, after);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]!.before.state).toBe('running');
    expect(diff.changed[0]!.after.state).toBe('stopped');
  });

  it('detects changed resources by instance_type change', () => {
    const before = [makeResource({ resource_id: 'i-aaa', instance_type: 't3.micro' })];
    const after = [makeResource({ resource_id: 'i-aaa', instance_type: 't3.large' })];
    const diff = diffResources(before, after);
    expect(diff.changed).toHaveLength(1);
  });

  it('ignores tiny cost deltas below threshold (0.01)', () => {
    const before = [makeResource({ resource_id: 'i-aaa', monthly_cost: 100 })];
    const after = [makeResource({ resource_id: 'i-aaa', monthly_cost: 100.005 })];
    const diff = diffResources(before, after);
    expect(diff.changed).toHaveLength(0);
  });

  it('returns empty diff for identical lists', () => {
    const resources = [makeResource({ resource_id: 'i-aaa' }), makeResource({ resource_id: 'i-bbb' })];
    const diff = diffResources(resources, [...resources]);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
  });

  it('returns empty diff for two empty lists', () => {
    const diff = diffResources([], []);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
  });

  it('handles single undefined resource_id consistently (no false added/removed)', () => {
    const before = [makeResource({ resource_id: undefined, type: 'ebs' })];
    const after = [makeResource({ resource_id: undefined, type: 'ebs' })];
    const diff = diffResources(before, after);
    // Both at index 0 → keys match (__no_id_0) → should NOT appear as added/removed
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it('treats multiple null-id resources as untrackable: all appear as added/removed', () => {
    const before = [
      makeResource({ resource_id: undefined, type: 'ebs' }),
      makeResource({ resource_id: undefined, type: 'ebs' }),
    ];
    const after = [makeResource({ resource_id: undefined, type: 'ebs' })];
    const diff = diffResources(before, after);
    // before has __no_id_0 and __no_id_1; after has __no_id_0 only
    // __no_id_0 matches in both → 0 added, 1 removed (__no_id_1 from before)
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(1);
  });

  it('handles null monthly_cost gracefully (defaults to 0)', () => {
    const before = [makeResource({ resource_id: 'i-aaa', monthly_cost: undefined })];
    const after = [makeResource({ resource_id: 'i-aaa', monthly_cost: 50 })];
    const diff = diffResources(before, after);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]!.cost_delta).toBeCloseTo(50);
  });
});

// ─── diffRecommendations ─────────────────────────────────────────────────────

describe('diffRecommendations', () => {
  it('detects new recommendations', () => {
    const before = [makeRec({ resource_id: 'i-aaa', type: 'rightsize' })];
    const after = [
      makeRec({ resource_id: 'i-aaa', type: 'rightsize' }),
      makeRec({ resource_id: 'i-bbb', type: 'unused' }),
    ];
    const diff = diffRecommendations(before, after);
    expect(diff.new_recommendations).toHaveLength(1);
    expect(diff.new_recommendations[0]!.resource_id).toBe('i-bbb');
    expect(diff.resolved_recommendations).toHaveLength(0);
  });

  it('detects resolved recommendations', () => {
    const before = [
      makeRec({ resource_id: 'i-aaa', type: 'rightsize' }),
      makeRec({ resource_id: 'i-bbb', type: 'unused' }),
    ];
    const after = [makeRec({ resource_id: 'i-aaa', type: 'rightsize' })];
    const diff = diffRecommendations(before, after);
    expect(diff.resolved_recommendations).toHaveLength(1);
    expect(diff.resolved_recommendations[0]!.resource_id).toBe('i-bbb');
    expect(diff.new_recommendations).toHaveLength(0);
  });

  it('differentiates by type for same resource_id', () => {
    const before = [makeRec({ resource_id: 'i-aaa', type: 'rightsize' })];
    const after = [makeRec({ resource_id: 'i-aaa', type: 'unused' })];
    const diff = diffRecommendations(before, after);
    expect(diff.new_recommendations).toHaveLength(1);
    expect(diff.resolved_recommendations).toHaveLength(1);
  });

  it('returns empty diff for identical lists', () => {
    const recs = [makeRec({ resource_id: 'i-aaa', type: 'rightsize' })];
    const diff = diffRecommendations(recs, [...recs]);
    expect(diff.new_recommendations).toHaveLength(0);
    expect(diff.resolved_recommendations).toHaveLength(0);
  });

  it('handles undefined resource_id without false positives', () => {
    const before = [makeRec({ resource_id: undefined as unknown as string, type: 'unused' })];
    const after = [makeRec({ resource_id: undefined as unknown as string, type: 'unused' })];
    const diff = diffRecommendations(before, after);
    expect(diff.new_recommendations).toHaveLength(0);
    expect(diff.resolved_recommendations).toHaveLength(0);
  });
});
