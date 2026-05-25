import { describe, it, expect, vi } from 'vitest';
import {
  estimateEC2Cost,
  estimateEBSCost,
  estimateS3Cost,
  estimateLambdaCost,
  estimateNATGatewayCost,
  estimateEIPCost,
  estimateRDSCost,
  estimateELBCost,
  estimateECSCost,
  FARGATE_LINUX_VCPU_HOURLY,
  FARGATE_LINUX_MEMORY_HOURLY,
  FARGATE_ARM_VCPU_HOURLY,
  FARGATE_ARM_MEMORY_HOURLY,
  HOURS_PER_MONTH,
} from '../../../src/pricing/resources.js';

// ─── EC2 ─────────────────────────────────────────────────────────────────────

describe('estimateEC2Cost', () => {
  it('returns hourly * 730 from fallback; t3.large is double t3.medium; empty/unknown = 0', async () => {
    const medium = await estimateEC2Cost(null, 't3.medium', 'us-east-1');
    expect(medium).toBeCloseTo(0.0416 * 730, 4);

    const large = await estimateEC2Cost(null, 't3.large', 'us-east-1');
    expect(large).toBeCloseTo(medium * 2, 2);

    expect(await estimateEC2Cost(null, '', 'us-east-1')).toBe(0);
    expect(await estimateEC2Cost(null, 'unknown.xlarge', 'us-east-1')).toBe(0);
  });
});

// ─── EBS ─────────────────────────────────────────────────────────────────────

describe('estimateEBSCost', () => {
  it('prices gp3 base, IOPS surcharge, and throughput surcharge correctly', async () => {
    expect(await estimateEBSCost(null, 'us-east-1', 'gp3', 100)).toBeCloseTo(100 * 0.08);
    expect(await estimateEBSCost(null, 'us-east-1', 'gp3', 100, 4000)).toBeCloseTo(100 * 0.08 + 1000 * 0.005); // 1000 extra IOPS
    expect(await estimateEBSCost(null, 'us-east-1', 'gp3', 100, 3000, 200)).toBeCloseTo(100 * 0.08 + 75 * 0.04); // 75 extra MB/s
  });

  it('prices gp2, st1, sc1, standard, and defaults unknown type to gp3', async () => {
    expect(await estimateEBSCost(null, 'us-east-1', 'gp2', 100)).toBeCloseTo(100 * 0.10);
    expect(await estimateEBSCost(null, 'us-east-1', 'st1', 500)).toBeCloseTo(500 * 0.045);
    expect(await estimateEBSCost(null, 'us-east-1', 'sc1', 500)).toBeCloseTo(500 * 0.015);
    expect(await estimateEBSCost(null, 'us-east-1', 'standard', 100)).toBeCloseTo(100 * 0.05);
    expect(await estimateEBSCost(null, 'us-east-1', 'unknown_type', 100)).toBeCloseTo(100 * 0.08); // falls back to gp3
    expect(await estimateEBSCost(null, 'us-east-1', 'gp3', 0)).toBeCloseTo(8 * 0.08); // defaults sizeGB to 8
  });

  it('prices io1 and io2 with tiered IOPS correctly', async () => {
    expect(await estimateEBSCost(null, 'us-east-1', 'io1', 100, 2000)).toBeCloseTo(100 * 0.125 + 2000 * 0.065);
    expect(await estimateEBSCost(null, 'us-east-1', 'io2', 100, 1000)).toBeCloseTo(100 * 0.125 + 1000 * 0.065);

    // io2 second tier: above 32000
    const io2SecondTier = await estimateEBSCost(null, 'us-east-1', 'io2', 100, 40000);
    expect(io2SecondTier).toBeCloseTo(100 * 0.125 + 32000 * 0.065 + 8000 * 0.046, 2);

    // io2 third tier: above 64000
    const io2ThirdTier = await estimateEBSCost(null, 'us-east-1', 'io2', 100, 70000);
    expect(io2ThirdTier).toBeCloseTo(100 * 0.125 + 32000 * 0.065 + 32000 * 0.046 + 6000 * 0.032, 2);
  });
});

