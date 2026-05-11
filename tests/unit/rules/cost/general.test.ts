import { describe, it, expect } from 'vitest';
import { checkGENERAL001 } from '../../../../src/rules/cost/general.js';
import { THRESHOLDS } from '../../../../src/rules/config.js';
import type { Resource } from '../../../../src/aws/types.js';

const cfg = THRESHOLDS;

function makeResource(overrides: Partial<Resource> = {}): Resource {
  return {
    id: 'i-abc123',
    arn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-abc123',
    type: 'ec2_instance',
    name: 'web-server',
    region: 'us-east-1',
    state: 'running',
    instanceType: 'm5.xlarge',
    tags: {},
    launchTime: new Date(Date.now() - 90 * 86_400_000).toISOString(),
    collectedAt: new Date().toISOString(),
    configuration: { monthlyCost: 200 },
    ...overrides,
  };
}

describe('checkGENERAL001 — expensive region', () => {
  it('fires for expensive regions with correct savings percentages and fields', () => {
    // Singapore 12%
    const sg = makeResource({ region: 'ap-southeast-1', configuration: { monthlyCost: 175 } });
    const recSg = checkGENERAL001(sg, cfg);
    expect(recSg).not.toBeNull();
    expect(recSg!.ruleId).toBe('GENERAL-001');
    expect(recSg!.estimatedSavings).toBeCloseTo(21);
    expect(recSg!.title).toContain('12%');
    expect(recSg!.suggestedConfig).toMatchObject({ region: 'us-east-1' });
    expect(recSg!.currentConfig).toMatchObject({ region: 'ap-southeast-1', monthly_cost: 175 });
    // Confidence is dynamic: 0.40 + premium × 1.5, capped at 0.75. Singapore premium = 0.12 → 0.58
    expect(recSg!.confidence).toBeCloseTo(0.58, 2);
    expect(recSg!.risk).toBe('high');

    // Tokyo 15%
    expect(checkGENERAL001(makeResource({ region: 'ap-northeast-1', configuration: { monthlyCost: 162 } }), cfg)!.estimatedSavings).toBeCloseTo(24.3);
    // London 10%
    expect(checkGENERAL001(makeResource({ region: 'eu-west-2', configuration: { monthlyCost: 156 } }), cfg)!.estimatedSavings).toBeCloseTo(15.6);
    // Sao Paulo 20%
    expect(checkGENERAL001(makeResource({ region: 'sa-east-1', configuration: { monthlyCost: 171 } }), cfg)!.title).toContain('20%');
    // Frankfurt 10%
    expect(checkGENERAL001(makeResource({ region: 'eu-central-1', configuration: { monthlyCost: 210 } }), cfg)!.estimatedSavings).toBeCloseTo(21);
    // Seoul 12%
    expect(checkGENERAL001(makeResource({ region: 'ap-northeast-2', configuration: { monthlyCost: 180 } }), cfg)!.title).toContain('12%');
    // Works for RDS
    expect(checkGENERAL001(makeResource({ type: 'rds_instance', region: 'ap-southeast-2', configuration: { monthlyCost: 320 } }), cfg)!.resourceType).toBe('rds_instance');
  });

  it('does not fire for non-expensive regions, below cost threshold, or when data residency/compliance tags present', () => {
    expect(checkGENERAL001(makeResource({ region: 'us-east-1', configuration: { monthlyCost: 500 } }), cfg)).toBeNull();
    expect(checkGENERAL001(makeResource({ region: 'us-west-2', configuration: { monthlyCost: 500 } }), cfg)).toBeNull();
    // below $100 threshold
    expect(checkGENERAL001(makeResource({ region: 'ap-northeast-1', configuration: { monthlyCost: 50 } }), cfg)).toBeNull();
    // boundary: at exactly $100 fires, at $99.99 does not
    expect(checkGENERAL001(makeResource({ region: 'ap-northeast-1', configuration: { monthlyCost: 100 } }), cfg)).not.toBeNull();
    expect(checkGENERAL001(makeResource({ region: 'eu-west-2', configuration: { monthlyCost: 99.99 } }), cfg)).toBeNull();
    // DataResidency tag suppresses
    expect(checkGENERAL001(makeResource({ region: 'ap-northeast-1', tags: { DataResidency: 'japan' }, configuration: { monthlyCost: 500 } }), cfg)).toBeNull();
    // Compliance tag suppresses
    expect(checkGENERAL001(makeResource({ region: 'eu-west-2', tags: { Compliance: 'GDPR' }, configuration: { monthlyCost: 400 } }), cfg)).toBeNull();
    // Irrelevant tags do not suppress
    expect(checkGENERAL001(makeResource({ region: 'ap-southeast-1', tags: { Environment: 'production' }, configuration: { monthlyCost: 300 } }), cfg)).not.toBeNull();
  });
});
