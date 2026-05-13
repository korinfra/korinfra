/** AWS resource types and shared interfaces for the collector layer. */

export interface Utilization {
  period: string; // "7d" | "14d" | "30d"
  cpuAverage: number;
  cpuMax: number;
  cpuP95: number;
  cpuP99: number;
  /**
   * MB for EC2/RDS (freeable memory for RDS), percentage (0-100) for ElastiCache.
   */
  memoryAverage: number;
  memoryMax: number;
  memoryP95: number;
  /**
   * Total bytes received in the collection period, divided by 1 MB. NOT per-second throughput.
   */
  networkInMB: number;
  /** Total invocation count for the collection period. Populated for Lambda functions. */
  invocations?: number;
  /**
   * Average Lambda function duration in milliseconds for the collection period.
   * Populated by CloudWatch Duration metric. When absent, duration-based cost is 0.
   */
  avgDurationMs?: number;
  /**
   * Total bytes sent in the collection period, divided by 1 MB. NOT per-second throughput.
   */
  networkOutMB: number;
  diskReadIOPS: number;
  diskWriteIOPS: number;
  connectionCount: number;
  connectionCountMax: number;
  dataPoints: number;
  dataGaps: number;
  freshnessHrs: number;
}

export interface Resource {
  id: string;
  arn: string;
  type: string; // e.g. "ec2_instance", "rds_instance", "s3_bucket"
  name: string;
  region: string;
  state: string;
  instanceType: string;
  tags: Record<string, string>;
  launchTime: string; // ISO 8601
  collectedAt: string; // ISO 8601
  configuration: Record<string, unknown>;
  utilization?: Utilization;
  monthlyCostSource?: 'cost_explorer' | 'pricing_api' | null;
}

export interface CostEntry {
  service: string;
  amount: number;
  unit: string; // always "USD"
  startDate: string; // ISO date "YYYY-MM-DD"
  endDate: string;
  region?: string;
  granularity: 'DAILY' | 'MONTHLY';
  usageQuantity?: number;
}

export interface CollectorConfig {
  profile?: string;
  regions: string[];
  defaultRegion?: string;
  roleArn?: string;
  externalId?: string;
  skipCosts?: boolean;
  skipMetrics?: boolean;
  /** Fetch per-resource CE data to enrich monthlyCost fields. Costs an extra $0.01/scan. Default false. */
  includeResourceCosts?: boolean;
  lookbackDays?: number;
  metricPeriod?: '7d' | '14d' | '30d';
  serviceTimeoutMs?: number;
  collectionTimeoutMs?: number;
  maxParallelRegions?: number;
  costExplorerCacheTtlMs?: number;
  /** Called after each service collector completes. Used by TUI for per-service progress display. */
  onServiceComplete?: (svc: string, region: string, ms: number, count: number) => void;
}

export type CollectError = { collector: string; region?: string; message: string; code?: string };

export interface CollectorResult {
  resources: Resource[];
  costs: CostEntry[];
  errors: CollectError[];
  durationMs: number;
}

export interface ApiCallRecord {
  service: string;
  operation: string;
  region: string;
  timestamp: string; // ISO 8601
  durationMs: number;
  estimatedCost: number;
  error?: string;
}
