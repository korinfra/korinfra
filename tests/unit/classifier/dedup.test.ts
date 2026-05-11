import { describe, it, expect } from 'vitest';
import { deduplicateRecommendations } from '../../../src/classifier/dedup.js';
import type { Recommendation } from '../../../src/classifier/types.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeRec(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    id: '',
    resourceId: 'i-0abc123',
    resourceType: 'ec2_instance',
    type: 'rightsize',
    scenario: 'C',
    title: 'Downsize underutilized instance',
    description: 'CPU usage < 5% over 30 days — consider t3.small.',
    estimatedSavings: 45.0,
    confidence: 0.85,
    qualityScore: 0.8,
    impact: 'medium',
    risk: 'low',
    implementationSteps: ['Change instance_type to t3.small in main.tf'],
    ...overrides,
  };
}

// ─── deduplicateRecommendations ───────────────────────────────────────────────

describe('deduplicateRecommendations', () => {
  it('passes through trivial inputs unchanged', () => {
    expect(deduplicateRecommendations([])).toHaveLength(0);
    const rec = makeRec();
    const result = deduplicateRecommendations([rec]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(rec);
  });

  it('deduplicates same resourceId+type keeping highest savings and promoted confidence', () => {
    // keeps highest savings
    const low = makeRec({ estimatedSavings: 20.0, title: 'Low savings rec', confidence: 0.7 });
    const high = makeRec({ estimatedSavings: 80.0, title: 'High savings rec', confidence: 0.9 });
    const r1 = deduplicateRecommendations([low, high]);
    expect(r1).toHaveLength(1);
    expect(r1[0]!.estimatedSavings).toBe(80.0);
    expect(r1[0]!.title).toBe('High savings rec');

    // tied savings: promotes higher confidence
    const lowConf = makeRec({ estimatedSavings: 50, confidence: 0.6, qualityScore: 0.5 });
    const highConf = makeRec({ estimatedSavings: 50, confidence: 0.9, qualityScore: 0.9 });
    const r2 = deduplicateRecommendations([lowConf, highConf]);
    expect(r2).toHaveLength(1);
    expect(r2[0]!.confidence).toBe(0.9);

    // best by savings but low confidence: alt confidence is promoted
    const best = makeRec({ estimatedSavings: 100, confidence: 0.5 });
    const alt = makeRec({ estimatedSavings: 40, confidence: 0.95 });
    const r3 = deduplicateRecommendations([best, alt]);
    expect(r3).toHaveLength(1);
    expect(r3[0]!.confidence).toBe(0.95);
  });

  it('does NOT dedup different resourceIds or different types', () => {
    const recA = makeRec({ resourceId: 'i-0abc123', type: 'rightsize' });
    const recB = makeRec({ resourceId: 'i-0def456', type: 'rightsize' });
    expect(deduplicateRecommendations([recA, recB])).toHaveLength(2);

    const rightsize = makeRec({ resourceId: 'i-0abc123', type: 'rightsize' });
    const security = makeRec({ resourceId: 'i-0abc123', type: 'security', title: 'Security issue' });
    expect(deduplicateRecommendations([rightsize, security])).toHaveLength(2);
  });

  it('handles null/undefined resourceId gracefully', () => {
    // empty resourceId: groups by type::title
    const recA = makeRec({ resourceId: '', type: 'tag', title: 'Missing required tags' });
    const recB = makeRec({ resourceId: '', type: 'tag', title: 'Missing required tags' });
    expect(deduplicateRecommendations([recA, recB])).toHaveLength(1);

    // undefined: no crash
    const rec = makeRec({ resourceId: undefined as unknown as string });
    expect(() => deduplicateRecommendations([rec])).not.toThrow();
  });

  it('merges alternatives and preserves distinct combinations', () => {
    const main = makeRec({ estimatedSavings: 80, title: 'Main rec', description: 'Main description.' });
    const altRec = makeRec({ estimatedSavings: 30, title: 'Alt rec', description: 'Alternative approach.' });
    const merged = deduplicateRecommendations([main, altRec]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.description).toContain('Main description.');
    expect(merged[0]!.alternatives?.length).toBeGreaterThan(0);

    // 5 duplicates: keeps best savings
    const dupes = Array.from({ length: 5 }, (_, i) =>
      makeRec({ resourceId: 'i-0abc123', type: 'rightsize', estimatedSavings: i * 10 }),
    );
    const deduped = deduplicateRecommendations(dupes);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.estimatedSavings).toBe(40);

    // 3 distinct combinations preserved
    const recs: Recommendation[] = [
      makeRec({ resourceId: 'i-001', type: 'rightsize', estimatedSavings: 20 }),
      makeRec({ resourceId: 'i-002', type: 'rightsize', estimatedSavings: 30 }),
      makeRec({ resourceId: 'i-003', type: 'unused', estimatedSavings: 50 }),
    ];
    expect(deduplicateRecommendations(recs)).toHaveLength(3);
  });
});

// ─── Non-empty id but empty resourceId edge case ───────────────────────────────

describe('deduplicateRecommendations — id vs resourceId distinction', () => {
  it('uses resourceId as dedup key when available; falls back to id::type::title when resourceId empty', () => {
    // When both resourceId and id differ, they are treated as separate resources
    const rec1 = makeRec({
      id: 'rec-001',
      resourceId: '',
      type: 'tag',
      title: 'Missing required tags',
      estimatedSavings: 10,
      confidence: 0.8,
    });
    const rec2 = makeRec({
      id: 'rec-002',
      resourceId: '',
      type: 'tag',
      title: 'Missing required tags',
      estimatedSavings: 20,
      confidence: 0.7,
    });

    // Fall back to id::type::title: 'rec-001::tag::Missing required tags' vs 'rec-002::tag::Missing required tags'
    // These are different, so they don't dedup
    const result = deduplicateRecommendations([rec1, rec2]);
    expect(result).toHaveLength(2);
  });

  it('deduplicates when both have same id, type, and title with empty resourceId', () => {
    const rec1 = makeRec({
      id: 'rec-001',
      resourceId: '',
      type: 'tag',
      title: 'Missing required tags',
      estimatedSavings: 10,
      confidence: 0.8,
      qualityScore: 0.5,
    });
    const rec2 = makeRec({
      id: 'rec-001', // SAME id
      resourceId: '',
      type: 'tag',
      title: 'Missing required tags', // SAME title
      estimatedSavings: 20,
      confidence: 0.7,
      qualityScore: 0.9,
    });

    // Fall back key is same: 'rec-001::tag::Missing required tags'
    const result = deduplicateRecommendations([rec1, rec2]);
    expect(result).toHaveLength(1);
    expect(result[0]!.estimatedSavings).toBe(20); // highest savings wins
    expect(result[0]!.confidence).toBe(0.8); // higher confidence promoted
  });

  it('does NOT dedup when resourceId differs (clearly separate resources)', () => {
    const rec1 = makeRec({ resourceId: 'i-001', type: 'rightsize', estimatedSavings: 50 });
    const rec2 = makeRec({ resourceId: 'i-002', type: 'rightsize', estimatedSavings: 50 });

    const result = deduplicateRecommendations([rec1, rec2]);
    expect(result).toHaveLength(2);
  });
});
