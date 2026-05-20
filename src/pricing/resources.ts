/**
 * Per-service monthly cost estimators.
 * All functions return estimated USD/month.
 * These use hardcoded fallback rates when the pricing API is unavailable.
 */
// NOTE: All fallback prices are us-east-1 rates. The AWS Pricing API is used for accurate regional rates when available.

import type { AwsPricingClient } from './client.js';

export const HOURS_PER_MONTH = 730;

// ─── EBS pricing constants (per GB/month or per IOPS/month) ──────────────────

export const EBS_GP3_PER_GB = 0.08;
export const EBS_GP3_IOPS_PRICE = 0.005; // per provisioned IOPS above 3000
const EBS_GP3_THROUGHPUT_PRICE = 0.04; // per MB/s above 125
const EBS_GP2_PER_GB = 0.10;
export const EBS_IO1_PER_GB = 0.125;
export const EBS_IO1_IOPS_PRICE = 0.065;
const EBS_IO2_PER_GB = 0.125;
const EBS_IO2_IOPS_TIER1 = 0.065; // first 32,000 IOPS
const EBS_IO2_IOPS_TIER2 = 0.046; // 32,001–64,000 IOPS
const EBS_IO2_IOPS_TIER3 = 0.032; // above 64,000 IOPS
const EBS_ST1_PER_GB = 0.045;
const EBS_SC1_PER_GB = 0.015;
const EBS_STANDARD_PER_GB = 0.05;
export const EBS_SNAPSHOT_PER_GB = 0.05;

// ─── S3 pricing constants ─────────────────────────────────────────────────────

export const S3_STANDARD_PER_GB = 0.023;
const S3_IA_PER_GB = 0.0125;
const S3_GLACIER_PER_GB = 0.004;
const S3_DEEP_ARCHIVE_PER_GB = 0.00099;
const S3_INTELLIGENT_TIERING_PER_GB = 0.023;
const S3_REDUCED_REDUNDANCY_PER_GB = 0.024;

// ─── Lambda pricing constants ─────────────────────────────────────────────────

const LAMBDA_REQUEST_PRICE_PER_1M = 0.20;
const LAMBDA_GB_SECOND_PRICE = 0.0000166667;
const LAMBDA_FREE_REQUESTS = 1_000_000;
const LAMBDA_FREE_GB_SECONDS = 400_000;

// ─── ELB pricing constants (per hour) ────────────────────────────────────────

export const ALB_BASE_HOURLY = 0.0225;
const ALB_LCU_HOURLY = 0.008;
const NLB_BASE_HOURLY = 0.0225;
const NLB_NLCU_HOURLY = 0.006;
const GWLB_BASE_HOURLY = 0.0125;
const GWLB_GLCU_HOURLY = 0.004;
const CLB_HOURLY = 0.025;

// ─── DynamoDB pricing constants ───────────────────────────────────────────────

export const DYNAMO_WCU_PER_MONTH = 0.00065;
export const DYNAMO_RCU_PER_MONTH = 0.00013;
export const DYNAMO_STORAGE_PER_GB = 0.25;
export const DYNAMO_FREE_STORAGE_GB = 25;

// ─── NAT Gateway pricing constants ───────────────────────────────────────────

export const NAT_GATEWAY_HOURLY = 0.045;
export const NAT_GATEWAY_PER_GB = 0.045;

// ─── ECS/Fargate pricing constants ────────────────────────────────────────────

export const FARGATE_LINUX_VCPU_HOURLY = 0.04048;
export const FARGATE_LINUX_MEMORY_HOURLY = 0.004445;
const FARGATE_DEFAULT_VCPU = 0.25;
const FARGATE_DEFAULT_MEMORY_GB = 0.5;

// ─── Elastic IP pricing constants ─────────────────────────────────────────────

// Since Feb 2024, AWS charges $0.005/hr for ALL public IPv4 addresses (attached or not).
export const EIP_HOURLY = 0.005;

// ─── RDS storage ──────────────────────────────────────────────────────────────

