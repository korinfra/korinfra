import { describe, it, expect } from 'vitest';
import { detectConfigDiffs, filterConfigDiffsBySeverity, severityLevel } from '../../../src/classifier/config-diff.js';
import type { MatchedPair } from '../../../src/classifier/types.js';
import type { Resource } from '../../../src/aws/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAWSResource(cfg: Record<string, unknown>, overrides: Partial<Resource> = {}): Resource {
  return {
    id: 'i-abc123',
    arn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-abc123',
    type: 'ec2_instance',
    name: 'web',
    region: 'us-east-1',
    state: 'running',
    instanceType: 't3.medium',
    tags: {},
    launchTime: '2024-01-01T00:00:00Z',
    collectedAt: '2024-01-10T00:00:00Z',
    configuration: cfg,
    ...overrides,
  };
}

function makeEC2Pair(tfCfg: Record<string, unknown>, awsCfg: Record<string, unknown>): MatchedPair {
  return {
    terraform: {
      address: 'aws_instance.web',
      type: 'aws_instance',
      name: 'web',
      provider: 'aws',
      module: '',
      filePath: 'main.tf',
      lineNumber: 1,
      configuration: tfCfg,
      estimatedCost: 0,
      dependencies: [],
    },
    aws: makeAWSResource(awsCfg),
    confidence: 1.0,
    matchType: 'arn',
    configDiffs: [],
  };
}

function makeRDSPair(tfCfg: Record<string, unknown>, awsCfg: Record<string, unknown>): MatchedPair {
  return {
    ...makeEC2Pair(tfCfg, awsCfg),
    terraform: {
      address: 'aws_db_instance.main',
      type: 'aws_db_instance',
      name: 'main',
      provider: 'aws',
      module: '',
      filePath: 'main.tf',
      lineNumber: 1,
      configuration: tfCfg,
      estimatedCost: 0,
      dependencies: [],
    },
    aws: makeAWSResource(awsCfg, { type: 'rds_instance' }),
  };
}

// ─── severityLevel ────────────────────────────────────────────────────────────

describe('severityLevel', () => {
  it('maps severity strings to numeric levels', () => {
    expect(severityLevel('critical')).toBe(4);
    expect(severityLevel('high')).toBe(3);
    expect(severityLevel('medium')).toBe(2);
    expect(severityLevel('low')).toBe(1);
    expect(severityLevel('none')).toBe(0);
  });
});

// ─── EC2 drift detection ──────────────────────────────────────────────────────

describe('detectConfigDiffs — EC2', () => {
  it('detects typed field config diffs at correct severities', () => {
    // instance_type → high
    const [r1] = detectConfigDiffs([makeEC2Pair({ instance_type: 't3.medium' }, { instance_type: 't3.large' })]);
    const instanceDiff = r1.configDiffs.find((d) => d.field === 'instance_type');
    expect(instanceDiff?.severity).toBe('high');
    expect(instanceDiff?.tfValue).toBe('t3.medium');
    expect(instanceDiff?.awsValue).toBe('t3.large');

    // ami → high
    const [r2] = detectConfigDiffs([makeEC2Pair({ ami: 'ami-old' }, { ami: 'ami-new' })]);
    expect(r2.configDiffs.find((d) => d.field === 'ami')?.severity).toBe('high');

    // monitoring → medium
    const [r3] = detectConfigDiffs([makeEC2Pair({ monitoring: true }, { monitoring: false })]);
    expect(r3.configDiffs.find((d) => d.field === 'monitoring')?.severity).toBe('medium');

    // tags → low
    const [r4] = detectConfigDiffs([makeEC2Pair({ tags: { Env: 'prod' } }, { tags: { Env: 'staging' } })]);
    expect(r4.configDiffs.find((d) => d.field === 'tags')?.severity).toBe('low');
  });

  it('returns no config diffs for identical fields or absent fields', () => {
    const [r1] = detectConfigDiffs([makeEC2Pair(
      { instance_type: 't3.medium', ami: 'ami-12345', monitoring: false },
      { instance_type: 't3.medium', ami: 'ami-12345', monitoring: false },
    )]);
    expect(r1.configDiffs).toHaveLength(0);

    const [r2] = detectConfigDiffs([makeEC2Pair({}, {})]);
    expect(r2.configDiffs).toHaveLength(0);
  });

  it('processes multiple pairs independently', () => {
    const [changed, same] = detectConfigDiffs([
      makeEC2Pair({ instance_type: 't3.medium' }, { instance_type: 't3.large' }),
      makeEC2Pair({ instance_type: 't3.small' }, { instance_type: 't3.small' }),
    ]);
    expect(changed.configDiffs.length).toBeGreaterThan(0);
    expect(same.configDiffs).toHaveLength(0);
  });
});