// ─── S3 ──────────────────────────────────────────────────────────────────────

describe('estimateS3Cost', () => {
  it('prices all storage classes correctly and defaults unknown to STANDARD', async () => {
    expect(await estimateS3Cost(null, 'us-east-1', 'STANDARD', 0)).toBe(0);
    expect(await estimateS3Cost(null, 'us-east-1', 'STANDARD', 1000)).toBeCloseTo(1000 * 0.023);
    expect(await estimateS3Cost(null, 'us-east-1', 'STANDARD_IA', 1000)).toBeCloseTo(1000 * 0.0125);
    expect(await estimateS3Cost(null, 'us-east-1', 'ONEZONE_IA', 1000)).toBeCloseTo(1000 * 0.0125);
    expect(await estimateS3Cost(null, 'us-east-1', 'GLACIER', 1000)).toBeCloseTo(1000 * 0.004);
    expect(await estimateS3Cost(null, 'us-east-1', 'GLACIER_DEEP_ARCHIVE', 1000)).toBeCloseTo(1000 * 0.00099);
    expect(await estimateS3Cost(null, 'us-east-1', 'DEEP_ARCHIVE', 1000)).toBeCloseTo(1000 * 0.00099);
    expect(await estimateS3Cost(null, 'us-east-1', 'INTELLIGENT_TIERING', 1000)).toBeCloseTo(1000 * 0.023);
    expect(await estimateS3Cost(null, 'us-east-1', 'REDUCED_REDUNDANCY', 1000)).toBeCloseTo(1000 * 0.024);
    expect(await estimateS3Cost(null, 'us-east-1', 'UNKNOWN', 100)).toBeCloseTo(100 * 0.023);
    expect(await estimateS3Cost(null, 'us-east-1', 'STANDARD', 100)).toBeLessThan(await estimateS3Cost(null, 'us-east-1', 'REDUCED_REDUNDANCY', 100));
  });
});

// ─── Lambda ───────────────────────────────────────────────────────────────────

describe('estimateLambdaCost', () => {
  it('respects free tiers, charges for above-threshold usage, and accumulates correctly', () => {
    expect(estimateLambdaCost(512, 100, 0)).toBe(0);
    expect(estimateLambdaCost(512, 100, 1_000_000)).toBe(0); // both tiers in free tier

    // 2M requests: 1M billable
    const twoMillion = estimateLambdaCost(512, 1, 2_000_000);
    expect(twoMillion).toBeGreaterThan(0.19);
    expect(twoMillion).toBeLessThan(0.25);

    // 1GB * 1s * 1M - 400k free = 600k billable GB-s
    const gbSeconds = estimateLambdaCost(1024, 1000, 1_000_000);
    expect(gbSeconds).toBeCloseTo((1_000_000 - 400_000) * 0.0000166667, 2);

    // High traffic: request + duration costs accumulate
    const highTraffic = estimateLambdaCost(512, 200, 10_000_000);
    expect(highTraffic).toBeCloseTo(1.80 + 600_000 * 0.0000166667, 1);
  });
});

// ─── Lambda arm64 ─────────────────────────────────────────────────────────────