export const RDS_GP2_STORAGE_PER_GB = 0.138;
export const RDS_GP3_STORAGE_PER_GB = 0.115;
export const RDS_IO1_STORAGE_PER_GB = 0.125;
const RDS_IO1_IOPS_PER_IOPS = 0.065;
export const RDS_IO2_STORAGE_PER_GB = 0.125;

// ─── Fallback prices ──────────────────────────────────────────────────────────

export const FALLBACK_EC2_PRICES: Record<string, number> = {
  't3.nano': 0.0052,
  't3.micro': 0.0104,
  't3.small': 0.0208,
  't3.medium': 0.0416,
  't3.large': 0.0832,
  't3.xlarge': 0.1664,
  't3.2xlarge': 0.3328,
  'm5.large': 0.096,
  'm5.xlarge': 0.192,
  'm5.2xlarge': 0.384,
  'm5.4xlarge': 0.768,
  'm6i.large': 0.096,
  'm6i.xlarge': 0.192,
  'm6i.2xlarge': 0.384,
  'm6i.4xlarge': 0.768,
  'm6i.8xlarge': 1.536,
  'm6a.large': 0.0864,
  'm6a.xlarge': 0.1728,
  'm6a.2xlarge': 0.3456,
  'm6a.4xlarge': 0.6912,
  'm6g.large': 0.077,
  'm6g.xlarge': 0.154,
  'm6g.2xlarge': 0.308,
  'm6g.4xlarge': 0.616,
  'm7i.large': 0.1008,
  'm7i.xlarge': 0.2016,
  'm7i.2xlarge': 0.4032,
  'm7i.4xlarge': 0.8064,
  'm7g.large': 0.0816,
  'm7g.xlarge': 0.1632,
  'm7g.2xlarge': 0.3264,
  'c6i.large': 0.085,
  'c6i.xlarge': 0.170,
  'c6i.2xlarge': 0.340,
  'c6i.4xlarge': 0.680,
  'c6a.large': 0.0765,
  'c6a.xlarge': 0.153,
  'c6a.2xlarge': 0.306,
  'c6g.large': 0.068,
  'c6g.xlarge': 0.136,
  'c6g.2xlarge': 0.272,
  'c7i.large': 0.08925,
  'c7i.xlarge': 0.1785,
  'c7i.2xlarge': 0.357,
  'c7g.large': 0.0725,
  'c7g.xlarge': 0.145,
  'c7g.2xlarge': 0.290,
  'r6i.large': 0.126,
  'r6i.xlarge': 0.252,
  'r6i.2xlarge': 0.504,
  'r6i.4xlarge': 1.008,
  'r6a.large': 0.1134,
  'r6a.xlarge': 0.2268,
  'r6a.2xlarge': 0.4536,
  'r6g.large': 0.1008,
  'r6g.xlarge': 0.2016,
  'r6g.2xlarge': 0.4032,
  'r7i.large': 0.1323,
  'r7i.xlarge': 0.2646,
  'r7i.2xlarge': 0.5292,
  'r7g.large': 0.1075,
  'r7g.xlarge': 0.215,
  'r7g.2xlarge': 0.430,
  'i3.large': 0.156,
  'i3.xlarge': 0.312,
  'i3en.large': 0.226,
  't4g.nano': 0.0042,
  't4g.micro': 0.0084,
  't4g.small': 0.0168,
  't4g.medium': 0.0336,
  't4g.large': 0.0672,
  't4g.xlarge': 0.1344,
  't4g.2xlarge': 0.2688,
  't3a.nano': 0.0047,
  't3a.micro': 0.0094,
  't3a.small': 0.0188,
  't3a.medium': 0.0376,
  't3a.large': 0.0752,
  't3a.xlarge': 0.1504,
  'm8g.medium': 0.0408,
  'm8g.large': 0.0816,
  'm8g.xlarge': 0.1632,
  'm8g.2xlarge': 0.3264,
  'm8g.4xlarge': 0.6528,
  'c7a.large': 0.0765,
  'c7a.xlarge': 0.153,
  'c7a.2xlarge': 0.306,
  'c8g.large': 0.0725,
  'c8g.xlarge': 0.145,
  'c8g.2xlarge': 0.290,
  'c8g.4xlarge': 0.580,
  'r8g.large': 0.1075,
  'r8g.xlarge': 0.215,
  'r8g.2xlarge': 0.430,
  'r8g.4xlarge': 0.860,
  'p4d.24xlarge': 32.77,
  'p5.48xlarge': 98.32,
  'c5.large': 0.085,
  'c5.xlarge': 0.170,
  'c5.2xlarge': 0.340,
  'r5.large': 0.126,
  'r5.xlarge': 0.252,
  'r5.2xlarge': 0.504,
  't2.micro': 0.0116,
  't2.small': 0.023,
  't2.medium': 0.0464,
  'm4.large': 0.10,
  'm4.xlarge': 0.20,
};

