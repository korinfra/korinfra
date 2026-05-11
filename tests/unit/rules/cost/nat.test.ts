import { describe, it, expect } from 'vitest';
import { checkNET001, checkNAT001 } from '../../../../src/rules/cost/nat.js';
import { THRESHOLDS } from '../../../../src/rules/config.js';
import type { Resource } from '../../../../src/aws/types.js';

const cfg = THRESHOLDS;

function makeNAT(overrides: Partial<Resource> = {}): Resource {
  return {
    id: 'nat-0a1b2c3d4e5f67890',
    arn: 'arn:aws:ec2:us-east-1:123456789012:natgateway/nat-0a1b2c3d4e5f67890',
    type: 'nat_gateway',
    name: 'main-nat',
    region: 'us-east-1',
    state: 'available',
    instanceType: '',
    tags: { Environment: 'prod', Name: 'main-nat' },
    launchTime: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    collectedAt: new Date().toISOString(),
    configuration: { monthlyCost: 45 },
    ...overrides,
  };
}

function makeUtil(networkInMB: number, networkOutMB = 0, period: '7d' | '30d' = '30d') {
  return {
    period,
    cpuAverage: 0, cpuMax: 0, cpuP95: 0, cpuP99: 0,
    memoryAverage: 0, memoryMax: 0, memoryP95: 0,
    networkInMB, networkOutMB,
    diskReadIOPS: 0, diskWriteIOPS: 0,
    connectionCount: 0, connectionCountMax: 0,
    dataPoints: 720, dataGaps: 0, freshnessHrs: 1,
  };
}

// ─── NET-001: Low-traffic NAT Gateway ─────────────────────────────────────────

