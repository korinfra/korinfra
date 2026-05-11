import { describe, it, expect } from 'vitest';
import { estimateMonthlyCost } from '../../../src/pricing/engine.js';
import {
  HOURS_PER_MONTH,
  FALLBACK_EC2_PRICES,
  FALLBACK_RDS_PRICES,
  FALLBACK_ELASTICACHE_PRICES,
  EBS_GP3_PER_GB,
  EBS_IO1_PER_GB,
  EBS_IO1_IOPS_PRICE,
  EBS_SNAPSHOT_PER_GB,
  RDS_GP3_STORAGE_PER_GB,
  S3_STANDARD_PER_GB,
  NAT_GATEWAY_HOURLY,
  NAT_GATEWAY_PER_GB,
  EIP_HOURLY,
  DYNAMO_WCU_PER_MONTH,
  DYNAMO_RCU_PER_MONTH,
  DYNAMO_STORAGE_PER_GB,
  DYNAMO_FREE_STORAGE_GB,
} from '../../../src/pricing/resources.js';
import type { Resource } from '../../../src/aws/types.js';

function makeResource(overrides: Partial<Resource> & { type: string }): Resource {
  const hasConfiguration = Object.prototype.hasOwnProperty.call(overrides, 'configuration');

  return {
    id: 'r-001',
    arn: '',
    type: overrides.type,
    name: overrides.name ?? 'test',
    region: overrides.region ?? 'us-east-1',
    state: overrides.state ?? 'running',
    instanceType: overrides.instanceType ?? '',
    tags: {},
    launchTime: new Date().toISOString(),
    collectedAt: new Date().toISOString(),
    configuration: hasConfiguration ? overrides.configuration : {},
    utilization: overrides.utilization,
    ...overrides,
  } as Resource;
}

// ─── EC2 ─────────────────────────────────────────────────────────────────────

describe('estimateMonthlyCost — EC2', () => {
  it('known instances price at hourly * 730; unknown returns 0', async () => {
    expect(await estimateMonthlyCost(makeResource({ type: 'ec2_instance', instanceType: 'm5.large', configuration: { platform: 'Linux' } }))).toBeCloseTo(FALLBACK_EC2_PRICES['m5.large']! * HOURS_PER_MONTH, 1);
    expect(await estimateMonthlyCost(makeResource({ type: 'ec2_instance', instanceType: 't3.micro', configuration: { platform: 'Linux' } }))).toBeCloseTo(FALLBACK_EC2_PRICES['t3.micro']! * HOURS_PER_MONTH, 1);
    expect(await estimateMonthlyCost(makeResource({ type: 'ec2_instance', instanceType: 'x99.superlarge', configuration: {} }))).toBe(0);
  });
});

// ─── RDS ─────────────────────────────────────────────────────────────────────

describe('estimateMonthlyCost — RDS', () => {
  it('single-AZ, multi-AZ (2x), and storage surcharge all compute correctly', async () => {
    const singleAZ = await estimateMonthlyCost(makeResource({ type: 'rds_instance', instanceType: 'db.r6g.large', configuration: { engine: 'MySQL', multi_az: false, allocated_storage: 0 } }));
    expect(singleAZ).toBeCloseTo(FALLBACK_RDS_PRICES['db.r6g.large']! * HOURS_PER_MONTH, 0);

    const multiAZ = await estimateMonthlyCost(makeResource({ type: 'rds_instance', instanceType: 'db.r6g.large', configuration: { engine: 'MySQL', multi_az: true, allocated_storage: 0 } }));
    expect(multiAZ).toBeCloseTo(singleAZ * 2, 0);

    const withoutStorage = await estimateMonthlyCost(makeResource({ type: 'rds_instance', instanceType: 'db.t3.medium', configuration: { engine: 'MySQL', multi_az: false, allocated_storage: 0 } }));
    const withStorage = await estimateMonthlyCost(makeResource({ type: 'rds_instance', instanceType: 'db.t3.medium', configuration: { engine: 'MySQL', multi_az: false, allocated_storage: 100 } }));
    expect(withStorage - withoutStorage).toBeCloseTo(100 * RDS_GP3_STORAGE_PER_GB, 0);
  });
});

// ─── Lambda ───────────────────────────────────────────────────────────────────