export const FALLBACK_RDS_PRICES: Record<string, number> = {
  'db.t3.micro': 0.017,
  'db.t3.small': 0.034,
  'db.t3.medium': 0.068,
  'db.t3.large': 0.136,
  'db.t3.xlarge': 0.272,
  'db.r5.large': 0.24,
  'db.r5.xlarge': 0.48,
  'db.r5.2xlarge': 0.96,
  'db.m5.large': 0.171,
  'db.m5.xlarge': 0.342,
  'db.m5.2xlarge': 0.684,
  'db.r6g.large': 0.218,
  'db.r6g.xlarge': 0.436,
  'db.m6g.large': 0.155,
  'db.m6g.xlarge': 0.310,
  'db.m7g.large': 0.163,
  'db.m7g.xlarge': 0.326,
  'db.r7g.large': 0.229,
  'db.r7g.xlarge': 0.458,
  'db.m6i.large': 0.171,
  'db.m6i.xlarge': 0.342,
  'db.r6i.large': 0.24,
  'db.r6i.xlarge': 0.48,
  'db.t4g.micro': 0.016,
  'db.t4g.small': 0.032,
  'db.t4g.medium': 0.065,
  'db.t4g.large': 0.129,
  'db.m7i.large': 0.178,
  'db.m7i.xlarge': 0.356,
  'db.r7i.large': 0.252,
  'db.r7i.xlarge': 0.504,
  'db.c7i.large': 0.170,
  'db.c7i.xlarge': 0.340,
  'db.m8g.large': 0.155,
  'db.m8g.xlarge': 0.310,
  'db.r8g.large': 0.218,
  'db.r8g.xlarge': 0.436,
  'db.c8g.large': 0.153,
  'db.c8g.xlarge': 0.306,
};

export const FALLBACK_ELASTICACHE_PRICES: Record<string, number> = {
  'cache.t3.micro': 0.017,
  'cache.t3.small': 0.034,
  'cache.t3.medium': 0.068,
  'cache.r5.large': 0.166,
  'cache.r5.xlarge': 0.332,
  'cache.r6g.large': 0.150,
  'cache.r6g.xlarge': 0.300,
  'cache.r6g.2xlarge': 0.600,
  'cache.m5.large': 0.142,
  'cache.m5.xlarge': 0.284,
  'cache.t4g.micro': 0.016,
  'cache.t4g.small': 0.032,
  'cache.t4g.medium': 0.065,
  'cache.r7g.large': 0.166,
  'cache.r7g.xlarge': 0.332,
  'cache.m6g.large': 0.128,
  'cache.m6g.xlarge': 0.256,
  'cache.m7g.large': 0.135,
  'cache.m7g.xlarge': 0.270,
  'cache.r8g.large': 0.150,
  'cache.r8g.xlarge': 0.300,
  'cache.m8g.large': 0.128,
  'cache.m8g.xlarge': 0.256,
};

// ─── EC2 ──────────────────────────────────────────────────────────────────────

