/**
 * Shared realistic test data — simulates a production AWS account with
 * EC2, RDS, S3, Lambda, ELB, ECS, ElastiCache, DynamoDB, and NAT resources.
 * Used across unit and integration tests.
 */

import type { Resource, Utilization, CostEntry } from '../../src/aws/types.js';
import type { TerraformResource, StateResource } from '../../src/classifier/types.js';
import type { CostDataPoint } from '../../src/anomaly/detector.js';

// ─── Utilization factories ──────────────────────────────────────────────────

export function makeUtil(overrides: Partial<Utilization> = {}): Utilization {
  return {
    period: '7d',
    cpuAverage: 35,
    cpuMax: 72,
    cpuP95: 55,
    cpuP99: 68,
    memoryAverage: 4096,
    memoryMax: 6144,
    memoryP95: 5120,
    networkInMB: 250,
    networkOutMB: 180,
    diskReadIOPS: 120,
    diskWriteIOPS: 80,
    connectionCount: 12,
    connectionCountMax: 45,
    dataPoints: 168,
    dataGaps: 2,
    freshnessHrs: 0.5,
    ...overrides,
  };
}

// ─── EC2 Resources ──────────────────────────────────────────────────────────

const now = new Date().toISOString();
const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
const twoYearsAgo = new Date(Date.now() - 730 * 86_400_000).toISOString();

export const ec2Production: Resource = {
  id: 'i-0a1b2c3d4e5f67890',
  arn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-0a1b2c3d4e5f67890',
  type: 'ec2_instance',
  name: 'api-server-prod-1',
  region: 'us-east-1',
  state: 'running',
  instanceType: 'm5.xlarge',
  tags: { Name: 'api-server-prod-1', Environment: 'production', Team: 'backend' },
  launchTime: twoYearsAgo,
  collectedAt: now,
  configuration: {
    platform: 'Linux/UNIX',
    platform_details: 'Linux/UNIX',
    architecture: 'x86_64',
    instance_family: 'm5',
    instance_size: 'xlarge',
    lifecycle: 'on-demand',
    vpc_id: 'vpc-0abc123def456',
    subnet_id: 'subnet-0abc123def456',
    image_id: 'ami-0abcdef1234567890',
    key_name: 'prod-key',
    monitoring_state: 'enabled',
    ebs_optimized: true,
    security_group_ids: ['sg-0abc123'],
    security_group_count: 1,
    private_ip: '10.0.1.42',
    public_ip: '52.23.191.30',
    availability_zone: 'us-east-1a',
    tenancy: 'default',
    metadata_options_http_tokens: 'optional', // Not IMDSv2 → EC2-012 should fire
    monthlyCost: 140,
  },
  utilization: makeUtil({ cpuAverage: 45, cpuP95: 60, cpuMax: 85 }),
};

export const ec2Idle: Resource = {
  id: 'i-0idle000000000000',
  arn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-0idle000000000000',
  type: 'ec2_instance',
  name: 'old-staging-worker',
  region: 'us-east-1',
  state: 'running',
  instanceType: 'c5.2xlarge',
  tags: { Name: 'old-staging-worker', Environment: 'staging' },
  launchTime: twoYearsAgo,
  collectedAt: now,
  configuration: {
    platform: 'Linux/UNIX',
    platform_details: 'Linux/UNIX',
    architecture: 'x86_64',
    instance_family: 'c5',
    instance_size: '2xlarge',
    lifecycle: 'on-demand',
    vpc_id: 'vpc-0abc123def456',
    subnet_id: 'subnet-0abc123def456',
    image_id: 'ami-0abcdef1234567890',
    key_name: 'staging-key',
    monitoring_state: 'disabled',
    ebs_optimized: false,
    security_group_ids: ['sg-0def456'],
    security_group_count: 1,
    private_ip: '10.0.2.15',
    public_ip: '',
    availability_zone: 'us-east-1b',
    tenancy: 'default',
    metadata_options_http_tokens: 'required',
    monthlyCost: 245,
  },
  utilization: makeUtil({ cpuAverage: 2, cpuP95: 5, cpuMax: 8 }),
};

const ec2Stopped: Resource = {
  id: 'i-0stop000000000000',
  arn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-0stop000000000000',
  type: 'ec2_instance',
  name: 'decommissioned-web',
  region: 'us-east-1',
  state: 'stopped',
  instanceType: 't3.medium',
  tags: { Name: 'decommissioned-web' },
  launchTime: thirtyDaysAgo,
  collectedAt: now,
  configuration: {
    platform: 'Linux/UNIX',
    platform_details: 'Linux/UNIX',
    architecture: 'x86_64',
    instance_family: 't3',
    instance_size: 'medium',
    lifecycle: 'on-demand',
    vpc_id: 'vpc-0abc123def456',
    subnet_id: 'subnet-0abc123def456',
    image_id: 'ami-0abcdef1234567890',
    key_name: '',
    monitoring_state: 'disabled',
    ebs_optimized: false,
    security_group_ids: [],
    security_group_count: 0,
    private_ip: '10.0.3.22',
    public_ip: '',
    availability_zone: 'us-east-1a',
    tenancy: 'default',
    metadata_options_http_tokens: 'optional',
    stopped_at: thirtyDaysAgo,
    monthlyCost: 0,
  },
};

