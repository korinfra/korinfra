import type { RuleInfo } from './types.js';

/**
 * All 65 built-in cost optimization rules.
 *
 * The `costGating` field classifies each rule's relationship with `monthly_cost`
 * (see #44 Item 2 and `CostGating` in `types.ts`):
 *
 *   strict          — uses `getMonthlyCostStrict`, skips with warning on missing cost
 *   security        — primary value is the fix itself; $0 savings is legitimate
 *   fixed-rate      — has reliable fallback pricing (fixed AWS rate / multi-tier)
 *   cost-graduated  — savings depend on `monthly_cost` (non-strict); future strict candidates
 */
export const ruleRegistry: readonly RuleInfo[] = [
  // EC2
  { id: 'EC2-001', category: 'ec2', title: 'Idle EC2 instance', description: 'EC2 instance with <5% average CPU over 7+ days', impact: 'high', risk: 'medium', costGating: 'cost-graduated' },
  { id: 'EC2-002', category: 'ec2', title: 'Stopped EC2 with attached EBS', description: 'Stopped instance older than 7 days with billable EBS volumes', impact: 'medium', risk: 'low', costGating: 'cost-graduated' },
  { id: 'EC2-003', category: 'ec2', title: 'Previous-generation instance family', description: 'Instance family has a cheaper, faster current-gen replacement', impact: 'medium', risk: 'low', costGating: 'cost-graduated' },
  { id: 'EC2-004', category: 'ec2', title: 'Oversized EC2 instance', description: 'CPU P95 < 30% — instance can be rightsized to a smaller type', impact: 'high', risk: 'low', costGating: 'cost-graduated' },
  { id: 'EC2-005', category: 'ec2', title: 'On-demand instance running 30+ days', description: 'Long-running on-demand instance eligible for Reserved Instance / Savings Plan', impact: 'high', risk: 'medium', costGating: 'cost-graduated' },
  { id: 'EC2-006', category: 'ec2', title: 'EC2 instance eligible for Graviton migration', description: 'x86_64 instance family has an equivalent Graviton arm64 family (~20% cheaper)', impact: 'medium', risk: 'low', costGating: 'cost-graduated' },
  { id: 'EC2-007', category: 'ec2', title: 't2 instance should be upgraded to t3/t3a', description: 't3 is cheaper and faster than t2 with unlimited burst mode by default', impact: 'low', risk: 'low', costGating: 'cost-graduated' },
  { id: 'EC2-008', category: 'ec2', title: 'Previous-generation instance type (broad set)', description: 'Instance family (t1/m1-m4/c1/c3-c4/r3-r4/i2/d2/g2/p2/x1) has a current-gen replacement that is cheaper and faster', impact: 'medium', risk: 'low', costGating: 'cost-graduated' },
  { id: 'EC2-009', category: 'ec2', title: 'Stopped EC2 instance still incurring EBS charges', description: 'Stopped instance has attached EBS volumes that continue to be billed at the standard storage rate', impact: 'medium', risk: 'low', costGating: 'cost-graduated' },
  { id: 'EC2-010', category: 'ec2', title: 'EC2 instance with high outbound data transfer', description: 'High outbound transfer (>1 TB/mo) can cost $0.09/GB. Consider CloudFront or VPC endpoints.', impact: 'medium', risk: 'low', costGating: 'security' },
  { id: 'EC2-011', category: 'ec2', title: 'EC2 instance without EBS optimization enabled', description: 'Non-burstable EC2 instance without EBS optimization enabled loses throughput.', impact: 'medium', risk: 'low', costGating: 'security' },
  { id: 'EC2-012', category: 'ec2', title: 'EC2 instance without IMDSv2 enforced', description: 'Instance metadata service v1 is a common attack vector. Enforce IMDSv2.', impact: 'high', risk: 'low', costGating: 'security' },
  { id: 'EC2-013', category: 'ec2', title: 'EC2 instance running for more than 1 year', description: 'Long-running instances should be periodically reviewed for continued need.', impact: 'low', risk: 'low', costGating: 'security' },
  // EBS
  { id: 'EBS-001', category: 'ebs', title: 'Unattached EBS volume', description: "EBS volume in 'available' state not attached to any instance", impact: 'high', risk: 'low', costGating: 'strict' },
  { id: 'EBS-002', category: 'ebs', title: 'Old EBS snapshot (>90 days)', description: 'Snapshot older than 90 days unlikely needed for point-in-time recovery', impact: 'low', risk: 'low', costGating: 'strict' },
  { id: 'SNAP-001', category: 'ebs', title: 'Orphaned EBS snapshot (source volume deleted)', description: 'Snapshot whose source volume no longer exists has no recovery utility and incurs ongoing storage charges', impact: 'low', risk: 'low', costGating: 'strict' },
  { id: 'EBS-003', category: 'ebs', title: 'gp2 volume should be gp3', description: 'gp3 is 20% cheaper with same or better baseline performance', impact: 'medium', risk: 'low', costGating: 'cost-graduated' },
  { id: 'EBS-004', category: 'ebs', title: 'Unencrypted EBS volume', description: 'Encryption-at-rest is free and required by most compliance frameworks', impact: 'high', risk: 'medium', costGating: 'security' },
  { id: 'EBS-005', category: 'ebs', title: 'io1/io2 volume with low IOPS — gp3 is sufficient and 87% cheaper', description: 'Provisioned IOPS <= 3000 can be served by gp3 baseline at much lower cost', impact: 'high', risk: 'low', costGating: 'fixed-rate' },
  { id: 'EBS-006', category: 'ebs', title: 'io1/io2 volume with over-provisioned IOPS (>3000)', description: 'io1/io2 volumes with >3000 IOPS cost $0.065/IOPS/month — verify actual IOPS usage in CloudWatch and reduce if over-provisioned', impact: 'medium', risk: 'low', costGating: 'fixed-rate' },
  { id: 'EBS-007', category: 'ebs', title: 'gp3 EBS volume with very low IOPS utilization', description: 'gp3 volume with provisioned IOPS above baseline but very low actual IOPS usage.', impact: 'medium', risk: 'low', costGating: 'fixed-rate' },
  { id: 'SNAP-002', category: 'ebs', title: 'EBS snapshot older than 1 year', description: 'Snapshot over 1 year old is very unlikely needed. Review and delete.', impact: 'medium', risk: 'low', costGating: 'strict' },
  // EIP
  { id: 'EIP-001', category: 'ec2', title: 'Unused Elastic IP', description: 'EIP not associated with a running instance costs $3.65/mo', impact: 'low', risk: 'low', costGating: 'fixed-rate' },
  // RDS
  { id: 'RDS-001', category: 'rds', title: 'Idle RDS instance', description: 'Near-zero CPU for 7+ days — staging/dev database likely forgotten', impact: 'high', risk: 'medium', costGating: 'strict' },
  { id: 'RDS-002', category: 'rds', title: 'Production RDS without Multi-AZ', description: 'Single-AZ RDS has no automatic failover on hardware failure', impact: 'high', risk: 'low', costGating: 'security' },
  { id: 'RDS-003', category: 'rds', title: 'Oversized RDS instance', description: 'CPU average < 15% — instance class can be reduced', impact: 'high', risk: 'medium', costGating: 'strict' },
  { id: 'RDS-004', category: 'rds', title: 'Unencrypted RDS storage', description: 'Unencrypted RDS storage is a compliance and security risk', impact: 'high', risk: 'high', costGating: 'security' },
  { id: 'RDS-005', category: 'rds', title: 'Publicly accessible RDS instance', description: 'publicly_accessible=true exposes the database to the internet', impact: 'high', risk: 'low', costGating: 'security' },
  { id: 'RDS-006', category: 'rds', title: 'RDS gp2 storage should be gp3', description: 'gp3 storage is 20% cheaper than gp2 with the same baseline IOPS', impact: 'medium', risk: 'low', costGating: 'cost-graduated' },
  { id: 'RDS-007', category: 'rds', title: 'Multi-AZ enabled in non-production environment', description: 'Dev/staging databases do not need Multi-AZ — disabling it halves the instance cost', impact: 'high', risk: 'low', costGating: 'cost-graduated' },
  { id: 'RDS-008', category: 'rds', title: 'RDS instance eligible for Graviton migration', description: 'db.m5/r5/m6i/r6i families have Graviton equivalents that cost 10-20% less', impact: 'medium', risk: 'low', costGating: 'cost-graduated' },
  { id: 'RDS-009', category: 'rds', title: 'Idle RDS by connection count', description: 'Fewer than 1 average connection over 7+ days — database has no active clients', impact: 'high', risk: 'medium', costGating: 'strict' },
  { id: 'RDS-010', category: 'rds', title: 'Reserved Instance opportunity for stable RDS workload', description: 'RDS instance with CPU > 15% running steadily for 30+ days is a strong RI candidate (1-year RI saves ~40%)', impact: 'high', risk: 'low', costGating: 'cost-graduated' },
  { id: 'RDS-011', category: 'rds', title: 'RDS without automated backups', description: 'No automated backups means no point-in-time recovery capability.', impact: 'high', risk: 'low', costGating: 'security' },
  { id: 'RDS-012', category: 'rds', title: 'RDS Extended Support surcharge', description: 'Older engine versions (MySQL <8.4, PostgreSQL <16) incur AWS Extended Support charges (April 2026).', impact: 'medium', risk: 'medium', costGating: 'fixed-rate' },
  { id: 'RDS-013', category: 'rds', title: 'RDS with low storage utilization', description: 'RDS instance has >70% free storage — consider reducing allocated storage.', impact: 'medium', risk: 'low', costGating: 'fixed-rate' },
  { id: 'RDS-014', category: 'rds', title: 'RDS engine approaching Extended Support', description: 'Engine version will enter AWS Extended Support within 180 days, incurring additional charges of $0.12+/vCPU/hr.', impact: 'medium', risk: 'medium', costGating: 'fixed-rate' },
  // S3
  { id: 'S3-001', category: 's3', title: 'S3 bucket without lifecycle policy', description: 'Buckets without lifecycle rules miss tiering savings', impact: 'medium', risk: 'low', costGating: 'cost-graduated' },
  { id: 'S3-002', category: 's3', title: 'S3 bucket without lifecycle or Intelligent-Tiering', description: 'Add a lifecycle rule with Intelligent-Tiering transition to cut storage costs automatically', impact: 'low', risk: 'low', costGating: 'cost-graduated' },
  { id: 'S3-003', category: 's3', title: 'S3 bucket without versioning', description: 'Versioning prevents accidental deletion and overwrites', impact: 'medium', risk: 'low', costGating: 'security' },
  { id: 'S3-004', category: 's3', title: 'S3 bucket without server-side encryption', description: 'S3 bucket without default server-side encryption. SSE-S3 is free.', impact: 'high', risk: 'low', costGating: 'security' },
  // Lambda
  { id: 'LAM-001', category: 'lambda', title: 'Unused Lambda function', description: 'Function with zero invocations adds maintenance overhead', impact: 'low', risk: 'low', costGating: 'security' },
  { id: 'LAM-002', category: 'lambda', title: 'Overprovisioned Lambda memory', description: 'Lambda using <20% of allocated memory — reduce to cut billing', impact: 'medium', risk: 'low', costGating: 'fixed-rate' },
  { id: 'LAM-003', category: 'lambda', title: 'Deprecated Lambda runtime', description: 'End-of-life runtimes receive no security patches', impact: 'high', risk: 'medium', costGating: 'security' },
  { id: 'LAM-004', category: 'lambda', title: 'Low-invocation Lambda with high memory', description: '<100 invocations/month but >512 MB memory — over-provisioned', impact: 'medium', risk: 'low', costGating: 'fixed-rate' },
  { id: 'LAM-005', category: 'lambda', title: 'Lambda on x86_64 — consider arm64/Graviton', description: 'arm64 (Graviton2) is ~20% cheaper with equal or better performance', impact: 'medium', risk: 'low', costGating: 'cost-graduated' },
  { id: 'LAM-006', category: 'lambda', title: 'Lambda function with high error rate', description: 'Lambda function with >10% error rate may be misconfigured or broken.', impact: 'high', risk: 'low', costGating: 'security' },
  { id: 'LAM-007', category: 'lambda', title: 'Lambda runtime approaching end of support', description: 'Runtime will enter unsupported state within 180 days — functions will stop receiving security patches.', impact: 'high', risk: 'medium', costGating: 'security' },
  // DynamoDB
  { id: 'DDB-001', category: 'dynamodb', title: 'DynamoDB provisioned capacity at low utilisation', description: 'Switch to on-demand to pay only for actual requests', impact: 'high', risk: 'low', costGating: 'cost-graduated' },
  { id: 'DDB-002', category: 'dynamodb', title: 'DynamoDB provisioned table without auto-scaling', description: 'Provisioned DynamoDB without auto-scaling wastes capacity during off-peak hours.', impact: 'medium', risk: 'low', costGating: 'cost-graduated' },
  // ElastiCache
  { id: 'ELC-001', category: 'elasticache', title: 'Overprovisioned ElastiCache cluster', description: '<10% memory utilisation — rightsize to a smaller node type', impact: 'medium', risk: 'medium', costGating: 'strict' },
  { id: 'ELC-002', category: 'elasticache', title: 'Previous-generation ElastiCache node type', description: 'Previous-gen ElastiCache node type (r5/m5/t3) has a cheaper Graviton replacement.', impact: 'medium', risk: 'low', costGating: 'cost-graduated' },
  { id: 'ELC-003', category: 'elasticache', title: 'Idle ElastiCache cluster', description: 'ElastiCache cluster with near-zero CPU and memory usage is likely unused.', impact: 'high', risk: 'medium', costGating: 'strict' },
  // NAT Gateway
  { id: 'NET-001', category: 'nat', title: 'Low-traffic NAT Gateway', description: '<1 GB/mo processed — fixed hourly cost dominates; consider NAT instance', impact: 'medium', risk: 'medium', costGating: 'fixed-rate' },
  { id: 'NAT-001', category: 'nat', title: 'NAT Gateway with very low data (VPC endpoint candidate)', description: '<5 GB/mo data — VPC endpoints for S3/DynamoDB eliminate NAT charges', impact: 'medium', risk: 'low', costGating: 'fixed-rate' },
  // ECS
  { id: 'ECS-001', category: 'ecs', title: 'ECS service with 0 running tasks', description: 'Idle ECS service still holds cluster capacity and target group slots', impact: 'medium', risk: 'low', costGating: 'cost-graduated' },
  { id: 'ECS-002', category: 'ecs', title: 'ECS service on EC2 launch type', description: 'Fargate eliminates EC2 management overhead for variable workloads', impact: 'medium', risk: 'medium', costGating: 'cost-graduated' },
  { id: 'ECS-003', category: 'ecs', title: 'ECS service over-provisioned with too many tasks', description: 'ECS service with high desired count but very low CPU utilization.', impact: 'medium', risk: 'medium', costGating: 'cost-graduated' },
  { id: 'ECS-004', category: 'ecs', title: 'ECS service degraded — running below desired count', description: 'Service has fewer running tasks than desired with no pending tasks — likely a launch failure.', impact: 'high', risk: 'low', costGating: 'security' },
  // ELB
  { id: 'ELB-001', category: 'elb', title: 'Load balancer with 0 healthy targets', description: 'Idle load balancer still accrues hourly LCU charges', impact: 'medium', risk: 'low', costGating: 'strict' },
  { id: 'LB-002', category: 'elb', title: 'Idle load balancer with no healthy targets or negligible traffic', description: 'Load balancer shows 0 healthy targets or <0.1 MB network in over 7+ days — accruing base charges with no useful work', impact: 'medium', risk: 'low', costGating: 'strict' },
  { id: 'ELB-002', category: 'elb', title: 'Classic Load Balancer in use', description: 'CLB is previous-gen — ALB/NLB offer better features and pricing', impact: 'medium', risk: 'medium', costGating: 'cost-graduated' },
  { id: 'ELB-003', category: 'elb', title: 'ALB without HTTPS listener', description: 'Application Load Balancer serving only HTTP exposes traffic unencrypted', impact: 'high', risk: 'low', costGating: 'security' },
  // General
  { id: 'TAG-001', category: 'general', title: 'Missing cost allocation tags', description: 'Resources without Environment/Team/Project tags cannot be attributed', impact: 'low', risk: 'low', costGating: 'security' },
  { id: 'TAG-002', category: 'general', title: 'Completely untagged resource', description: 'Resource has no tags at all — no cost attribution, team ownership, or lifecycle tracking possible', impact: 'low', risk: 'low', costGating: 'security' },
  { id: 'GENERAL-001', category: 'general', title: 'Resource in expensive region', description: 'Same workload can run in us-east-1 at ~10-20% lower cost than ap/eu/sa regions', impact: 'medium', risk: 'high', costGating: 'cost-graduated' },
] as const;

/** Returns metadata about all built-in rules (copy, not reference). */
export function listRules(): RuleInfo[] {
  return [...ruleRegistry];
}
