import { describe, it, expect } from 'vitest';
import { checkTAG001, checkTAG002 } from '../../../../src/rules/cost/tags.js';
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
    launchTime: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    collectedAt: new Date().toISOString(),
    configuration: { monthlyCost: 200 },
    ...overrides,
  };
}

// ─── TAG-001: Missing required tags ──────────────────────────────────────────

describe('checkTAG001 — missing required tags', () => {
  it('fires with correct fields and reports the right missing tags', () => {
    // All three missing
    const r1 = makeResource({ tags: { Name: 'web-server' } });
    const rec1 = checkTAG001(r1, cfg);
    expect(rec1).not.toBeNull();
    expect(rec1!.ruleId).toBe('TAG-001');
    expect(rec1!.confidence).toBe(0.99);
    expect(rec1!.estimatedSavings).toBe(0);
    expect(rec1!.currentConfig).toMatchObject({ missing_tags: ['Environment', 'Team', 'Project'] });

    // Only Team missing
    const r2 = makeResource({ tags: { Environment: 'staging', Project: 'korinfra' } });
    expect(checkTAG001(r2, cfg)!.currentConfig.missing_tags).toEqual(['Team']);

    // Only Project missing
    const r3 = makeResource({ tags: { Environment: 'dev', Team: 'backend' } });
    expect(checkTAG001(r3, cfg)!.currentConfig.missing_tags).toEqual(['Project']);

    // Title contains type and name
    const r4 = makeResource({ type: 'rds_instance', name: 'prod-database', tags: { Environment: 'production' } });
    const rec4 = checkTAG001(r4, cfg);
    expect(rec4!.title).toContain('rds_instance');
    expect(rec4!.title).toContain('prod-database');
    expect(rec4!.patchContent).toContain('Team = "<value>"');
    expect(rec4!.patchContent).toContain('Project = "<value>"');
  });

  it('does not fire when all required tags present, completely untagged, empty string value, or case-sensitive mismatch fires', () => {
    expect(checkTAG001(makeResource({ tags: { Environment: 'production', Team: 'platform', Project: 'korinfra' } }), cfg)).toBeNull();
    expect(checkTAG001(makeResource({ tags: {} }), cfg)).toBeNull(); // TAG-002 handles this
    expect(checkTAG001(makeResource({ tags: { Environment: '', Team: 'backend', Project: 'api' } }), cfg)).toBeNull(); // key exists

    // lowercase variants don't count as required tags (case-sensitive)
    const caseR = makeResource({ tags: { environment: 'production', team: 'backend', project: 'api' } });
    const caseRec = checkTAG001(caseR, cfg);
    expect(caseRec).not.toBeNull();
    expect(caseRec!.currentConfig.missing_tags).toContain('Environment');
  });

  it('works across resource types', () => {
    for (const type of ['rds_instance', 's3_bucket', 'lambda_function']) {
      const r = makeResource({ type, tags: { Name: 'test' } });
      expect(checkTAG001(r, cfg)!.resourceType).toBe(type);
    }
  });
});

// ─── TAG-002: Completely untagged resource ────────────────────────────────────

describe('checkTAG002 — completely untagged resource', () => {
  it('fires with correct fields, config placeholders, and content', () => {
    const r = makeResource({ name: 'orphaned-worker', type: 's3_bucket', tags: {} });
    const rec = checkTAG002(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('TAG-002');
    expect(rec!.confidence).toBe(1.0);
    expect(rec!.estimatedSavings).toBe(0);
    expect(rec!.currentConfig).toMatchObject({ tag_count: 0 });
    expect(rec!.impact).toBe('low');
    expect(rec!.risk).toBe('low');
    expect(rec!.title).toContain('s3_bucket');
    expect(rec!.title).toContain('orphaned-worker');
    const suggested = rec!.suggestedConfig as { tags: Record<string, string> };
    expect(suggested.tags).toHaveProperty('Environment');
    expect(suggested.tags).toHaveProperty('Team');
    expect(suggested.tags).toHaveProperty('Project');
    expect(rec!.patchContent).toContain('Environment');
    expect(rec!.implementationSteps.join(' ')).toContain('orphaned-worker');
  });

  it('does not fire when resource has any tag', () => {
    expect(checkTAG002(makeResource({ tags: { Name: 'anything' } }), cfg)).toBeNull();
    expect(checkTAG002(makeResource({ tags: { Environment: 'production', Team: 'platform', Project: 'korinfra' } }), cfg)).toBeNull();
  });

  it('works across resource types', () => {
    for (const type of ['rds_instance', 'lambda_function', 'ecs_service', 'elasticache_cluster']) {
      const rec = checkTAG002(makeResource({ type, tags: {} }), cfg);
      expect(rec!.ruleId).toBe('TAG-002');
    }
  });
});