describe('estimateLambdaCost — arm64 vs x86_64', () => {
  it('arm64 costs ~20% less than x86_64 for identical usage above free tier', () => {
    const invocations = 10_000_000; // 9M billable
    const durationMs = 500;
    const memoryMB = 512;

    const x86Cost = estimateLambdaCost(memoryMB, durationMs, invocations, 'x86_64');
    const armCost = estimateLambdaCost(memoryMB, durationMs, invocations, 'arm64');

    expect(armCost).toBeGreaterThan(0);
    expect(armCost).toBeLessThan(x86Cost);
    // arm64 GB-second price is 0.0000133334 vs 0.0000166667 = 20% cheaper
    const ratio = armCost / x86Cost;
    expect(ratio).toBeGreaterThan(0.75);
    expect(ratio).toBeLessThan(0.90);
  });

  it('arm64 GB-second price is exactly $0.0000133334', () => {
    // 1024 MB = 1 GB; 1000ms = 1s; 1M invocations (all in free request tier)
    // GB-seconds = 1 * 1 * 1,000,000 = 1,000,000; billable = 1,000,000 - 400,000 = 600,000
    const cost = estimateLambdaCost(1024, 1000, 1_000_000, 'arm64');
    // No request cost (1M ≤ free tier); only duration cost
    expect(cost).toBeCloseTo(600_000 * 0.0000133334, 4);
  });
});

// ─── ECS Fargate ARM ──────────────────────────────────────────────────────────

describe('estimateECSCost — ARM vs x86_64', () => {
  it('ARM Fargate costs ~20% less than x86 for identical vCPU/memory', () => {
    const cpuVcpus = 2;
    const memoryGB = 4;

    const x86Cost = estimateECSCost(cpuVcpus, memoryGB, 'X86_64');
    const armCost = estimateECSCost(cpuVcpus, memoryGB, 'ARM64');

    expect(armCost).toBeGreaterThan(0);
    expect(armCost).toBeLessThan(x86Cost);
    const ratio = armCost / x86Cost;
    expect(ratio).toBeGreaterThan(0.75);
    expect(ratio).toBeLessThan(0.90);
  });

  it('x86_64 cost matches FARGATE_LINUX constants', () => {
    const cost = estimateECSCost(1, 2, 'X86_64');
    expect(cost).toBeCloseTo((FARGATE_LINUX_VCPU_HOURLY + 2 * FARGATE_LINUX_MEMORY_HOURLY) * HOURS_PER_MONTH, 4);
  });

  it('ARM64 cost matches FARGATE_ARM constants', () => {
    const cost = estimateECSCost(1, 2, 'ARM64');
    expect(cost).toBeCloseTo((FARGATE_ARM_VCPU_HOURLY + 2 * FARGATE_ARM_MEMORY_HOURLY) * HOURS_PER_MONTH, 4);
  });

  it('defaults to x86_64 when architecture is omitted', () => {
    expect(estimateECSCost(1, 2)).toBeCloseTo(estimateECSCost(1, 2, 'X86_64'), 6);
  });
});

// ─── NAT Gateway, EIP, RDS, ELB ──────────────────────────────────────────────

describe('estimateNATGatewayCost', () => {
  it('applies base hourly cost and data processing charge', async () => {
    expect(await estimateNATGatewayCost(null, 'us-east-1', 0)).toBeCloseTo(0.045 * 730);
    expect(await estimateNATGatewayCost(null, 'us-east-1', 100)).toBeCloseTo(0.045 * 730 + 100 * 0.045);
    expect(await estimateNATGatewayCost(null, 'us-east-1', 1000)).toBeGreaterThan(await estimateNATGatewayCost(null, 'us-east-1', 100));
  });
});

describe('estimateEIPCost', () => {
  it('all EIPs (attached or not) = $0.005 * 730 since AWS Feb 2024 pricing', () => {
    expect(estimateEIPCost(true)).toBeCloseTo(0.005 * 730, 4);
    expect(estimateEIPCost(false)).toBeCloseTo(0.005 * 730, 4);
  });
});

