import { z } from 'zod';

// ─── Shared Constants ────────────────────────────────────────────────────────

export const REPO_URL = 'https://github.com/korinfra/korinfra';
export const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
export const DEFAULT_MCP_PORT = 3000;

// ─── AWS ─────────────────────────────────────────────────────────────────────

const AWSProfileSchema = z.object({
  profile: z.string().max(64).default(''),
  role_arn: z.string().max(2048).default(''),
  external_id: z.string().max(1024).default(''),
  regions: z.array(z.string().max(32).regex(/^[a-z]{2,4}-[a-z]+-\d[a-z]?$/, 'Invalid AWS region format (e.g. us-east-1)')).max(100).default([]),
});

const AWSConfigSchema = z.object({
  default_profile: z.string().max(64).default(''),
  default_region: z.string().max(32).default('us-east-1'),
  profiles: z.record(z.string(), AWSProfileSchema).default({}),
});

// ─── AI ──────────────────────────────────────────────────────────────────────

const AIConfigSchema = z.object({
  provider: z.enum(['none', 'claude']).default('none'),
  model: z.string().max(128).default(DEFAULT_MODEL),
  api_key_env: z.string().max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default('ANTHROPIC_API_KEY'),
  max_tokens: z.number().int().min(1).max(200000).default(16384),
  max_recommendations: z.number().int().nonnegative().default(20),
  temperature: z.number().min(0).max(2).default(0.3),
  thinking_budget: z.number().int().nonnegative().default(0),
  extended_thinking: z.boolean().default(false),
  /** Show cost/time confirmation gate before AI calls above this USD threshold. */
  confirm_threshold_usd: z.number().nonnegative().default(0.01),
  /** Show confirmation gate before AI calls estimated above this duration in seconds. */
  confirm_threshold_sec: z.number().nonnegative().default(10),
  /** Per-command AI spend cap in USD. Agent stops when this limit is reached. */
  max_budget_usd: z.number().nonnegative().default(0.50),
  /** Agent timeout in milliseconds. Fix command uses 3× this value. */
  timeout_ms: z.number().int().positive().default(300_000),
  /** Redaction level applied to AWS data before sending to AI: minimal | moderate | strict. */
  redaction_level: z.enum(['minimal', 'moderate', 'strict']).default('moderate'),
  /** Max resources included in AI analysis prompts. Increase for large environments (>200 resources). */
  prompt_max_resources: z.number().int().min(10).default(30),
  /** Max recommendations included in AI analysis prompts. */
  prompt_max_recommendations: z.number().int().min(5).default(20),
});

// ─── Terraform ───────────────────────────────────────────────────────────────

const TerraformConfigSchema = z.object({
  default_path: z.string().max(1024).default('.'),
  state_file: z.string().max(1024).default(''),
  security_scan: z.boolean().default(true),
  builtin_rules: z.boolean().default(true),
  cost_estimation: z.boolean().default(true),
});

// ─── GitHub ──────────────────────────────────────────────────────────────────

const GitHubConfigSchema = z.object({
  token_env: z.string().max(128).default('GITHUB_TOKEN'),
  default_org: z.string().max(128).default(''),
  pr_draft: z.boolean().default(true),
  pr_labels: z.array(z.string().max(50)).max(100).default(['korinfra', 'cost-optimization']),
});

// ─── Output ──────────────────────────────────────────────────────────────────

const OutputConfigSchema = z.object({
  /** Valid values: json | csv | html. Table/markdown formatting is handled by the agent layer. */
  default_format: z.enum(['json', 'csv', 'html']).default('json'),
  color: z.boolean().default(true),
  verbose: z.boolean().default(false),
  currency: z.string().length(3).default('USD'),
});

// ─── Storage ─────────────────────────────────────────────────────────────────

const StorageConfigSchema = z.object({
  path: z.string().max(1024).default(''),
  retention_days: z.number().int().min(1).max(3650).default(365),
});

// ─── Scan ────────────────────────────────────────────────────────────────────

