import { describe, it, expect } from 'vitest';
import { classifyResources, normalizeType, tfTypeForAWS, tfTypesForAWS } from '../../../src/classifier/matcher.js';
import type { Resource } from '../../../src/aws/types.js';
import type { TerraformResource, StateResource } from '../../../src/classifier/types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeAWS(overrides: Partial<Resource> = {}): Resource {
  return {
    id: 'i-abc123',
    arn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-abc123',
    type: 'ec2_instance',
    name: 'web',
    region: 'us-east-1',
    state: 'running',
    instanceType: 't3.medium',
    tags: { Name: 'web' },
    launchTime: '2024-01-01T00:00:00Z',
    collectedAt: '2024-01-10T00:00:00Z',
    configuration: { instance_type: 't3.medium', ami: 'ami-12345678', subnet_id: 'subnet-abc' },
    ...overrides,
  };
}

function makeTF(overrides: Partial<TerraformResource> = {}): TerraformResource {
  return {
    address: 'aws_instance.web',
    type: 'aws_instance',
    name: 'web',
    provider: 'aws',
    module: '',
    filePath: 'main.tf',
    lineNumber: 1,
    configuration: { instance_type: 't3.medium', ami: 'ami-12345678', subnet_id: 'subnet-abc' },
    estimatedCost: 0,
    dependencies: [],
    ...overrides,
  };
}

function makeState(overrides: Partial<StateResource> = {}): StateResource {
  return {
    type: 'aws_instance',
    name: 'web',
    provider: 'aws',
    id: 'i-abc123',
    arn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-abc123',
    attributes: {},
    ...overrides,
  };
}

// ─── normalizeType and tfTypeForAWS ───────────────────────────────────────────

describe('normalizeType and tfTypeForAWS', () => {
  it('normalizes known TF types to canonical names', () => {
    expect(normalizeType('aws_instance')).toBe('ec2_instance');
    expect(normalizeType('aws_db_instance')).toBe('rds_instance');
    expect(normalizeType('aws_lb')).toBe('load_balancer');
    expect(normalizeType('aws_alb')).toBe('load_balancer');
    expect(normalizeType('aws_nat_gateway')).toBe('nat_gateway');
    expect(normalizeType('aws_s3_bucket')).toBe('s3_bucket');
    expect(normalizeType('aws_some_new_service')).toBe('some_new_service');
  });

  it('reverses normalizeType and falls back for unknowns', () => {
    expect(tfTypeForAWS('ec2_instance')).toBe('aws_instance');
    expect(tfTypeForAWS('rds_instance')).toBe('aws_db_instance');
    expect(tfTypeForAWS('unknown_thing')).toBe('aws_unknown_thing');
  });

  it('tfTypeForAWS returns canonical (shorter) type for multi-mapping normalized types', () => {
    expect(tfTypeForAWS('load_balancer')).toBe('aws_lb');
  });

  it('tfTypeForAWS falls back to aws_ prefix for unknown types', () => {
    expect(tfTypeForAWS('unknown_type')).toBe('aws_unknown_type');
  });

  it('tfTypesForAWS returns all matching types for load_balancer', () => {
    const types = tfTypesForAWS('load_balancer');
    expect(types).toContain('aws_lb');
    expect(types).toContain('aws_alb');
  });

  it('tfTypesForAWS returns single-element array for types with one mapping', () => {
    expect(tfTypesForAWS('ec2_instance')).toEqual(['aws_instance']);
  });
});

// ─── classifyResources — matching passes ──────────────────────────────────────