describe('estimateRDSCost', () => {
  it('prices single-AZ, multi-AZ (2x), storage surcharge, and returns 0 for empty class', async () => {
    const singleAZ = await estimateRDSCost(null, 'db.t3.medium', 'mysql', false, 0, 'us-east-1');
    expect(singleAZ).toBeCloseTo(0.072 * 730, 2);

    const multiAZ = await estimateRDSCost(null, 'db.t3.medium', 'mysql', true, 0, 'us-east-1');
    expect(multiAZ).toBeCloseTo(singleAZ * 2, 2);

    const withStorage = await estimateRDSCost(null, 'db.t3.medium', 'mysql', false, 100, 'us-east-1');
    expect(withStorage).toBeCloseTo(singleAZ + 100 * 0.115, 2);

    expect(await estimateRDSCost(null, '', 'mysql', false, 0, 'us-east-1')).toBe(0);
  });
});

describe('estimateELBCost', () => {
  it('prices all LB types correctly, including classic/unknown fallback', async () => {
    expect(await estimateELBCost(null, 'us-east-1', 'application')).toBeCloseTo((0.0225 + 0.008) * 730);
    expect(await estimateELBCost(null, 'us-east-1', 'network')).toBeCloseTo((0.0225 + 0.006) * 730);
    expect(await estimateELBCost(null, 'us-east-1', 'gateway')).toBeCloseTo((0.0125 + 0.004) * 730);
    expect(await estimateELBCost(null, 'us-east-1', 'classic')).toBeCloseTo(0.025 * 730);
    expect(await estimateELBCost(null, 'us-east-1', 'unknown')).toBeCloseTo(0.025 * 730);
  });
});

// ─── RDS with live pricing client ────────────────────────────────────────────

describe('estimateRDSCost with live pricing client (multiAZ doubling fix)', () => {
  it('uses live pricing directly when client returns non-null (no doubling even if multiAZ=true)', async () => {
    // Mock client that returns a live hourly price of 0.5
    const mockClient = {
      getOnDemandPrice: vi.fn().mockResolvedValue(0.5),
    };

    const cost = await estimateRDSCost(
      mockClient as any,
      'db.m5.large',
      'mysql',
      true,
      100,
      'us-east-1',
      'gp3',
      0,
    );

    // Expected: 0.5 * 730 (hourly from live pricing) + 100 * 0.115 (gp3 storage)
    // Live pricing already includes multiAZ, so NO doubling applied
    expect(cost).toBeCloseTo(0.5 * 730 + 100 * 0.115, 1);
  });

  it('applies doubling to fallback price when client returns null and multiAZ=true', async () => {
    const mockClient = {
      getOnDemandPrice: vi.fn().mockResolvedValue(null),
    };

    const cost = await estimateRDSCost(
      mockClient as any,
      'db.m5.large',
      'mysql',
      true,
      100,
      'us-east-1',
      'gp3',
      0,
    );

    // Fallback price for db.m5.large is 0.178, doubled to 0.356 for multiAZ
    // Expected: 0.178 * 2 * 730 + 100 * 0.115
    expect(cost).toBeCloseTo(0.178 * 2 * 730 + 100 * 0.115, 1);
  });

  it('does not apply doubling when multiAZ=false, regardless of client', async () => {
    const mockClient = {
      getOnDemandPrice: vi.fn().mockResolvedValue(null),
    };

    const cost = await estimateRDSCost(
      mockClient as any,
      'db.m5.large',
      'mysql',
      false,
      100,
      'us-east-1',
      'gp3',
      0,
    );

    // Fallback price is 0.178, no doubling because multiAZ=false
    // Expected: 0.178 * 730 + 100 * 0.115
    expect(cost).toBeCloseTo(0.178 * 730 + 100 * 0.115, 1);
  });

  it('correctly uses cache key with multiAZ flag when querying client', async () => {
    const mockClient = {
      getOnDemandPrice: vi.fn().mockResolvedValue(0.5),
    };

    await estimateRDSCost(
      mockClient as any,
      'db.m5.large',
      'mysql',
      true,
      0,
      'us-east-1',
    );

    // Verify that the client was called with the correct arguments
    expect(mockClient.getOnDemandPrice).toHaveBeenCalledWith(
      'AmazonRDS',
      'db.m5.large:mysql',
      'us-east-1',
      true,
    );
  });
});
