/**
 * Tests for src/aws/cloudwatch.ts — metric batching and utilization population.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockRateLimiter } from '../../helpers/mock-rate-limiter.js';

vi.mock('../../../src/aws/rate-limiter.js', () => createMockRateLimiter());

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  collectEC2MetricsBatched,
  collectRDSMetricsBatched,
  collectLambdaMetricsBatched,
  collectElastiCacheMetricsBatched,
} from '../../../src/aws/cloudwatch.js';
import * as rateLimiter from '../../../src/aws/rate-limiter.js';
import type { Resource } from '../../../src/aws/types.js';

function makeResource(overrides: Partial<Resource> & { id: string; type: string; state: string }): Resource {
  return {
    arn: `arn:aws:ec2:us-east-1:123456789012:instance/${overrides.id}`,
    name: overrides.id,
    region: 'us-east-1',
    instanceType: 't3.medium',
    tags: {},
    launchTime: '2026-01-01T00:00:00.000Z',
    collectedAt: new Date().toISOString(),
    configuration: {},
    ...overrides,
  };
}

function makeCloudWatchClient(metricResults: Array<{ Id: string; Timestamps: Date[]; Values: number[] }> = []) {
  return { send: vi.fn().mockResolvedValue({ MetricDataResults: metricResults, NextToken: undefined }) } as never;
}

function makeEC2MetricResults(slots: number, cpuValues: number[] = [15, 20, 10]) {
  const results: Array<{ Id: string; Timestamps: Date[]; Values: number[] }> = [];
  const timestamps = cpuValues.map((_, i) => new Date(Date.now() - (cpuValues.length - i) * 3600_000));
  for (let slot = 0; slot < slots; slot++) {
    const p = `e${slot}`;
    results.push(
      { Id: `${p}_cpuavg`, Timestamps: timestamps, Values: cpuValues },
      { Id: `${p}_cpumax`, Timestamps: timestamps, Values: cpuValues.map(v => v * 1.2) },
      { Id: `${p}_netin`, Timestamps: timestamps, Values: cpuValues.map(v => v * 1024 * 1024) },
      { Id: `${p}_netout`, Timestamps: timestamps, Values: cpuValues.map(v => v * 512 * 1024) },
      { Id: `${p}_dread`, Timestamps: timestamps, Values: [100, 200, 150] },
      { Id: `${p}_dwrite`, Timestamps: timestamps, Values: [50, 75, 60] },
    );
  }
  return results;
}

// ---------------------------------------------------------------------------
// collectEC2MetricsBatched
// ---------------------------------------------------------------------------

describe('collectEC2MetricsBatched', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('skips stopped and non-ec2_instance resources, populates utilization on running instances', async () => {
    const resources: Resource[] = [
      makeResource({ id: 'i-stopped001', type: 'ec2_instance', state: 'stopped' }),
      makeResource({ id: 'i-running001', type: 'ec2_instance', state: 'running' }),
      makeResource({ id: 'vol-0abc', type: 'ebs_volume', state: 'available' }),
    ];

    const client = makeCloudWatchClient(makeEC2MetricResults(1, [20, 30, 25]));
    await collectEC2MetricsBatched(client, 'us-east-1', resources, '7d');

    expect(resources[0]!.utilization).toBeUndefined();
    expect(resources[1]!.utilization).toBeDefined();
    expect(resources[2]!.utilization).toBeUndefined();
  });

  it('populates all utilization fields correctly including cpuAvg, cpuMax, p95, and network bytes to MB', async () => {
    const resources: Resource[] = [
      makeResource({ id: 'i-0abcdef1234567890', type: 'ec2_instance', state: 'running' }),
    ];

    const client = makeCloudWatchClient(makeEC2MetricResults(1, [10, 20, 30]));
    await collectEC2MetricsBatched(client, 'us-east-1', resources, '7d');

    const util = resources[0]!.utilization!;
    expect(util.period).toBe('7d');
    expect(util.cpuAverage).toBeCloseTo(20, 1);
    expect(util.cpuMax).toBeCloseTo(36, 1);

    // p95 test with 100 values
    const cpuValues = Array.from({ length: 100 }, (_, i) => i + 1);
    const p95Resources: Resource[] = [makeResource({ id: 'i-percentile001', type: 'ec2_instance', state: 'running' })];
    const timestamps = cpuValues.map((_, i) => new Date(Date.now() - (100 - i) * 3600_000));
    const p95Client = makeCloudWatchClient([
      { Id: 'e0_cpuavg', Timestamps: timestamps, Values: cpuValues },
      { Id: 'e0_cpumax', Timestamps: timestamps, Values: cpuValues },
      { Id: 'e0_netin', Timestamps: timestamps, Values: cpuValues },
      { Id: 'e0_netout', Timestamps: timestamps, Values: cpuValues },
      { Id: 'e0_dread', Timestamps: timestamps, Values: cpuValues },
      { Id: 'e0_dwrite', Timestamps: timestamps, Values: cpuValues },
    ]);
    await collectEC2MetricsBatched(p95Client, 'us-east-1', p95Resources, '7d');
    expect(p95Resources[0]!.utilization!.cpuP95).toBeGreaterThanOrEqual(94);
    expect(p95Resources[0]!.utilization!.cpuP95).toBeLessThanOrEqual(100);

    // Network bytes to MB conversion
    const netResources: Resource[] = [makeResource({ id: 'i-network001', type: 'ec2_instance', state: 'running' })];
    const bytes = 10 * 1024 * 1024;
    const netClient = makeCloudWatchClient([
      { Id: 'e0_cpuavg', Timestamps: [new Date()], Values: [5] },
      { Id: 'e0_cpumax', Timestamps: [new Date()], Values: [5] },
      { Id: 'e0_netin', Timestamps: [new Date()], Values: [bytes] },
      { Id: 'e0_netout', Timestamps: [new Date()], Values: [bytes / 2] },
      { Id: 'e0_dread', Timestamps: [new Date()], Values: [100] },
      { Id: 'e0_dwrite', Timestamps: [new Date()], Values: [50] },
    ]);
    await collectEC2MetricsBatched(netClient, 'us-east-1', netResources, '7d');
    expect(netResources[0]!.utilization!.networkInMB).toBeCloseTo(10, 1);
    expect(netResources[0]!.utilization!.networkOutMB).toBeCloseTo(5, 1);
  });

  it('does not throw on empty CloudWatch results or batch errors', async () => {
    const emptyResources: Resource[] = [makeResource({ id: 'i-empty001', type: 'ec2_instance', state: 'running' })];
    await expect(collectEC2MetricsBatched(makeCloudWatchClient([]), 'us-east-1', emptyResources, '7d')).resolves.not.toThrow();

    const errorResources: Resource[] = [makeResource({ id: 'i-error001', type: 'ec2_instance', state: 'running' })];
    const errorClient = { send: vi.fn().mockRejectedValue(new Error('CloudWatch throttled')) } as never;
    await expect(collectEC2MetricsBatched(errorClient, 'us-east-1', errorResources, '7d')).resolves.not.toThrow();
    expect(errorResources[0]!.utilization).toBeUndefined();
  });

  it('accepts 7d, 14d, and 30d period labels', async () => {
    for (const period of ['7d', '14d', '30d'] as const) {
      const resources: Resource[] = [makeResource({ id: `i-${period}`, type: 'ec2_instance', state: 'running' })];
      await expect(
        collectEC2MetricsBatched(makeCloudWatchClient(makeEC2MetricResults(1, [5, 10])), 'us-east-1', resources, period),
      ).resolves.not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// collectRDSMetricsBatched
// ---------------------------------------------------------------------------

describe('collectRDSMetricsBatched', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('skips non-available RDS instances', async () => {
    const resources: Resource[] = [makeResource({ id: 'db-stopped', type: 'rds_instance', state: 'stopped' })];
    await collectRDSMetricsBatched(makeCloudWatchClient([]), 'us-east-1', resources, '14d');
    expect(resources[0]!.utilization).toBeUndefined();
  });

  it('populates utilization and free_storage_gb for available RDS instance', async () => {
    const resources: Resource[] = [makeResource({ id: 'prod-mysql-01', type: 'rds_instance', state: 'available' })];
    const timestamps = [new Date(Date.now() - 3600_000), new Date()];
    const client = makeCloudWatchClient([
      { Id: 'r0_cpuavg', Timestamps: timestamps, Values: [30, 40] },
      { Id: 'r0_cpumax', Timestamps: timestamps, Values: [50, 60] },
      { Id: 'r0_riops', Timestamps: timestamps, Values: [200, 300] },
      { Id: 'r0_wiops', Timestamps: timestamps, Values: [100, 150] },
      { Id: 'r0_netin', Timestamps: timestamps, Values: [1_048_576, 2_097_152] },
      { Id: 'r0_netout', Timestamps: timestamps, Values: [524_288, 1_048_576] },
      { Id: 'r0_memfree', Timestamps: timestamps, Values: [2_147_483_648, 3_221_225_472] },
      { Id: 'r0_memfmax', Timestamps: timestamps, Values: [3_221_225_472, 3_221_225_472] },
      { Id: 'r0_dbconn', Timestamps: timestamps, Values: [15, 20] },
      { Id: 'r0_dbcmax', Timestamps: timestamps, Values: [25, 30] },
      { Id: 'r0_freestor', Timestamps: timestamps, Values: [107_374_182_400, 107_374_182_400] },
    ]);
    await collectRDSMetricsBatched(client, 'us-east-1', resources, '14d');

    const util = resources[0]!.utilization!;
    expect(util).toBeDefined();
    expect(util.period).toBe('14d');
    expect(util.cpuAverage).toBeCloseTo(35, 1);
    expect(util.cpuMax).toBeCloseTo(60, 1);
    expect(util.connectionCount).toBeCloseTo(17.5, 1);
    expect(util.connectionCountMax).toBeCloseTo(30, 1);
    expect(util.diskReadIOPS).toBeCloseTo(250, 1);
    expect(resources[0]!.configuration['free_storage_gb']).toBeCloseTo(100, 1);
  });
});

// ---------------------------------------------------------------------------
// collectLambdaMetricsBatched
// ---------------------------------------------------------------------------

describe('collectLambdaMetricsBatched', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('populates utilization for lambda functions, skips non-lambda, handles zero invocations', async () => {
    const resources: Resource[] = [
      makeResource({ id: 'process-cost-events', type: 'lambda_function', state: 'active' }),
    ];
    const timestamps = Array.from({ length: 24 }, (_, i) => new Date(Date.now() - (24 - i) * 3600_000));
    const invocations = Array.from({ length: 24 }, () => 500);
    const durations = Array.from({ length: 24 }, () => 250);
    const client = makeCloudWatchClient([
      { Id: 'l0_inv', Timestamps: timestamps, Values: invocations },
      { Id: 'l0_davg', Timestamps: timestamps, Values: durations },
      { Id: 'l0_dp95', Timestamps: timestamps, Values: durations.map(d => d * 1.5) },
    ]);
    await collectLambdaMetricsBatched(client, 'us-east-1', resources, '7d');
    const util = resources[0]!.utilization!;
    expect(util.period).toBe('7d');
    expect(util.cpuAverage).toBe(0); // Lambda has no CPU metric
    expect(util.avgDurationMs).toBeCloseTo(250, 1);
    expect(util.invocations).toBeCloseTo(12000, 0);

    // Skips non-lambda
    const ec2Resources: Resource[] = [makeResource({ id: 'i-ec2instance', type: 'ec2_instance', state: 'running' })];
    await collectLambdaMetricsBatched(makeCloudWatchClient([]), 'us-east-1', ec2Resources, '7d');
    expect(ec2Resources[0]!.utilization).toBeUndefined();

    // Zero invocations
    const idleResources: Resource[] = [makeResource({ id: 'idle-lambda', type: 'lambda_function', state: 'active' })];
    const idleClient = makeCloudWatchClient([
      { Id: 'l0_inv', Timestamps: [], Values: [] },
      { Id: 'l0_davg', Timestamps: [], Values: [] },
      { Id: 'l0_dp95', Timestamps: [], Values: [] },
    ]);
    await collectLambdaMetricsBatched(idleClient, 'us-east-1', idleResources, '7d');
    expect(idleResources[0]!.utilization!.invocations).toBe(0);
    expect(idleResources[0]!.utilization!.avgDurationMs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// collectElastiCacheMetricsBatched
// ---------------------------------------------------------------------------

describe('collectElastiCacheMetricsBatched', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('populates utilization for elasticache clusters and skips non-cache resources', async () => {
    const resources: Resource[] = [
      makeResource({ id: 'redis-prod-001', type: 'elasticache_cluster', state: 'available' }),
    ];
    const timestamps = [new Date(Date.now() - 3600_000), new Date()];
    const client = makeCloudWatchClient([
      { Id: 'c0_cpuavg', Timestamps: timestamps, Values: [12, 18] },
      { Id: 'c0_cpup95', Timestamps: timestamps, Values: [25, 30] },
      { Id: 'c0_memused', Timestamps: timestamps, Values: [55, 60] },
      { Id: 'c0_conns', Timestamps: timestamps, Values: [45, 50] },
    ]);
    await collectElastiCacheMetricsBatched(client, 'us-east-1', resources, '7d');

    const util = resources[0]!.utilization!;
    expect(util.cpuAverage).toBeCloseTo(15, 1);
    expect(util.memoryAverage).toBeCloseTo(57.5, 1);
    expect(util.connectionCount).toBeCloseTo(47.5, 1);

    // Skips non-elasticache
    const ec2Resources: Resource[] = [makeResource({ id: 'i-not-cache', type: 'ec2_instance', state: 'running' })];
    await collectElastiCacheMetricsBatched(makeCloudWatchClient([]), 'us-east-1', ec2Resources, '7d');
    expect(ec2Resources[0]!.utilization).toBeUndefined();
  });

  it('calls throttledCall with service name cloudwatch', async () => {
    const resources: Resource[] = [
      makeResource({ id: 'i-test001', type: 'ec2_instance', state: 'running' }),
    ];
    const client = makeCloudWatchClient(makeEC2MetricResults(1, [20, 30, 25]));
    await collectEC2MetricsBatched(client, 'us-east-1', resources, '7d');

    expect(rateLimiter.throttledCall).toHaveBeenCalledWith(
      'cloudwatch',
      expect.any(String),
      expect.any(String),
      expect.any(Function),
    );
  });
});