export async function estimateEC2Cost(
  client: AwsPricingClient | null,
  instanceType: string,
  region: string,
  platform = 'Linux',
): Promise<number> {
  if (!instanceType) return 0;

  const cacheKey = `${instanceType}:${platform}`;

  if (client) {
    const hourly = await client.getOnDemandPrice('AmazonEC2', cacheKey, region);
    if (hourly !== null) return hourly * HOURS_PER_MONTH;
  }

  // Fallback to hardcoded prices
  const fallback = FALLBACK_EC2_PRICES[instanceType] ?? 0;
  return fallback * HOURS_PER_MONTH;
}

// ─── RDS ──────────────────────────────────────────────────────────────────────

export async function estimateRDSCost(
  client: AwsPricingClient | null,
  instanceClass: string,
  dbEngine: string,
  multiAZ: boolean,
  allocatedStorageGB: number,
  region: string,
  storageType = 'gp3',
  provisionedIops = 0,
): Promise<number> {
  if (!instanceClass) return 0;

  const cacheKey = `${instanceClass}:${dbEngine}`;
  let hourly: number | null = null;

  if (client) {
    hourly = await client.getOnDemandPrice('AmazonRDS', cacheKey, region, multiAZ);
  }

  if (hourly === null) {
    hourly = FALLBACK_RDS_PRICES[instanceClass] ?? 0;
    // Fallback prices are Single-AZ; double for Multi-AZ when not using live pricing
    if (multiAZ) hourly *= 2;
  }

  let monthly = hourly * HOURS_PER_MONTH;

  if (allocatedStorageGB > 0) {
    switch (storageType) {
      case 'io1':
        monthly += allocatedStorageGB * RDS_IO1_STORAGE_PER_GB + provisionedIops * RDS_IO1_IOPS_PER_IOPS;
        break;
      case 'io2':
        monthly += allocatedStorageGB * RDS_IO2_STORAGE_PER_GB;
        break;
      case 'gp2':
        monthly += allocatedStorageGB * RDS_GP2_STORAGE_PER_GB;
        break;
      case 'gp3':
      default:
        monthly += allocatedStorageGB * RDS_GP3_STORAGE_PER_GB;
        break;
    }
  }

  return monthly;
}

// ─── EBS ──────────────────────────────────────────────────────────────────────

// EBS uses hardcoded rates — tiered IOPS/throughput pricing is too complex for single API lookup
// eslint-disable-next-line @typescript-eslint/require-await -- uses hardcoded rates; async signature matches other estimators
export async function estimateEBSCost(
  _client: AwsPricingClient | null,
  _region: string,
  volumeType: string,
  sizeGB: number,
  iops = 0,
  throughputMBps = 0,
): Promise<number> {
  if (sizeGB === 0) sizeGB = 8; // default EBS size

  switch (volumeType) {
    case 'gp3': {
      let monthly = sizeGB * EBS_GP3_PER_GB;
      if (iops > 3000) monthly += (iops - 3000) * EBS_GP3_IOPS_PRICE;
      if (throughputMBps > 125) monthly += (throughputMBps - 125) * EBS_GP3_THROUGHPUT_PRICE;
      return monthly;
    }
    case 'gp2':
      return sizeGB * EBS_GP2_PER_GB;
    case 'io1':
      return sizeGB * EBS_IO1_PER_GB + iops * EBS_IO1_IOPS_PRICE;
    case 'io2': {
      let monthly = sizeGB * EBS_IO2_PER_GB;
      if (iops <= 32_000) {
        monthly += iops * EBS_IO2_IOPS_TIER1;
      } else if (iops <= 64_000) {
        monthly += 32_000 * EBS_IO2_IOPS_TIER1 + (iops - 32_000) * EBS_IO2_IOPS_TIER2;
      } else {
        monthly +=
          32_000 * EBS_IO2_IOPS_TIER1 +
          32_000 * EBS_IO2_IOPS_TIER2 +
          (iops - 64_000) * EBS_IO2_IOPS_TIER3;
      }
      return monthly;
    }
    case 'st1':
      return sizeGB * EBS_ST1_PER_GB;
    case 'sc1':
      return sizeGB * EBS_SC1_PER_GB;
    case 'standard':
      return sizeGB * EBS_STANDARD_PER_GB;
    default:
      return sizeGB * EBS_GP3_PER_GB; // default to gp3 pricing
  }
}