// ─── RDS Resources ──────────────────────────────────────────────────────────

export const rdsProduction: Resource = {
  id: 'db-prod-main',
  arn: 'arn:aws:rds:us-east-1:123456789012:db:prod-main',
  type: 'rds_instance',
  name: 'prod-main',
  region: 'us-east-1',
  state: 'available',
  instanceType: 'db.r5.xlarge',
  tags: { Name: 'prod-main', Environment: 'production', Team: 'data' },
  launchTime: twoYearsAgo,
  collectedAt: now,
  configuration: {
    engine: 'postgres',
    engine_version: '15.4',
    multi_az: true,
    storage_type: 'gp3',
    allocated_storage: 500,
    free_storage_gb: 420, // 84% free → RDS-013 should fire (> rdsFreeStorageRatio 70%)
    encrypted: true,
    publicly_accessible: false,
    backup_retention_period: 7,
    monthlyCost: 720,
  },
  utilization: makeUtil({
    cpuAverage: 22,
    cpuP95: 40,
    connectionCount: 85,
    connectionCountMax: 200,
    memoryAverage: 8192,
  }),
};

export const rdsIdle: Resource = {
  id: 'db-staging-legacy',
  arn: 'arn:aws:rds:us-east-1:123456789012:db:staging-legacy',
  type: 'rds_instance',
  name: 'staging-legacy',
  region: 'us-east-1',
  state: 'available',
  instanceType: 'db.m5.large',
  tags: { Name: 'staging-legacy', Environment: 'staging' },
  launchTime: thirtyDaysAgo,
  collectedAt: now,
  configuration: {
    engine: 'mysql',
    engine_version: '5.7.44',
    multi_az: true,
    storage_type: 'gp2',
    allocated_storage: 200,
    free_storage_gb: 180,
    encrypted: false,
    publicly_accessible: true,
    backup_retention_period: 0,
    monthlyCost: 360,
  },
  utilization: makeUtil({
    cpuAverage: 1.5,
    cpuP95: 3,
    connectionCount: 0.2, // < 1 → RDS-009 should fire
    connectionCountMax: 1,
    period: '7d',
    memoryAverage: 2048,
  }),
};

// ─── S3 Resources ───────────────────────────────────────────────────────────

export const s3DataLake: Resource = {
  id: 'company-data-lake',
  arn: 'arn:aws:s3:::company-data-lake',
  type: 's3_bucket',
  name: 'company-data-lake',
  region: 'us-east-1',
  state: 'active',
  instanceType: '',
  tags: { Team: 'data-eng', Environment: 'production' },
  launchTime: twoYearsAgo,
  collectedAt: now,
  configuration: {
    versioning_enabled: true,
    lifecycle_rules_count: 3,
    has_lifecycle: true,
    encryption_enabled: true,
    has_intelligent_tiering: false, // → S3-002 should fire (has lifecycle, no IT)
  },
};

export const s3Unencrypted: Resource = {
  id: 'dev-scratch-bucket',
  arn: 'arn:aws:s3:::dev-scratch-bucket',
  type: 's3_bucket',
  name: 'dev-scratch-bucket',
  region: 'us-east-1',
  state: 'active',
  instanceType: '',
  tags: {},
  launchTime: tenDaysAgo,
  collectedAt: now,
  configuration: {
    versioning_enabled: false,
    lifecycle_rules_count: 0,
    has_lifecycle: false,
    encryption_enabled: false, // → S3-004 should fire
    has_intelligent_tiering: false,
  },
};

// ─── Lambda Resources ───────────────────────────────────────────────────────

const lambdaActive: Resource = {
  id: 'process-orders',
  arn: 'arn:aws:lambda:us-east-1:123456789012:function:process-orders',
  type: 'lambda_function',
  name: 'process-orders',
  region: 'us-east-1',
  state: 'active',
  instanceType: '',
  tags: { Team: 'backend' },
  launchTime: thirtyDaysAgo,
  collectedAt: now,
  configuration: {
    runtime: 'nodejs20.x',
    memory_mb: 1024,
    timeout: 30,
    architecture: 'x86_64',
    package_type: 'Zip',
    handler: 'index.handler',
    monthlyCost: 45,
  },
  utilization: makeUtil({
    invocations: 150000,
    avgDurationMs: 450,
    networkInMB: 0,
    memoryAverage: 0, // Lambda has no CloudWatch memory metric
    memoryMax: 0,
  }),
};

// ─── EBS Resources ──────────────────────────────────────────────────────────

export const ebsUnattached: Resource = {
  id: 'vol-0unattached00000',
  arn: '',
  type: 'ebs_volume',
  name: 'orphaned-volume',
  region: 'us-east-1',
  state: 'available',
  instanceType: '',
  tags: {},
  launchTime: thirtyDaysAgo,
  collectedAt: now,
  configuration: {
    volume_type: 'gp2',
    size_gb: 100,
    iops: 300,
    encrypted: false,
    monthlyCost: 10,
  },
};