const ScanConfigSchema = z.object({
  lookback_days: z.number().int().min(1).max(365).default(30),
  include_idle: z.boolean().default(true),
  min_cost_threshold: z.number().positive().default(0.01),
  max_parallel_regions: z.number().int().min(1).default(4),
  service_timeout_ms: z.number().int().min(1000).default(30_000),
  collection_timeout_ms: z.number().int().min(5000).default(60_000),
  cost_explorer_cache_ttl_hours: z.number().positive().default(6),
  metric_period: z.enum(['1d', '7d', '14d', '30d']).default('14d'),
  idle_cpu_threshold: z.number().nonnegative().max(100).default(5.0),
  rightsize_cpu_threshold: z.number().nonnegative().max(100).default(30.0),
  stopped_instance_days: z.number().int().min(1).default(7),
  snapshot_retention_days: z.number().int().min(1).default(90),
  required_tags: z.array(z.string().max(128)).max(100).default(['Environment', 'Team', 'Project']),
  pricing_cache_ttl_days: z.number().int().min(1).default(7),
  impact_high_threshold: z.number().positive().default(100.0),
  impact_medium_threshold: z.number().positive().default(25.0),

  // RDS thresholds
  rds_idle_cpu_threshold: z.number().nonnegative().max(100).default(1.0),
  rds_rightsize_cpu_threshold: z.number().nonnegative().max(100).default(15.0),

  // ElastiCache thresholds
  cache_memory_threshold: z.number().nonnegative().default(10.0),

  // Lambda thresholds
  lambda_low_invocations: z.number().int().nonnegative().default(100),

  // NAT Gateway thresholds
  nat_low_traffic_gb: z.number().nonnegative().default(1.0),
  nat_endpoint_traffic_gb: z.number().nonnegative().default(5.0),

  // Service idle thresholds
  ecs_idle_days: z.number().int().min(1).default(3),
  elb_idle_days: z.number().int().min(1).default(7),

  // General thresholds
  region_cost_threshold: z.number().positive().default(100.0),
  scenario_a_cost_risk: z.number().positive().default(200.0),

  // Rightsizing advanced
  cpu_high_p95_threshold: z.number().nonnegative().max(100).default(80.0),
  memory_low_threshold: z.number().nonnegative().max(100).default(20.0),
  min_data_points: z.number().int().min(1).default(168),
  min_period_days: z.number().int().min(1).default(14),

  // ElastiCache idle thresholds
  elasticache_idle_cpu_threshold: z.number().nonnegative().max(100).default(2.0),
  elasticache_idle_memory_threshold: z.number().nonnegative().max(100).default(5.0),

  // Age-based thresholds
  on_demand_running_days: z.number().int().min(1).default(30),
  snapshot_max_age_days: z.number().int().min(1).default(365),
  instance_max_age_days: z.number().int().min(1).default(365),

  // RDS advanced thresholds
  rds_min_cost_for_ri: z.number().nonnegative().default(20.0),
  rds_ri_cpu_threshold: z.number().nonnegative().max(100).default(15.0),
  rds_min_storage_gb: z.number().nonnegative().default(100.0),
  rds_free_storage_ratio: z.number().min(0).max(1).default(0.7),
  rds_connection_idle_threshold: z.number().nonnegative().default(1.0),

  // ECS thresholds
  ecs_min_cpu_threshold: z.number().nonnegative().max(100).default(20.0),
  ecs_min_desired_count: z.number().int().min(1).default(3),

  // Lambda thresholds
  lambda_min_memory_mb: z.number().int().min(128).default(512),
  lambda_error_rate_threshold: z.number().nonnegative().max(100).default(10.0),

  // Load balancer thresholds
  lb_idle_traffic_mb: z.number().nonnegative().default(0.1),

  // EBS thresholds
  gp3_iops_baseline: z.number().int().positive().default(3000),

  // Classifier fuzzy match threshold (0.0–1.0)
  fuzzy_match_threshold: z.number().min(0).max(1).default(0.7),

  // Scenario A confidence — dynamic formula: base + step * attributeCount, capped at max
  scenario_confidence_base: z.number().min(0).max(1).default(0.50),
  scenario_confidence_step: z.number().min(0).max(1).default(0.075),
  scenario_confidence_max: z.number().min(0).max(1).default(0.95),
  /** Higher base for state-only resources — state file is authoritative */
  scenario_confidence_state_base: z.number().min(0).max(1).default(0.80),

  // Savings multipliers (0.0–1.0) for cost recommendations
  savings_multipliers: z.object({
    ec2_idle_stop: z.number().min(0).max(1).default(0.80),
    ec2_stopped_ebs: z.number().min(0).max(1).default(0.10),
    ec2_previous_gen: z.number().min(0).max(1).default(0.15),
    ec2_rightsize: z.number().min(0).max(1).default(0.60),
    ec2_ri_discount: z.number().min(0).max(1).default(0.40),
    ec2_graviton: z.number().min(0).max(1).default(0.20),
    rds_idle: z.number().min(0).max(1).default(0.90),
    rds_rightsize: z.number().min(0).max(1).default(0.40),
    rds_multi_az: z.number().min(0).max(1).default(0.50),
    rds_gp2_gp3: z.number().min(0).max(1).default(0.20),
    rds_graviton: z.number().min(0).max(1).default(0.15),
  }).default(() => ({
    ec2_idle_stop: 0.80,
    ec2_stopped_ebs: 0.10,
    ec2_previous_gen: 0.15,
    ec2_rightsize: 0.60,
    ec2_ri_discount: 0.40,
    ec2_graviton: 0.20,
    rds_idle: 0.90,
    rds_rightsize: 0.40,
    rds_multi_az: 0.50,
    rds_gp2_gp3: 0.20,
    rds_graviton: 0.15,
  })),
});