describe('estimateMonthlyCost — Lambda', () => {
  it('respects free tiers, charges above-threshold usage, returns 0 for no invocations', async () => {
    const noInvocations = makeResource({ type: 'lambda_function', configuration: { memory_mb: 128 } });
    expect(await estimateMonthlyCost(noInvocations)).toBe(0);

    const makeUtil = (memoryMB: number, durationMs: number, invocations: number) => ({
      cpuAverage: 0, cpuMax: 0, cpuP95: 0, cpuP99: 0,
      memoryAverage: 0, memoryMax: 0, memoryP95: 0,
      invocations, networkInMB: 0, networkOutMB: 0,
      diskReadIOPS: 0, diskWriteIOPS: 0,
      connectionCount: 0, connectionCountMax: 0,
      dataPoints: 30, dataGaps: 0, freshnessHrs: 0,
      period: '30d' as const,
      avgDurationMs: durationMs,
    });

    // 1M invocations, 128MB, 200ms — both in free tier → $0
    const freeTier = makeResource({ type: 'lambda_function', configuration: { memory_mb: 128 }, utilization: makeUtil(128, 200, 1_000_000) });
    expect(await estimateMonthlyCost(freeTier)).toBe(0);

    // 10M invocations, 512MB, 200ms — non-trivial charge
    const highTraffic = makeResource({ type: 'lambda_function', configuration: { memory_mb: 512 }, utilization: makeUtil(512, 200, 10_000_000) });
    const cost = await estimateMonthlyCost(highTraffic);
    expect(cost).toBeGreaterThan(5);
    expect(cost).toBeLessThan(20);
  });
});

// ─── NAT Gateway, EBS, S3, ElastiCache, DynamoDB, EIP, unknown ───────────────

describe('estimateMonthlyCost — NAT Gateway', () => {
  it('base hourly cost + data processing charge', async () => {
    expect(await estimateMonthlyCost(makeResource({ type: 'nat_gateway', configuration: {} }))).toBeCloseTo(NAT_GATEWAY_HOURLY * HOURS_PER_MONTH, 1);

    const withData = makeResource({
      type: 'nat_gateway',
      configuration: {},
      utilization: {
        cpuAverage: 0, cpuMax: 0, cpuP95: 0, cpuP99: 0,
        memoryAverage: 0, memoryMax: 0, memoryP95: 0,
        networkInMB: 1024, networkOutMB: 0,
        diskReadIOPS: 0, diskWriteIOPS: 0,
        connectionCount: 0, connectionCountMax: 0,
        dataPoints: 30, dataGaps: 0, freshnessHrs: 0,
        period: '30d',
      },
    });
    expect(await estimateMonthlyCost(withData)).toBeCloseTo(NAT_GATEWAY_HOURLY * HOURS_PER_MONTH + NAT_GATEWAY_PER_GB, 1);
  });
});

describe('estimateMonthlyCost — EBS', () => {
  it('gp3, io1 volumes and ebs_snapshot priced correctly', async () => {
    expect(await estimateMonthlyCost(makeResource({ type: 'ebs_volume', configuration: { volume_type: 'gp3', size_gb: 100, iops: 0, throughput: 0 } }))).toBeCloseTo(100 * EBS_GP3_PER_GB, 2);
    expect(await estimateMonthlyCost(makeResource({ type: 'ebs_volume', configuration: { volume_type: 'io1', size_gb: 100, iops: 3000 } }))).toBeCloseTo(100 * EBS_IO1_PER_GB + 3000 * EBS_IO1_IOPS_PRICE, 2);
    expect(await estimateMonthlyCost(makeResource({ type: 'ebs_snapshot', configuration: { volume_size: 100 } }))).toBeCloseTo(100 * EBS_SNAPSHOT_PER_GB, 2);
  });
});

describe('estimateMonthlyCost — S3', () => {
  it('returns 0 for empty bucket; non-zero for populated STANDARD bucket', async () => {
    expect(await estimateMonthlyCost(makeResource({ type: 's3_bucket', configuration: { storage_class: 'STANDARD', size_gb: 0 } }))).toBe(0);
    expect(await estimateMonthlyCost(makeResource({ type: 's3_bucket', configuration: { storage_class: 'STANDARD', size_gb: 100 } }))).toBeCloseTo(100 * S3_STANDARD_PER_GB, 3);
  });

  it('handles missing configuration object without throwing', async () => {
    await expect(
      estimateMonthlyCost(makeResource({ type: 's3_bucket', configuration: undefined })),
    ).resolves.toBe(0);
  });
});