// ─── Terraform Resources ────────────────────────────────────────────────────

const tfInstance: TerraformResource = {
  address: 'aws_instance.api_server',
  type: 'aws_instance',
  name: 'api_server',
  provider: 'aws',
  module: '',
  filePath: 'main.tf',
  lineNumber: 15,
  configuration: {
    instance_type: 'm5.xlarge',
    ami: 'ami-0abcdef1234567890',
    subnet_id: 'subnet-0abc123def456',
    tags: { Name: 'api-server-prod-1' },
  },
  estimatedCost: 0,
  dependencies: [],
};

const tfRds: TerraformResource = {
  address: 'aws_db_instance.prod_main',
  type: 'aws_db_instance',
  name: 'prod_main',
  provider: 'aws',
  module: '',
  filePath: 'rds.tf',
  lineNumber: 1,
  configuration: {
    instance_class: 'db.r5.xlarge',
    engine: 'postgres',
    engine_version: '15.4',
    allocated_storage: 500,
    multi_az: true,
  },
  estimatedCost: 0,
  dependencies: [],
};

const tfS3: TerraformResource = {
  address: 'aws_s3_bucket.data_lake',
  type: 'aws_s3_bucket',
  name: 'data_lake',
  provider: 'aws',
  module: '',
  filePath: 's3.tf',
  lineNumber: 1,
  configuration: { bucket: 'company-data-lake' },
  estimatedCost: 0,
  dependencies: [],
};

// ─── State Resources ────────────────────────────────────────────────────────

const stateInstance: StateResource = {
  type: 'aws_instance',
  name: 'api_server',
  provider: 'aws',
  id: 'i-0a1b2c3d4e5f67890',
  arn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-0a1b2c3d4e5f67890',
  attributes: {
    instance_type: 'm5.xlarge',
    ami: 'ami-0abcdef1234567890',
  },
};

const stateRds: StateResource = {
  type: 'aws_db_instance',
  name: 'prod_main',
  provider: 'aws',
  id: 'db-prod-main',
  arn: 'arn:aws:rds:us-east-1:123456789012:db:prod-main',
  attributes: {
    instance_class: 'db.r5.xlarge',
    engine: 'postgres',
  },
};

// ─── Cost Data (30 days, daily) ─────────────────────────────────────────────

function makeRealisticCostData(): CostDataPoint[] {
  const baseline = 125; // $125/day
  const points: CostDataPoint[] = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date('2026-03-01');
    d.setDate(d.getDate() + i);
    const date = d.toISOString().slice(0, 10);
    // Normal fluctuation ±15%, with a spike on day 22
    const jitter = (Math.sin(i * 0.7) * 0.15 + 1);
    let amount = baseline * jitter;
    if (i === 22) amount = 340; // Anomaly: cost spike
    if (i === 23) amount = 290; // Tail of spike
    points.push({ date, amount: Math.round(amount * 100) / 100 });
  }
  return points;
}

function makeCostEntries(): CostEntry[] {
  return [
    { service: 'AmazonEC2', amount: 2450.00, unit: 'USD', startDate: '2026-03-01', endDate: '2026-04-01', region: 'us-east-1', granularity: 'MONTHLY' },
    { service: 'AmazonRDS', amount: 1080.00, unit: 'USD', startDate: '2026-03-01', endDate: '2026-04-01', region: 'us-east-1', granularity: 'MONTHLY' },
    { service: 'AmazonS3', amount: 285.50, unit: 'USD', startDate: '2026-03-01', endDate: '2026-04-01', region: 'us-east-1', granularity: 'MONTHLY' },
    { service: 'AWSLambda', amount: 42.30, unit: 'USD', startDate: '2026-03-01', endDate: '2026-04-01', region: 'us-east-1', granularity: 'MONTHLY' },
    { service: 'AmazonCloudWatch', amount: 18.00, unit: 'USD', startDate: '2026-03-01', endDate: '2026-04-01', region: 'us-east-1', granularity: 'MONTHLY' },
    { service: 'AmazonDynamoDB', amount: 65.20, unit: 'USD', startDate: '2026-03-01', endDate: '2026-04-01', region: 'us-east-1', granularity: 'MONTHLY' },
    { service: 'AmazonElastiCache', amount: 180.00, unit: 'USD', startDate: '2026-03-01', endDate: '2026-04-01', region: 'us-east-1', granularity: 'MONTHLY' },
    { service: 'NATGateway', amount: 95.00, unit: 'USD', startDate: '2026-03-01', endDate: '2026-04-01', region: 'us-east-1', granularity: 'MONTHLY' },
  ];
}

// ─── Full "account" collection ──────────────────────────────────────────────

export function makeRealisticAccount() {
  return {
    resources: [
      ec2Production,
      ec2Idle,
      ec2Stopped,
      rdsProduction,
      rdsIdle,
      s3DataLake,
      s3Unencrypted,
      lambdaActive,
      ebsUnattached,
    ],
    terraform: [tfInstance, tfRds, tfS3],
    state: [stateInstance, stateRds],
    costs: makeCostEntries(),
    costTimeSeries: makeRealisticCostData(),
  };
}
