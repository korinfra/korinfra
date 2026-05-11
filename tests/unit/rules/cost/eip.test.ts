/**
 * Tests for src/rules/cost/eip.ts — EIP-001: unused Elastic IP.
 */

import { describe, it, expect } from 'vitest';
import { checkEIP001 } from '../../../../src/rules/cost/eip.js';
import { THRESHOLDS } from '../../../../src/rules/config.js';
import type { Resource } from '../../../../src/aws/types.js';

const cfg = THRESHOLDS;

function makeEIP(overrides: Partial<Resource> = {}): Resource {
  return {
    id: 'eipalloc-0a1b2c3d4e5f67890',
    arn: 'arn:aws:ec2:us-east-1:123456789012:eip/eipalloc-0a1b2c3d4e5f67890',
    type: 'elastic_ip',
    name: '54.210.167.89',
    region: 'us-east-1',
    state: 'unassociated',
    instanceType: '',
    tags: {},
    launchTime: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    collectedAt: new Date().toISOString(),
    configuration: {
      public_ip: '54.210.167.89',
      association_id: '',
      domain: 'vpc',
    },
    ...overrides,
  };
}

describe('checkEIP001 — unattached Elastic IP', () => {
  it('fires for unassociated EIP with correct fields', () => {
    const r = makeEIP({ state: 'unassociated' });
    const rec = checkEIP001(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('EIP-001');
    expect(rec!.impact).toBe('low');
    expect(rec!.risk).toBe('low');
    expect(rec!.confidence).toBeCloseTo(0.99);
    expect(rec!.estimatedSavings).toBeCloseTo(3.65, 2);
    expect(rec!.suggestedAction).toBe('release_eip');
    expect(rec!.suggestedConfig!.action).toBe('release');
    expect(rec!.resourceId).toBe('eipalloc-0a1b2c3d4e5f67890');
    expect(rec!.resourceType).toBe('elastic_ip');
  });

  it('fires for any non-associated state and includes description/reasoning/steps', () => {
    const r = makeEIP({ state: 'available' });
    const rec = checkEIP001(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.description).toContain('3.65 USD');
    expect(rec!.reasoning).toContain('$0.005/hr');
    expect(rec!.patchContent).toContain('release-address');
    expect(rec!.patchContent).toContain('eipalloc-0a1b2c3d4e5f67890');
    expect(rec!.implementationSteps.length).toBeGreaterThanOrEqual(2);
    const steps = rec!.implementationSteps.join(' ');
    expect(steps).toContain('Verify');
  });

  it('does NOT fire for associated EIP or wrong resource type', () => {
    expect(checkEIP001(makeEIP({ state: 'associated' }), cfg)).toBeNull();
    expect(checkEIP001(makeEIP({ type: 'ec2_instance', state: 'unassociated' }), cfg)).toBeNull();
  });
});