// ─── RDS drift detection ──────────────────────────────────────────────────────

describe('detectConfigDiffs — RDS', () => {
  it('detects RDS field config diffs at correct severities and normalizes booleans', () => {
    // instance_class → high
    const [r1] = detectConfigDiffs([makeRDSPair({ instance_class: 'db.t3.medium' }, { instance_class: 'db.t3.large' })]);
    expect(r1.configDiffs.find((d) => d.field === 'instance_class')?.severity).toBe('high');

    // multi_az → high, boolean values stringified
    const [r2] = detectConfigDiffs([makeRDSPair({ multi_az: true }, { multi_az: false })]);
    const multiAzDiff = r2.configDiffs.find((d) => d.field === 'multi_az');
    expect(multiAzDiff?.severity).toBe('high');
    expect(multiAzDiff?.tfValue).toBe('true');
    expect(multiAzDiff?.awsValue).toBe('false');

    // same boolean: no config diff
    const [r3] = detectConfigDiffs([makeRDSPair({ storage_encrypted: true }, { storage_encrypted: true })]);
    expect(r3.configDiffs.find((d) => d.field === 'storage_encrypted')).toBeUndefined();

    // engine_version → medium
    const [r4] = detectConfigDiffs([makeRDSPair({ engine_version: '8.0.28' }, { engine_version: '8.0.32' })]);
    expect(r4.configDiffs.find((d) => d.field === 'engine_version')?.severity).toBe('medium');
  });
});

// ─── Value normalization ──────────────────────────────────────────────────────

describe('detectConfigDiffs — value normalization', () => {
  it('sorts arrays before comparing, detects diff content, is case-insensitive', () => {
    // array order: no config diff
    const [r1] = detectConfigDiffs([makeEC2Pair(
      { vpc_security_group_ids: ['sg-bbb', 'sg-aaa'] },
      { security_groups: ['sg-aaa', 'sg-bbb'] },
    )]);
    expect(r1.configDiffs.find((d) => d.field === 'vpc_security_group_ids')).toBeUndefined();

    // different array contents: config diff
    const [r2] = detectConfigDiffs([makeEC2Pair(
      { vpc_security_group_ids: ['sg-aaa'] },
      { security_groups: ['sg-bbb'] },
    )]);
    expect(r2.configDiffs.find((d) => d.field === 'vpc_security_group_ids')).toBeDefined();

    // case-insensitive: no config diff
    const [r3] = detectConfigDiffs([makeEC2Pair({ ami: 'AMI-12345' }, { ami: 'ami-12345' })]);
    expect(r3.configDiffs.find((d) => d.field === 'ami')).toBeUndefined();
  });
});

// ─── filterDriftBySeverity ────────────────────────────────────────────────────

describe('filterConfigDiffsBySeverity', () => {
  const diffs = [
    { field: 'a', tfValue: '1', awsValue: '2', severity: 'critical' as const },
    { field: 'b', tfValue: '1', awsValue: '2', severity: 'high' as const },
    { field: 'c', tfValue: '1', awsValue: '2', severity: 'medium' as const },
    { field: 'd', tfValue: '1', awsValue: '2', severity: 'low' as const },
  ];

  it('filters by minimum severity threshold', () => {
    expect(filterConfigDiffsBySeverity(diffs, 'critical')).toHaveLength(1);
    expect(filterConfigDiffsBySeverity(diffs, 'high')).toHaveLength(2);
    expect(filterConfigDiffsBySeverity(diffs, 'medium')).toHaveLength(3);
    expect(filterConfigDiffsBySeverity(diffs, 'low')).toHaveLength(4);
  });
});