// ─── Quality ─────────────────────────────────────────────────────────────────

const QualityConfigSchema = z.object({
  /** Score >= this = "excellent" label. */
  excellent_threshold: z.number().min(0).max(100).default(85),
  /** Score >= this = "good" label. */
  good_threshold: z.number().min(0).max(100).default(70),
  /** Score >= this = "fair" label (below = "poor"). */
  fair_threshold: z.number().min(0).max(100).default(50),

  /** Savings tier cutoffs (USD/month) → impact points 15/12/8/4. */
  savings_tier_high: z.number().nonnegative().default(500),
  savings_tier_medium: z.number().nonnegative().default(100),
  savings_tier_low: z.number().nonnegative().default(20),

  /** Title length window for max clarity points. */
  title_min_length: z.number().int().nonnegative().default(10),
  title_max_length: z.number().int().positive().default(80),

  /** Description length tier for full clarity points. */
  description_full_length: z.number().int().nonnegative().default(80),
  description_partial_length: z.number().int().nonnegative().default(30),

  /** Reasoning length for full evidence points. */
  reasoning_full_length: z.number().int().nonnegative().default(50),

  /** Confidence midpoint for smooth actionability bonus curve (linear 0→max_bonus over [midpoint, 1.0]). */
  actionability_confidence_threshold: z.number().min(0).max(1).default(0.9),
  /** Max actionability bonus points awarded at confidence = 1.0. */
  actionability_max_bonus: z.number().nonnegative().default(5),

  /** Recommendations with confidence below this are dropped as not actionable. */
  min_confidence_threshold: z.number().min(0).max(1).default(0.40),

  /** Bonus impact points when savings ≥ savings_pct_high of total monthly cost (relative impact). */
  savings_pct_high: z.number().min(0).max(1).default(0.20),
  savings_pct_medium: z.number().min(0).max(1).default(0.05),
});

// ─── Anomaly ─────────────────────────────────────────────────────────────────

const AnomalyConfigSchema = z.object({
  z_score_threshold: z.number().positive().default(2.0),
  pct_threshold: z.number().nonnegative().max(100).default(20.0),
  min_cost: z.number().positive().default(1.0),
  rolling_window_days: z.number().int().min(1).default(14),

  // Severity z-score tier cutoffs
  critical_z_score: z.number().positive().default(4.0),
  high_z_score: z.number().positive().default(3.0),
  medium_z_score: z.number().positive().default(2.5),

  // Trend analysis
  trend_min_data_points: z.number().int().min(1).default(5),
  trend_significance_threshold: z.number().nonnegative().max(1).default(0.01),
  forecast_days: z.number().int().min(1).default(30),
});

// ─── MCP ─────────────────────────────────────────────────────────────────────

const MCPConfigSchema = z.object({
  session_cost_limit: z.number().int().positive().default(1000),
  max_sessions: z.number().int().positive().default(100),
  http_rate_limit: z.number().int().positive().default(300),
  session_idle_timeout_ms: z.number().int().min(60_000).default(1_800_000),
});

// ─── Top-level Config ─────────────────────────────────────────────────────────

export const ConfigSchema = z.object({
  version: z.number().int().default(1),
  aws: AWSConfigSchema.default(() => AWSConfigSchema.parse({})),
  ai: AIConfigSchema.default(() => AIConfigSchema.parse({})),
  terraform: TerraformConfigSchema.default(() => TerraformConfigSchema.parse({})),
  github: GitHubConfigSchema.default(() => GitHubConfigSchema.parse({})),
  output: OutputConfigSchema.default(() => OutputConfigSchema.parse({})),
  storage: StorageConfigSchema.default(() => StorageConfigSchema.parse({})),
  scan: ScanConfigSchema.default(() => ScanConfigSchema.parse({})),
  anomaly: AnomalyConfigSchema.default(() => AnomalyConfigSchema.parse({})),
  quality: QualityConfigSchema.default(() => QualityConfigSchema.parse({})),
  mcp: MCPConfigSchema.default(() => MCPConfigSchema.parse({})),
});

// ─── Inferred TypeScript types ────────────────────────────────────────────────

export type AWSProfile = z.infer<typeof AWSProfileSchema>;
export type AWSConfig = z.infer<typeof AWSConfigSchema>;
export type AIConfig = z.infer<typeof AIConfigSchema>;
export type TerraformConfig = z.infer<typeof TerraformConfigSchema>;
export type GitHubConfig = z.infer<typeof GitHubConfigSchema>;
export type OutputConfig = z.infer<typeof OutputConfigSchema>;
export type StorageConfig = z.infer<typeof StorageConfigSchema>;
export type ScanConfig = z.infer<typeof ScanConfigSchema>;
export type AnomalyConfig = z.infer<typeof AnomalyConfigSchema>;
export type QualityConfig = z.infer<typeof QualityConfigSchema>;
export type MCPConfig = z.infer<typeof MCPConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;
