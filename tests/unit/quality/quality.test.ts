import { describe, it, expect } from 'vitest';
import { scoreRecommendation, qualityLabel } from '../../../src/rules/quality.js';
import type { Recommendation } from '../../../src/rules/types.js';
import type { QualityConfig } from '../../../src/config/types.js';

const QCFG: QualityConfig = {
  excellent_threshold: 85,
  good_threshold: 70,
  fair_threshold: 50,
  savings_tier_high: 500,
  savings_tier_medium: 100,
  savings_tier_low: 20,
  title_min_length: 10,
  title_max_length: 80,
  description_full_length: 80,
  description_partial_length: 30,
  reasoning_full_length: 50,
  actionability_confidence_threshold: 0.9,
  actionability_max_bonus: 5,
  min_confidence_threshold: 0.40,
  savings_pct_high: 0.20,
  savings_pct_medium: 0.05,
};

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeRec(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    ruleId: 'EC2-001',
    resourceId: 'i-abc123',
    resourceType: 'ec2_instance',
    title: 'Stop or terminate idle EC2 instance web (10-80 chars)',
    description: 'This instance has extremely low CPU utilization and should be stopped to save costs.',
    reasoning: 'Average CPU utilization is below 5% for 7 days, indicating this instance is idle and not serving any workload.',
    impact: 'high',
    risk: 'low',
    estimatedSavings: 100,
    confidence: 0.9,
    implementationSteps: ['Stop the instance', 'Delete if unneeded'],
    patchContent: '# some patch content',
    suggestedConfig: { action: 'stop' },
    currentConfig: { state: 'running' },
    ...overrides,
  };
}

const score = (r: Recommendation): number => scoreRecommendation(r, QCFG);

// ─── Score range and relative ordering ───────────────────────────────────────