// ─── S3 ───────────────────────────────────────────────────────────────────────

export async function estimateS3Cost(
  client: AwsPricingClient | null,
  region: string,
  storageClass: string,
  sizeGB: number,
): Promise<number> {
  if (sizeGB === 0) return 0;

  if (client) {
    const s3VolumeTypeMap: Record<string, string> = {
      'STANDARD': 'Standard',
      'STANDARD_IA': 'Standard - Infrequent Access',
      'ONEZONE_IA': 'One Zone - Infrequent Access',
      'GLACIER': 'Amazon Glacier',
      'GLACIER_DEEP_ARCHIVE': 'Amazon Glacier Deep Archive',
      'DEEP_ARCHIVE': 'Amazon Glacier Deep Archive',
      'INTELLIGENT_TIERING': 'Intelligent-Tiering',
      'REDUCED_REDUNDANCY': 'Reduced Redundancy',
    };
    const volumeType = s3VolumeTypeMap[storageClass] ?? storageClass;
    const apiPerGB = await client.getOnDemandPrice('AmazonS3', volumeType, region);
    if (apiPerGB !== null) return sizeGB * apiPerGB;
  }

  let perGB: number;
  switch (storageClass) {
    case 'STANDARD':
      perGB = S3_STANDARD_PER_GB;
      break;
    case 'STANDARD_IA':
    case 'ONEZONE_IA':
      perGB = S3_IA_PER_GB;
      break;
    case 'GLACIER':
      perGB = S3_GLACIER_PER_GB;
      break;
    case 'GLACIER_DEEP_ARCHIVE':
    case 'DEEP_ARCHIVE':
      perGB = S3_DEEP_ARCHIVE_PER_GB;
      break;
    case 'INTELLIGENT_TIERING':
      perGB = S3_INTELLIGENT_TIERING_PER_GB;
      break;
    case 'REDUCED_REDUNDANCY':
      // REDUCED_REDUNDANCY is deprecated by AWS; kept for legacy compatibility
      perGB = S3_REDUCED_REDUNDANCY_PER_GB;
      break;
    default:
      perGB = S3_STANDARD_PER_GB;
  }

  return sizeGB * perGB;
}

// ─── Lambda ───────────────────────────────────────────────────────────────────

export function estimateLambdaCost(
  memoryMB: number,
  avgDurationMs: number,
  invocationsPerMonth: number,
): number {
  if (invocationsPerMonth === 0) return 0;

  // Request cost — first 1M requests free
  let requestCost = 0;
  if (invocationsPerMonth > LAMBDA_FREE_REQUESTS) {
    requestCost =
      ((invocationsPerMonth - LAMBDA_FREE_REQUESTS) / 1_000_000) * LAMBDA_REQUEST_PRICE_PER_1M;
  }

  // Duration cost — first 400,000 GB-seconds free
  const gbSeconds = (memoryMB / 1024) * (avgDurationMs / 1000) * invocationsPerMonth;
  const billableGBSeconds = Math.max(0, gbSeconds - LAMBDA_FREE_GB_SECONDS);
  const durationCost = billableGBSeconds * LAMBDA_GB_SECOND_PRICE;

  return requestCost + durationCost;
}

// ─── ECS/Fargate ──────────────────────────────────────────────────────────────

export function estimateECSCost(cpuVcpus = FARGATE_DEFAULT_VCPU, memoryGB = FARGATE_DEFAULT_MEMORY_GB): number {
  return (cpuVcpus * FARGATE_LINUX_VCPU_HOURLY + memoryGB * FARGATE_LINUX_MEMORY_HOURLY) * HOURS_PER_MONTH;
}

