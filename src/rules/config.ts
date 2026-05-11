/**
 * Configurable thresholds for the built-in rules engine.
 * Ported from Go internal/ai/rules.go DefaultRulesConfig().
 */
export const THRESHOLDS = {
  // EC2
  idleCPUThreshold: 5.0, // EC2-001: CPU avg below this = idle
  rightsizeCPUThreshold: 30.0, // EC2-004: CPU P95 below this = oversized
  stoppedInstanceDays: 7, // EC2-002: min days stopped before flagging
  onDemandRunningDays: 30, // EC2-005: days on-demand before RI suggestion
  instanceMaxAgeDays: 365, // EC2-013: max instance age before flagging

  // EBS
  snapshotRetentionDays: 90, // EBS-002: snapshot age threshold
  snapshotMaxAgeDays: 365, // SNAP-002: max snapshot age before flagging
  gp3IOPSBaseline: 3000, // EBS-005: gp3 baseline IOPS

  // RDS
  rdsIdleCPUThreshold: 1.0, // RDS-001: CPU avg below this = idle
  rdsRightsizeCPUThreshold: 15.0, // RDS-003: CPU avg below this = oversized
  rdsMinCostForRI: 20.0, // RDS-010: min monthly cost for RI rec
  rdsRICPUThreshold: 15.0, // RDS-010: min CPU for RI rec
  rdsMinStorageGB: 100.0, // RDS-013: min allocated storage to flag
  rdsFreeStorageRatio: 0.7, // RDS-013: free ratio threshold
  rdsConnectionIdleThreshold: 1.0, // RDS-009: connection count below this = idle

  // ElastiCache
  cacheMemoryThreshold: 10.0, // ELC-001: memory avg below this = overprovisioned
  elastiCacheIdleCPUThreshold: 2.0, // ELC-003: CPU below this = idle
  elastiCacheIdleMemoryThreshold: 5.0, // ELC-003: memory below this = idle

  // Lambda
  lambdaLowInvocations: 100, // LAM-004: invocations below this = low-use
  lambdaMinMemoryMB: 512, // LAM-002: min memory MB to trigger overprovisioning
  lambdaErrorRateThreshold: 10.0, // LAM-006: error rate % above this = broken

  // NAT Gateway
  natLowTrafficGB: 1.0, // NET-001: traffic below this = low
  natEndpointTrafficGB: 5.0, // NAT-001: traffic below this = endpoint candidate

  // ECS
  ecsIdleDays: 3, // ECS-001: min days before flagging idle
  ecsDegradedDays: 1, // ECS-004: min days a service must be degraded before flagging
  ecsMinCPUThreshold: 20.0, // ECS-003: CPU avg below this = over-provisioned
  ecsMinDesiredCount: 3, // ECS-003: min desired_count to check

  // ELB
  elbIdleDays: 7, // ELB-001: min days before flagging idle
  lbIdleTrafficMB: 0.5, // LB-002: monthly traffic below this MB = idle

  // General
  requiredTags: ['Environment', 'Team', 'Project'], // TAG-001: required tag names
  regionCostThreshold: 100.0, // GENERAL-001: min monthly cost for region rec

  // Max recommendations (0 = unlimited)
  maxRecommendations: 0,

  // Savings multipliers (0.0–1.0) — tunable via config
  ec2IdleStopMultiplier: 0.80,
  ec2StoppedEBSMultiplier: 0.10,
  ec2PreviousGenMultiplier: 0.15,
  ec2T2T3Multiplier: 0.10, // t2→t3 migration savings
  ec2GPUPreviousGenMultiplier: 0.10, // GPU prev-gen upgrade savings
  ec2HighNetworkOutThresholdMB: 1_048_576, // 1 TB/month outbound threshold
  ec2RightsizeMultiplier: 0.60,
  ec2RIDiscountMultiplier: 0.40,
  ec2GravitonMultiplier: 0.20,
  ebsGP2ToGP3SavingsRatio: 0.20, // gp2→gp3 savings ratio
  ebsLowActualIOPS: 100, // threshold for low IOPS utilization
  ebsIO1ToGP3Multiplier: 0.80, // io1/io2→gp3 migration savings (80-90% typical for IOPS<=3000)
  ebsIO1HighIOPSUtilThreshold: 0.5, // EBS-006: P95 actual IOPS / provisioned below this = over-provisioned
  ebsIO1HighIOPSHeadroom: 1.2, // EBS-006: 20% headroom above P95 actual when recommending new IOPS
  elastiCacheGravitonMultiplier: 0.05, // ElastiCache Graviton savings (corrected from 0.15)
  elbClassicToALBMultiplier: 0.10, // CLB→ALB migration savings
  natGatewayReplacementMultiplier: 0.70, // NAT gateway→NAT instance savings
  natEndpointSavingsMultiplier: 0.40, // NAT gateway→VPC endpoint savings
  dynamoDBProvisionedUtilThreshold: 50, // % utilization below which on-demand is recommended
  dynamoDBOnDemandSavingsMultiplier: 0.25, // savings from switching to on-demand
  dynamoDBAutoScalingSavingsMultiplier: 0.30, // savings from enabling auto-scaling
  ecsEC2ToFargateSavingsMultiplier: 0.30, // EC2→Fargate migration savings
  ecsOverProvisionedSavingsMultiplier: 0.30, // over-provisioned task reduction savings
  s3LifecycleSavingsMultiplier: 0.15, // lifecycle rules savings
  s3IntelligentTieringSavingsMultiplier: 0.10, // intelligent tiering savings
  rdsIdleMultiplier: 0.90, // 0.90: RDS storage costs persist after stop (10% overhead retained)
  rdsRightsizeMultiplier: 0.40,
  rdsMultiAZMultiplier: 0.50,
  rdsGP2GP3Multiplier: 0.20,
  rdsGravitonMultiplier: 0.15,
  rdsRIDiscountMultiplier: 0.33,
  rdsStorageHeadroomRatio: 1.30, // headroom multiplier for storage reduction suggestions
} as const;

type Thresholds = typeof THRESHOLDS;
export type ThresholdsOverride = Partial<{
  [K in keyof Thresholds]: Thresholds[K] extends readonly string[]
    ? string[]
    : Thresholds[K] extends number
      ? number
      : Thresholds[K];
}>;