describe('classifyResources — matching passes', () => {
  it('Pass 1: matches via ARN with confidence 1.0', () => {
    const result = classifyResources([makeAWS()], [makeTF()], [makeState()]);
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].confidence).toBe(1.0);
    expect(result.matched[0].matchType).toBe('arn');
    expect(result.terraformOnly).toHaveLength(0);
    expect(result.awsOnly).toHaveLength(0);
  });

  it('Pass 1: type mismatch prevents ARN match', () => {
    const result = classifyResources([makeAWS({ type: 'rds_instance' })], [makeTF()], [makeState()]);
    expect(result.matched).toHaveLength(0);
  });

  it('Pass 2: matches via state ID with confidence 0.95', () => {
    const aws = makeAWS({ arn: undefined as unknown as string });
    const state: StateResource = { ...makeState(), arn: '' };
    const result = classifyResources([aws], [makeTF()], [state]);
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].confidence).toBe(0.95);
    expect(result.matched[0].matchType).toBe('id');
  });

  it('Pass 2: matches via TF config id field with confidence 0.9', () => {
    const aws = makeAWS({ arn: undefined as unknown as string });
    const tf = makeTF({ configuration: { id: 'i-abc123', instance_type: 't3.medium' } });
    const result = classifyResources([aws], [tf]);
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].confidence).toBe(0.9);
    expect(result.matched[0].matchType).toBe('id');
  });

  it('Pass 3: matches via name with confidence 0.6, case-insensitive', () => {
    const aws = makeAWS({ id: 'i-different', arn: undefined as unknown as string });
    const result = classifyResources([aws], [makeTF({ configuration: {} })]);
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].confidence).toBe(0.6);
    expect(result.matched[0].matchType).toBe('name');

    // Name tag case-insensitive
    const awsUpper = makeAWS({ id: 'i-different', arn: undefined as unknown as string, name: '', tags: { Name: 'WEB' } });
    const resultUpper = classifyResources([awsUpper], [makeTF({ name: 'web', configuration: {} })]);
    expect(resultUpper.matched).toHaveLength(1);
    expect(resultUpper.matched[0].confidence).toBe(0.6);
  });

  it('Pass 4: fuzzy match fires when all comparable fields match', () => {
    // AWS and TF share instance_type + ami + subnet_id (3/3 comparable fields present on both)
    // → configSimilarity = 1.0 ≥ default threshold 0.7 → should match via fuzzy pass
    const aws = makeAWS({
      id: 'i-other',
      arn: undefined as unknown as string,
      name: 'totally-different',
      tags: { Name: 'totally-different' },
      configuration: { instance_type: 't3.medium', ami: 'ami-12345678', subnet_id: 'subnet-abc' },
    });
    const tf = makeTF({ name: 'other', configuration: { instance_type: 't3.medium', ami: 'ami-12345678', subnet_id: 'subnet-abc' } });
    const result = classifyResources([aws], [tf]);
    // Guard removed — fixture guarantees a fuzzy match
    expect(result.matched.length).toBeGreaterThan(0);
    expect(result.matched[0].matchType).toBe('fuzzy');
    expect(result.matched[0].confidence).toBeLessThanOrEqual(0.42);
  });

  it('Pass 4: no match when no comparable fields are shared', () => {
    // AWS and TF have completely different configuration values
    // → configSimilarity = 0 < threshold 0.7 → no fuzzy match
    const aws = makeAWS({
      id: 'i-other',
      arn: undefined as unknown as string,
      name: 'totally-different',
      tags: { Name: 'totally-different' },
      configuration: { instance_type: 't2.nano', ami: 'ami-99999999', subnet_id: 'subnet-xyz' },
    });
    const tf = makeTF({ name: 'other', configuration: { instance_type: 't3.medium', ami: 'ami-12345678', subnet_id: 'subnet-abc' } });
    const result = classifyResources([aws], [tf]);
    expect(result.matched.length).toBe(0);
  });
});

// ─── Conservative defaults and deduplication ─────────────────────────────────

describe('classifyResources — conservative defaults and deduplication', () => {
  it('puts unmatched TF resources in terraformOnly (Scenario A)', () => {
    const result = classifyResources([], [makeTF()]);
    expect(result.terraformOnly).toHaveLength(1);
    expect(result.matched).toHaveLength(0);
    expect(result.awsOnly).toHaveLength(0);
  });

  it('puts unmatched AWS resources in awsOnly (Scenario C)', () => {
    const result = classifyResources([makeAWS()], []);
    expect(result.awsOnly).toHaveLength(1);
    expect(result.matched).toHaveLength(0);
    expect(result.terraformOnly).toHaveLength(0);
  });

  it('returns empty result for no inputs', () => {
    const result = classifyResources([], []);
    expect(result.matched).toHaveLength(0);
    expect(result.terraformOnly).toHaveLength(0);
    expect(result.awsOnly).toHaveLength(0);
  });

  it('deduplicates AWS resources with same type+id+region', () => {
    const result = classifyResources([makeAWS(), makeAWS()], []);
    expect(result.awsOnly).toHaveLength(1);
  });
});