// ─── ELB ──────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/require-await -- uses hardcoded rates; async signature matches other estimators
export async function estimateELBCost(
  _client: AwsPricingClient | null,
  _region: string,
  lbType: string,
): Promise<number> {
  switch (lbType) {
    case 'application':
      return (ALB_BASE_HOURLY + ALB_LCU_HOURLY) * HOURS_PER_MONTH;
    case 'network':
      return (NLB_BASE_HOURLY + NLB_NLCU_HOURLY) * HOURS_PER_MONTH;
    case 'gateway':
      return (GWLB_BASE_HOURLY + GWLB_GLCU_HOURLY) * HOURS_PER_MONTH;
    default:
      return CLB_HOURLY * HOURS_PER_MONTH;
  }
}

// ─── ElastiCache ──────────────────────────────────────────────────────────────

export async function estimateElastiCacheCost(
  client: AwsPricingClient | null,
  nodeType: string,
  numNodes: number,
  region: string,
): Promise<number> {
  if (!nodeType || numNodes === 0) return 0;

  let hourly: number | null = null;

  if (client) {
    hourly = await client.getOnDemandPrice('AmazonElastiCache', nodeType, region);
  }

  hourly ??= FALLBACK_ELASTICACHE_PRICES[nodeType] ?? 0;

  return hourly * HOURS_PER_MONTH * numNodes;
}

// ─── DynamoDB ─────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/require-await -- uses hardcoded rates; async signature matches other estimators
export async function estimateDynamoDBCost(
  _client: AwsPricingClient | null,
  _region: string,
  billingMode: string,
  rcu: number,
  wcu: number,
  storageGB = 0,
  ceActualMonthlyUsd?: number,
): Promise<number> {
  // Provisioned: $0.00065/WCU/month + $0.00013/RCU/month.
  // PAY_PER_REQUEST: capacity cost depends on actual request volume, which we cannot
  // estimate from configuration alone. When Cost Explorer per-resource cost is available
  // (passed via ceActualMonthlyUsd), use it as the capacity cost. Otherwise return 0 for
  // capacity rather than a misleading guess — storage cost is still added separately.
  const capacityCost =
    billingMode === 'PAY_PER_REQUEST'
      ? (ceActualMonthlyUsd && ceActualMonthlyUsd > 0 ? ceActualMonthlyUsd : 0)
      : wcu * DYNAMO_WCU_PER_MONTH + rcu * DYNAMO_RCU_PER_MONTH;

  // Storage: first 25 GB free, then $0.25/GB/month
  const storageCost =
    storageGB > DYNAMO_FREE_STORAGE_GB
      ? (storageGB - DYNAMO_FREE_STORAGE_GB) * DYNAMO_STORAGE_PER_GB
      : 0;

  return capacityCost + storageCost;
}

// ─── NAT Gateway ──────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/require-await -- uses hardcoded rates; async signature matches other estimators
export async function estimateNATGatewayCost(
  _client: AwsPricingClient | null,
  _region: string,
  processedGB = 0,
): Promise<number> {
  const baseCost = NAT_GATEWAY_HOURLY * HOURS_PER_MONTH;
  const dataCost = processedGB * NAT_GATEWAY_PER_GB;
  return baseCost + dataCost;
}

// ─── Elastic IP ───────────────────────────────────────────────────────────────

/**
 * Estimates monthly cost for an Elastic IP address.
 * Since Feb 2024, both idle and in-use public IPv4 addresses cost $0.005/hr (AWS VPC Pricing).
 * The _attached parameter is kept for API compatibility but no longer affects the result.
 */
export function estimateEIPCost(_attached: boolean): number {
  return EIP_HOURLY * HOURS_PER_MONTH;
}

// ─── Sync fallback estimators (no API client, no async) ───────────────────────

/** Returns estimated monthly cost for an EC2 instance using the fallback pricing table. Returns 0 if not found. */
export function estimateEC2CostSync(instanceType: string, _region: string): number {
  const hourly = FALLBACK_EC2_PRICES[instanceType] ?? 0;
  return hourly * HOURS_PER_MONTH;
}

/** Returns estimated monthly cost for an RDS instance using the fallback pricing table. Returns 0 if not found. */
export function estimateRDSCostSync(instanceType: string, _region: string): number {
  const hourly = FALLBACK_RDS_PRICES[instanceType] ?? 0;
  return hourly * HOURS_PER_MONTH;
}