describe('scoreRecommendation', () => {
  it('returns 0-100 and high-quality > minimal', () => {
    const s = score(makeRec());
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(100);

    const empty: Recommendation = { ruleId: '', resourceId: '', resourceType: '', title: '', description: '', impact: 'low', risk: 'low', suggestedAction: '', confidence: 0 };
    const emptyScore = score(empty);
    expect(emptyScore).toBeGreaterThanOrEqual(0);
    expect(emptyScore).toBeLessThanOrEqual(100);

    expect(score(makeRec())).toBeGreaterThan(score(makeRec({
      title: 'X', description: '', reasoning: '', impact: 'low', risk: 'high',
      estimatedSavings: 0, confidence: 0, implementationSteps: undefined,
      patchContent: undefined, suggestedConfig: undefined, currentConfig: undefined,
    })));
  });

  it('clarity: long title and description score higher than short/absent', () => {
    expect(score(makeRec({ title: 'A'.repeat(40) }))).toBeGreaterThan(score(makeRec({ title: 'Hi' })));
    expect(score(makeRec({ description: 'A'.repeat(80) }))).toBeGreaterThan(score(makeRec({ description: '' })));
  });

  it('impact: savings >= $500 and high impact score higher than zero savings / low impact', () => {
    expect(score(makeRec({ estimatedSavings: 500 }))).toBeGreaterThan(score(makeRec({ estimatedSavings: 0 })));
    expect(score(makeRec({ impact: 'high' }))).toBeGreaterThan(score(makeRec({ impact: 'low' })));
  });

  it('evidence: resourceId and reasoning both contribute', () => {
    expect(score(makeRec({ resourceId: 'i-abc123' }))).toBeGreaterThan(score(makeRec({ resourceId: '' })));
    expect(score(makeRec({ reasoning: 'A'.repeat(60) }))).toBeGreaterThan(score(makeRec({ reasoning: '' })));
  });

  it('remediation: implementation steps add 10pts; patchContent adds 5 (remediation) + 4 (reversibility) = 9pts', () => {
    expect(score(makeRec({ implementationSteps: ['step 1'] })) - score(makeRec({ implementationSteps: undefined }))).toBe(10);
    // patchContent contributes to BOTH remediation (+5) and reversibility (+4 git-revertible) — total +9
    expect(score(makeRec({ patchContent: 'patch' })) - score(makeRec({ patchContent: undefined }))).toBe(9);
  });

  it('confidence: 1.0 vs 0.0 = 15pt diff (10 base + 5 max smooth bonus); 0.5 vs 0.0 = 5pt diff', () => {
    // Use minimal rec to avoid 100-point clamp masking the +15 diff
    const minimal: Recommendation = { ruleId: '', resourceId: 'i-1', resourceType: 'ec2', title: 'x', description: '', impact: 'low', risk: 'high' };
    expect(score({ ...minimal, confidence: 1.0 }) - score({ ...minimal, confidence: 0.0 })).toBe(15);
    expect(score({ ...minimal, confidence: 0.5 }) - score({ ...minimal, confidence: 0.0 })).toBe(5);
  });

  it('reversibility: risk fallback when no action info — low scores higher than medium/high', () => {
    // Clear action so risk is used as fallback signal
    const noAction = (risk: 'low' | 'medium' | 'high'): number =>
      score(makeRec({ risk, suggestedConfig: undefined, suggestedAction: undefined, patchContent: undefined }));
    expect(noAction('low')).toBeGreaterThan(noAction('high'));
    expect(noAction('low')).toBeGreaterThan(noAction('medium'));
  });

  it('reversibility: irreversible actions (delete/terminate) score 0 regardless of risk', () => {
    const lowRiskDelete = score(makeRec({ risk: 'low', suggestedConfig: { action: 'delete' } }));
    const lowRiskStop = score(makeRec({ risk: 'low', suggestedConfig: { action: 'stop' } }));
    // Stop is reversible, delete isn't — even at same risk level
    expect(lowRiskStop).toBeGreaterThan(lowRiskDelete);
  });

  it('reversibility: patchContent (Terraform = git-revertible) adds points', () => {
    const withPatch = score(makeRec({ risk: 'high', suggestedAction: undefined, suggestedConfig: undefined, patchContent: '# patch' }));
    const noPatch = score(makeRec({ risk: 'high', suggestedAction: undefined, suggestedConfig: undefined, patchContent: undefined }));
    expect(withPatch).toBeGreaterThan(noPatch);
  });

  it('actionability bonuses: filePath+suggestedConfig add >= 4pts; confidence > 0.9 adds >= 3; delete actions get -3 penalty', () => {
    const withFile = score(makeRec({ filePath: 'main.tf', suggestedConfig: { instance_type: 't3.medium' } }));
    const withoutFile = score(makeRec({ filePath: undefined, suggestedConfig: undefined }));
    expect(withFile - withoutFile).toBeGreaterThanOrEqual(4);

    expect(score(makeRec({ confidence: 0.95 })) - score(makeRec({ confidence: 0.85 }))).toBeGreaterThanOrEqual(3);

    expect(score(makeRec({ suggestedConfig: { action: 'delete' } }))).toBeLessThan(score(makeRec({ suggestedConfig: { action: 'stop' } })));
    expect(score(makeRec({ suggestedConfig: { action: 'terminate_and_delete_volumes' } }))).toBeLessThan(score(makeRec({ suggestedConfig: { action: 'stop' } })));
  });

  it('respects custom thresholds: lower savings_tier_high makes $300 score "high" tier', () => {
    const customCfg: QualityConfig = { ...QCFG, savings_tier_high: 200 };
    const lowTier = scoreRecommendation(makeRec({ estimatedSavings: 300 }), QCFG);
    const highTier = scoreRecommendation(makeRec({ estimatedSavings: 300 }), customCfg);
    expect(highTier).toBeGreaterThan(lowTier);
  });

  it('relative impact: small absolute savings + high % of currentCost lifts score', () => {
    // $10 savings on $40/mo resource = 25% (>= 20% high tier) → relative tier 15
    // vs $10 savings absolute = 4 points only → max(4, 15) = 15
    const tinyAccountHighPct = score(makeRec({ estimatedSavings: 10, currentCost: 40 }));
    const tinyAccountNoBaseline = score(makeRec({ estimatedSavings: 10, currentCost: undefined }));
    expect(tinyAccountHighPct).toBeGreaterThan(tinyAccountNoBaseline);
  });

  it('smooth actionability bonus: confidence 1.0 > 0.95 > 0.91', () => {
    const c100 = score(makeRec({ confidence: 1.0 }));
    const c95 = score(makeRec({ confidence: 0.95 }));
    const c91 = score(makeRec({ confidence: 0.91 }));
    expect(c100).toBeGreaterThan(c95);
    expect(c95).toBeGreaterThan(c91);
  });
});

// ─── qualityLabel ─────────────────────────────────────────────────────────────

describe('qualityLabel', () => {
  it('maps score thresholds to labels using config', () => {
    expect(qualityLabel(85, QCFG)).toBe('excellent');
    expect(qualityLabel(100, QCFG)).toBe('excellent');
    expect(qualityLabel(70, QCFG)).toBe('good');
    expect(qualityLabel(84, QCFG)).toBe('good');
    expect(qualityLabel(50, QCFG)).toBe('fair');
    expect(qualityLabel(69, QCFG)).toBe('fair');
    expect(qualityLabel(49, QCFG)).toBe('poor');
    expect(qualityLabel(0, QCFG)).toBe('poor');
  });

  it('respects custom thresholds', () => {
    const strict: QualityConfig = { ...QCFG, excellent_threshold: 95, good_threshold: 80, fair_threshold: 60 };
    expect(qualityLabel(85, strict)).toBe('good'); // was excellent under default
    expect(qualityLabel(70, strict)).toBe('fair'); // was good under default
  });
});