// ─── AWS defaults suppression ──────────────────────────────────────────────────

describe('detectConfigDiffs — AWS defaults suppression', () => {
  it('suppresses config diff when TF field absent and AWS value = known default', () => {
    // monitoring is missing in TF, AWS has false (the default)
    const [r] = detectConfigDiffs([makeEC2Pair(
      {}, // TF side: no monitoring field
      { monitoring: false }, // AWS side: monitoring is false (default)
    )]);
    expect(r.configDiffs.find((d) => d.field === 'monitoring')).toBeUndefined();
  });

  it('reports config diff when TF field absent but AWS value != known default', () => {
    // monitoring is missing in TF, AWS has true (non-default)
    const [r] = detectConfigDiffs([makeEC2Pair(
      {}, // TF side: no monitoring field
      { monitoring: true }, // AWS side: monitoring is true (non-default)
    )]);
    expect(r.configDiffs.find((d) => d.field === 'monitoring')).toBeDefined();
  });

  it('suppresses config diff for RDS defaults (multi_az, publicly_accessible, storage_encrypted)', () => {
    // All three default to false in RDS — if TF omits them and AWS has false, no config diff
    const [r] = detectConfigDiffs([makeRDSPair(
      {}, // TF: no defaults
      { multi_az: false, publicly_accessible: false, storage_encrypted: false }, // AWS: all defaults
    )]);
    expect(r.configDiffs).toHaveLength(0);
  });

  it('reports config diff for RDS when AWS has non-default values despite TF omission', () => {
    // TF omits multi_az, but AWS has true (non-default)
    const [r] = detectConfigDiffs([makeRDSPair(
      {}, // TF: empty
      { multi_az: true }, // AWS: true (non-default)
    )]);
    expect(r.configDiffs.find((d) => d.field === 'multi_az')).toBeDefined();
  });
});

// ─── ECS desired_count auto-scaling severity downgrade ───────────────────────────

describe('detectConfigDiffs — ECS desired_count severity downgrade', () => {
  function makeECSPair(tfCfg: Record<string, unknown>, awsCfg: Record<string, unknown>): MatchedPair {
    return {
      terraform: {
        address: 'aws_ecs_service.app',
        type: 'aws_ecs_service',
        name: 'app',
        provider: 'aws',
        module: '',
        filePath: 'main.tf',
        lineNumber: 1,
        configuration: tfCfg,
        estimatedCost: 0,
        dependencies: [],
      },
      aws: makeAWSResource(awsCfg, { type: 'ecs_service' }),
      confidence: 1.0,
      matchType: 'arn',
      configDiffs: [],
    };
  }

  it('downgrades desired_count severity to low for REPLICA scheduling strategy', () => {
    const [r] = detectConfigDiffs([makeECSPair(
      { desired_count: 2 },
      { desired_count: 3, scheduling_strategy: 'REPLICA' }, // auto-scaling adjusts live count
    )]);
    const desiredCountDiff = r.configDiffs.find((d) => d.field === 'desired_count');
    expect(desiredCountDiff).toBeDefined();
    expect(desiredCountDiff!.severity).toBe('low');
    expect(desiredCountDiff!.note).toContain('auto-scaling');
  });

  it('does not downgrade for non-REPLICA scheduling or other services', () => {
    // DAEMON strategy: config diff stays at original severity (medium)
    const [r1] = detectConfigDiffs([makeECSPair(
      { desired_count: 1 },
      { desired_count: 2, scheduling_strategy: 'DAEMON' },
    )]);
    const desiredCountDiff1 = r1.configDiffs.find((d) => d.field === 'desired_count');
    expect(desiredCountDiff1?.severity).toBe('medium'); // original severity
  });
});
