import { describe, it, expect } from 'vitest';
import {
  generateScenarioRecommendations,
  generateConfigDiffRecommendations,
  confidenceLevel,
  summarize,
} from '../../../src/classifier/scenarios.js';
import type { Classification, MatchedPair, TerraformResource } from '../../../src/classifier/types.js';
import type { Resource } from '../../../src/aws/types.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeTF(overrides: Partial<TerraformResource> = {}): TerraformResource {
  return {
    address: 'aws_instance.web',
    type: 'aws_instance',
    name: 'web',
    provider: 'aws',
    module: '',
    filePath: '/infra/main.tf',
    lineNumber: 10,
    configuration: {
      ami: 'ami-0abcdef1234567890',
      instance_type: 't3.micro',
      vpc_security_group_ids: ['sg-12345'],
    },
    dependencies: [],
    ...overrides,
  };
}

function makeAWS(overrides: Partial<Resource> = {}): Resource {
  return {
    id: 'i-0abc123',
    arn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-0abc123',
    type: 'ec2_instance',
    name: 'web-server',
    region: 'us-east-1',
    state: 'running',
    instanceType: 'm5.large',
    tags: { Name: 'web-server', Environment: 'prod' },
    launchTime: '2024-03-01T00:00:00Z',
    collectedAt: '2024-04-01T00:00:00Z',
    configuration: { monthlyCost: 156.82 },
    ...overrides,
  };
}

function emptyClassification(): Classification {
  return { matched: [], terraformOnly: [], awsOnly: [] };
}

// ─── confidenceLevel ─────────────────────────────────────────────────────────

describe('confidenceLevel', () => {
  it('maps score ranges to labels', () => {
    // high >= 0.9
    expect(confidenceLevel(0.9)).toBe('high');
    expect(confidenceLevel(1.0)).toBe('high');
    // medium >= 0.7 and < 0.9
    expect(confidenceLevel(0.7)).toBe('medium');
    expect(confidenceLevel(0.89)).toBe('medium');
    // low < 0.7
    expect(confidenceLevel(0.0)).toBe('low');
    expect(confidenceLevel(0.69)).toBe('low');
  });
});

// ─── Scenario A: TF-only resources ───────────────────────────────────────────

describe('generateScenarioRecommendations — Scenario A (destroyed in AWS)', () => {
  it('generates a correct recommendation for destroyed resource', () => {
    const tf = makeTF({ destroyedInAws: true });
    const c = { ...emptyClassification(), terraformOnly: [tf] };
    const recs = generateScenarioRecommendations(c);

    expect(recs).toHaveLength(1);
    const rec = recs[0]!;
    expect(rec.scenario).toBe('A');
    expect(rec.resourceId).toBe('aws_instance.web');
    expect(rec.resourceType).toBe('ec2_instance');
    expect(rec.type).toBe('config_diff');
    expect(rec.title).toContain('destroyed outside Terraform');
    const steps = rec.implementationSteps ?? [];
    expect(steps.some((s) => s.includes('terraform refresh'))).toBe(true);
    expect(steps.some((s) => s.includes('terraform state rm'))).toBe(true);
  });

  it('skips non-destroyed Scenario A resources', () => {
    const tf = makeTF();
    const c = { ...emptyClassification(), terraformOnly: [tf] };
    const recs = generateScenarioRecommendations(c);

    // Non-destroyed resources are skipped
    expect(recs).toHaveLength(0);
  });

  it('handles S3 sub-resource types', () => {
    const s3SubRes = makeTF({ type: 'aws_s3_bucket_versioning', destroyedInAws: true });
    const c = { ...emptyClassification(), terraformOnly: [s3SubRes] };
    const recs = generateScenarioRecommendations(c);

    // S3 sub-resource types are skipped
    expect(recs).toHaveLength(0);
  });
});

// ─── Scenario B: Matched resources ───────────────────────────────────────────