describe('estimateMonthlyCost — ElastiCache', () => {
  it('single node and 2-node cluster priced correctly', async () => {
    const single = await estimateMonthlyCost(makeResource({ type: 'elasticache_cluster', instanceType: 'cache.r6g.large', configuration: { num_cache_nodes: 1 } }));
    expect(single).toBeCloseTo(FALLBACK_ELASTICACHE_PRICES['cache.r6g.large']! * HOURS_PER_MONTH, 0);

    const multi = await estimateMonthlyCost(makeResource({ type: 'elasticache_cluster', instanceType: 'cache.r6g.large', configuration: { num_cache_nodes: 2 } }));
    expect(multi).toBeCloseTo(single * 2, 0);
  });
});

describe('estimateMonthlyCost — DynamoDB', () => {
  it('PAY_PER_REQUEST = $0 capacity cost; PROVISIONED charges WCU + RCU; storage above 25GB free tier', async () => {
    const onDemand = await estimateMonthlyCost(makeResource({ type: 'dynamodb_table', configuration: { billing_mode: 'PAY_PER_REQUEST', read_capacity_units: 0, write_capacity_units: 0, table_size_bytes: 0 } }));
    expect(onDemand).toBe(0);

    const provisioned = await estimateMonthlyCost(makeResource({ type: 'dynamodb_table', configuration: { billing_mode: 'PROVISIONED', read_capacity_units: 100, write_capacity_units: 50, table_size_bytes: 0 } }));
    expect(provisioned).toBeCloseTo(50 * DYNAMO_WCU_PER_MONTH + 100 * DYNAMO_RCU_PER_MONTH, 5);

    // PAY_PER_REQUEST capacity cost = $0 (billed per request, not modelled here — needs Cost Explorer actuals)
    // PROVISIONED capacity is always > $0 for non-zero CUs, so $0 < provisioned is trivially true
    const onDemandHigh = await estimateMonthlyCost(makeResource({ type: 'dynamodb_table', configuration: { billing_mode: 'PAY_PER_REQUEST', read_capacity_units: 1000, write_capacity_units: 500, table_size_bytes: 0 } }));
    const provisionedHigh = await estimateMonthlyCost(makeResource({ type: 'dynamodb_table', configuration: { billing_mode: 'PROVISIONED', read_capacity_units: 1000, write_capacity_units: 500, table_size_bytes: 0 } }));
    expect(onDemandHigh).toBe(0); // PAY_PER_REQUEST fallback: $0 capacity (request costs need Cost Explorer)
    expect(provisionedHigh).toBeGreaterThan(0);

    // 30GB: 5GB billable above 25GB free tier
    const noStorage = await estimateMonthlyCost(makeResource({ type: 'dynamodb_table', configuration: { billing_mode: 'PROVISIONED', read_capacity_units: 0, write_capacity_units: 0, table_size_bytes: 0 } }));
    const withStorage = await estimateMonthlyCost(makeResource({ type: 'dynamodb_table', configuration: { billing_mode: 'PROVISIONED', read_capacity_units: 0, write_capacity_units: 0, table_size_bytes: 30 * 1024 * 1024 * 1024 } }));
    expect(withStorage - noStorage).toBeCloseTo((30 - DYNAMO_FREE_STORAGE_GB) * DYNAMO_STORAGE_PER_GB, 2);
  });
});

describe('estimateMonthlyCost — Elastic IP and unknown type', () => {
  it('all EIPs = ~$3.65 (AWS Feb 2024 pricing); unknown type = $0', async () => {
    expect(await estimateMonthlyCost(makeResource({ type: 'elastic_ip', state: 'unattached', configuration: {} }))).toBeCloseTo(EIP_HOURLY * HOURS_PER_MONTH, 2);
    expect(await estimateMonthlyCost(makeResource({ type: 'elastic_ip', state: 'associated', configuration: {} }))).toBeCloseTo(EIP_HOURLY * HOURS_PER_MONTH, 2);
    expect(await estimateMonthlyCost(makeResource({ type: 'unknown_resource_type', configuration: {} }))).toBe(0);
  });
});