describe('checkNET001 — low-traffic NAT Gateway', () => {
  it('fires when total traffic < 1 GB with 70% savings and correct fields', () => {
    // 200 MB traffic (well below 1 GB threshold)
    const rec = checkNET001(makeNAT({ utilization: makeUtil(200, 0), configuration: { monthlyCost: 45 } }), cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('NET-001');
    expect(rec!.suggestedAction).toBe('replace_with_nat_instance');

    // 600 MB < 1 GB threshold
    expect(checkNET001(makeNAT({ utilization: makeUtil(400, 200), configuration: { monthlyCost: 45 } }), cfg)).not.toBeNull();
    // 500 MB in only
    expect(checkNET001(makeNAT({ utilization: makeUtil(500, 0), configuration: { monthlyCost: 45 } }), cfg)).not.toBeNull();

    // 70% savings
    expect(checkNET001(makeNAT({ utilization: makeUtil(100, 50), configuration: { monthlyCost: 45 } }), cfg)!.estimatedSavings).toBeCloseTo(31.5, 1);
  });

  it('does not fire when traffic >= 1 GB or wrong resource type', () => {
    expect(checkNET001(makeNAT({ utilization: makeUtil(512, 512), configuration: { monthlyCost: 50 } }), cfg)).toBeNull();
    expect(checkNET001(makeNAT({ utilization: makeUtil(2560, 2560), configuration: { monthlyCost: 80 } }), cfg)).toBeNull();
    expect(checkNET001(makeNAT({ type: 'internet_gateway', configuration: { monthlyCost: 0 } }), cfg)).toBeNull();
    expect(checkNET001(makeNAT({ type: 'vpn_gateway', configuration: { monthlyCost: 40 } }), cfg)).toBeNull();
  });
});

// ─── NAT-001: VPC endpoint candidate ─────────────────────────────────────────

describe('checkNAT001 — NAT Gateway candidate for VPC endpoint replacement', () => {
  it('fires when traffic is between 1 GB and 5 GB with 40% savings and S3/DynamoDB endpoints', () => {
    // exactly 1 GB boundary
    const r1 = makeNAT({ utilization: makeUtil(512, 512), configuration: { monthlyCost: 50 } });
    const rec1 = checkNAT001(r1, cfg);
    expect(rec1).not.toBeNull();
    expect(rec1!.ruleId).toBe('NAT-001');
    expect(rec1!.suggestedAction).toBe('add_vpc_endpoints');

    // 2 GB
    expect(checkNAT001(makeNAT({ utilization: makeUtil(1024, 1024), configuration: { monthlyCost: 60 } }), cfg)!.estimatedSavings).toBeCloseTo(24, 1);

    // suggests S3 and DynamoDB endpoints
    expect(checkNAT001(makeNAT({ utilization: makeUtil(1500, 1500), configuration: { monthlyCost: 65 } }), cfg)!.suggestedConfig).toMatchObject({ add_vpc_endpoints: ['s3', 'dynamodb'] });

    // 4.9 GB — just below upper threshold
    expect(checkNAT001(makeNAT({ utilization: makeUtil(2509, 2509), configuration: { monthlyCost: 70 } }), cfg)).not.toBeNull();
  });

  it('does not fire below 1 GB, >= 5 GB, no utilization, or wrong type', () => {
    expect(checkNAT001(makeNAT({ utilization: makeUtil(256, 256), configuration: { monthlyCost: 45 } }), cfg)).toBeNull();
    expect(checkNAT001(makeNAT({ utilization: makeUtil(5120, 5120), configuration: { monthlyCost: 120 } }), cfg)).toBeNull();
    expect(checkNAT001(makeNAT({ configuration: { monthlyCost: 45 } }), cfg)).toBeNull();
    expect(checkNAT001(makeNAT({ type: 'ec2_instance', utilization: makeUtil(1500, 1500) }), cfg)).toBeNull();
  });
});

// ─── Period normalization ─────────────────────────────────────────────────────

describe('NET-001 / NAT-001 — period normalization', () => {
  it('normalizes 7d raw MB to monthly rate before threshold comparison', () => {
    // 56 MB in 7d → 56 * (30/7) ≈ 240 MB/mo → well below 1 GB → NET-001 fires
    const lowRaw7d = makeNAT({ utilization: makeUtil(28, 28, '7d'), configuration: { monthlyCost: 45 } });
    expect(checkNET001(lowRaw7d, cfg)).not.toBeNull();
    expect(checkNAT001(lowRaw7d, cfg)).toBeNull();

    // 250 MB total (125+125) in 7d → 250 * (30/7) ≈ 1071 MB/mo ≈ 1.047 GB → NAT-001 fires
    const midRaw7d = makeNAT({ utilization: makeUtil(125, 125, '7d'), configuration: { monthlyCost: 55 } });
    expect(checkNET001(midRaw7d, cfg)).toBeNull();
    expect(checkNAT001(midRaw7d, cfg)).not.toBeNull();

    // 1200 MB each in 7d → (2400) * (30/7) ≈ 10285 MB/mo ≈ 10 GB → neither fires
    const highRaw7d = makeNAT({ utilization: makeUtil(1200, 1200, '7d'), configuration: { monthlyCost: 150 } });
    expect(checkNET001(highRaw7d, cfg)).toBeNull();
    expect(checkNAT001(highRaw7d, cfg)).toBeNull();
  });
});

// ─── NET-001 vs NAT-001 boundary conditions ────────────────────────────────────

describe('NET-001 vs NAT-001 — boundary between rules', () => {
  it('correctly partitions traffic: < 1 GB fires NET-001, 1-5 GB fires NAT-001, > 5 GB fires neither', () => {
    const low = makeNAT({ utilization: makeUtil(256, 256), configuration: { monthlyCost: 45 } });
    expect(checkNET001(low, cfg)).not.toBeNull();
    expect(checkNAT001(low, cfg)).toBeNull();

    const mid = makeNAT({ utilization: makeUtil(1024, 1024), configuration: { monthlyCost: 55 } });
    expect(checkNET001(mid, cfg)).toBeNull();
    expect(checkNAT001(mid, cfg)).not.toBeNull();

    const high = makeNAT({ utilization: makeUtil(5120, 5120), configuration: { monthlyCost: 150 } });
    expect(checkNET001(high, cfg)).toBeNull();
    expect(checkNAT001(high, cfg)).toBeNull();
  });
});