describe('generateConfigDiffRecommendations — Scenario B', () => {
  it('generates recommendation for high/critical config diff, skips low/medium, empty for no diffs', () => {
    const highPair: MatchedPair = {
      terraform: makeTF(),
      aws: makeAWS(),
      confidence: 0.95,
      matchType: 'arn',
      configDiffs: [{ field: 'instance_type', tfValue: 't3.micro', awsValue: 'm5.large', severity: 'high' }],
    };
    const recs = generateConfigDiffRecommendations([highPair]);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.scenario).toBe('B');
    expect(recs[0]!.type).toBe('config_diff');
    expect(recs[0]!.title).toContain('instance_type');
    expect(recs[0]!.description).toContain('t3.micro');
    expect(recs[0]!.description).toContain('m5.large');
    const steps = recs[0]!.implementationSteps ?? [];
    expect(steps.some((s) => s.includes('terraform plan'))).toBe(true);
    expect(steps.some((s) => s.includes('terraform apply'))).toBe(true);

    // critical config diff also produces a rec
    const critPair: MatchedPair = { ...highPair, configDiffs: [{ field: 'vpc_id', tfValue: 'vpc-11111', awsValue: 'vpc-99999', severity: 'critical' }] };
    expect(generateConfigDiffRecommendations([critPair])).toHaveLength(1);

    // low+medium config diff: skipped
    const lowPair: MatchedPair = {
      ...highPair,
      configDiffs: [
        { field: 'tags', tfValue: 'env=dev', awsValue: 'env=staging', severity: 'low' },
        { field: 'monitoring', tfValue: 'false', awsValue: 'true', severity: 'medium' },
      ],
    };
    expect(generateConfigDiffRecommendations([lowPair])).toHaveLength(0);

    // no config diff: empty
    const noDiffPair: MatchedPair = { ...highPair, configDiffs: [] };
    expect(generateConfigDiffRecommendations([noDiffPair])).toHaveLength(0);
  });
});

// ─── Scenario C: AWS-only resources ──────────────────────────────────────────
// Scenario C resources are covered by evaluate_rules cost recs — no awareness
// recs generated here to avoid duplicate noise.

describe('generateScenarioRecommendations — Scenario C', () => {
  it('generates no recommendations for AWS-only resources', () => {
    const aws = makeAWS({ configuration: { monthlyCost: 156.82 } });
    const c = { ...emptyClassification(), awsOnly: [aws] };
    expect(generateScenarioRecommendations(c)).toHaveLength(0);
  });
});

// ─── summarize ───────────────────────────────────────────────────────────────

describe('summarize', () => {
  it('counts all scenario buckets, config diffs, and confidence tiers', () => {
    const tf = makeTF();
    const aws = makeAWS();
    const pairWithDiff: MatchedPair = {
      terraform: makeTF({ address: 'aws_instance.app' }),
      aws: makeAWS({ id: 'i-matched' }),
      confidence: 0.95,
      matchType: 'arn',
      configDiffs: [{ field: 'instance_type', tfValue: 't3.micro', awsValue: 'm5.large', severity: 'high' }],
    };
    const pairNoDiff: MatchedPair = {
      terraform: makeTF({ address: 'aws_instance.db' }),
      aws: makeAWS({ id: 'i-2' }),
      confidence: 0.4,
      matchType: 'fuzzy',
      configDiffs: [],
    };

    const c: Classification = { matched: [pairWithDiff, pairNoDiff], terraformOnly: [tf], awsOnly: [aws] };
    const summary = summarize(c);

    expect(summary.totalResources).toBe(4);
    expect(summary.scenarioACount).toBe(1);
    expect(summary.scenarioBCount).toBe(2);
    expect(summary.scenarioCCount).toBe(1);
    expect(summary.configDiffCount).toBe(1);
    expect(summary.highConfidence).toBe(1); // pairWithDiff at 0.95
    expect(summary.lowConfidence).toBe(1); // pairNoDiff at 0.4
  });
});

// ─── destroyedInAws fixture (Scenario A edge case) ─────────────────────────────

describe('generateScenarioRecommendations — destroyedInAws', () => {
  it('generates distinct recommendation for TF resource destroyed in AWS', () => {
    const tfDestroyed = makeTF({ destroyedInAws: true });
    const c = { ...emptyClassification(), terraformOnly: [tfDestroyed] };
    const recs = generateScenarioRecommendations(c);

    expect(recs).toHaveLength(1);
    const rec = recs[0]!;
    expect(rec.scenario).toBe('A');
    expect(rec.type).toBe('config_diff');
    expect(rec.title).toContain('destroyed outside Terraform');
    expect(rec.description).toContain('state file');
    expect(rec.description).toContain('terraform refresh');
  });
});

// ─── No recommendations for regular Scenario A ──────────────────────────────────

describe('generateScenarioRecommendations — regular Scenario A resources', () => {
  it('skips regular Scenario A resources (non-destroyed TF resources)', () => {
    const tfEmpty = makeTF({ configuration: {}, estimatedCost: 0 });
    const tfWithCfg = makeTF({ configuration: { instance_type: 't3.micro' }, estimatedCost: 50 });
    const c = { ...emptyClassification(), terraformOnly: [tfEmpty, tfWithCfg] };
    const recs = generateScenarioRecommendations(c);

    // Regular (non-destroyed) Scenario A resources are skipped.
    // Security recommendations for these come from generateTfSecurityRecommendations.
    expect(recs).toHaveLength(0);
  });
});
