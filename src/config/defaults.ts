import { defaultStoragePath } from './paths.js';
import { DEFAULT_MODEL } from './types.js';
import type { Config } from './types.js';

/**
 * Regional pricing differentials relative to us-east-1 baseline.
 * Source: AWS regional pricing differentials (approximate, us-east-1 baseline). Update as pricing changes.
 */
export const DEFAULT_REGIONAL_PREMIUMS: Record<string, number> = {
  'ap-northeast-1': 0.15, // Tokyo: ~15% more expensive
  'ap-northeast-2': 0.12, // Seoul
  'ap-southeast-1': 0.12, // Singapore
  'ap-southeast-2': 0.12, // Sydney
  'eu-central-1': 0.10, // Frankfurt: ~10% more
  'eu-west-2': 0.10, // London
  'eu-west-3': 0.10, // Paris
  'sa-east-1': 0.20, // São Paulo: ~20% more expensive
  'me-south-1': 0.15, // Bahrain
};

/**
 * Returns a Config object populated with all default values.
 * Mirrors Go's config.Defaults().
 */
export function defaults(): Config {
  return {
    version: 1,

    aws: {
      default_profile: '',
      default_region: 'us-east-1',
      profiles: {},
    },

    ai: {
      provider: 'none',
      model: DEFAULT_MODEL,
      api_key_env: 'ANTHROPIC_API_KEY',
      max_tokens: 16384,
      max_recommendations: 20,
      temperature: 0.3,
      thinking_budget: 0,
      extended_thinking: false,
      confirm_threshold_usd: 0.01,
      confirm_threshold_sec: 10,
      max_budget_usd: 0.50,
      timeout_ms: 300_000,
      redaction_level: 'moderate' as const,
      prompt_max_resources: 30,
      prompt_max_recommendations: 20,
    },

    terraform: {
      default_path: '.',
      state_file: '',
      security_scan: true,
      builtin_rules: true,
      cost_estimation: true,
    },

    github: {
      token_env: 'GITHUB_TOKEN',
      default_org: '',
      pr_draft: true,
      pr_labels: ['korinfra', 'cost-optimization'],
    },

    output: {
      // "table" is handled by the agent layer; file-level default is json
      default_format: 'json',
      color: true,
      verbose: false,
      currency: 'USD',
    },

    storage: {
      path: defaultStoragePath(),
      retention_days: 365,
    },

    scan: {
      lookback_days: 30,
      include_idle: true,
      min_cost_threshold: 0.01,
      max_parallel_regions: 4,
      service_timeout_ms: 30_000,
      collection_timeout_ms: 60_000,
      cost_explorer_cache_ttl_hours: 6,
      metric_period: '14d',
      idle_cpu_threshold: 5.0,
      rightsize_cpu_threshold: 30.0,
      stopped_instance_days: 7,
      snapshot_retention_days: 90,
      required_tags: ['Environment', 'Team', 'Project'],
      pricing_cache_ttl_days: 7,
      impact_high_threshold: 100.0,
      impact_medium_threshold: 25.0,

      // RDS thresholds
      rds_idle_cpu_threshold: 1.0,
      rds_rightsize_cpu_threshold: 15.0,

      // ElastiCache thresholds
      cache_memory_threshold: 10.0,

      // Lambda thresholds
      lambda_low_invocations: 100,

      // NAT Gateway thresholds
      nat_low_traffic_gb: 1.0,
      nat_endpoint_traffic_gb: 5.0,

      // Service idle thresholds
      ecs_idle_days: 3,
      elb_idle_days: 7,

      // General thresholds
      region_cost_threshold: 100.0,
      scenario_a_cost_risk: 200.0,

      // Rightsizing advanced
      cpu_high_p95_threshold: 80.0,
      memory_low_threshold: 20.0,
      min_data_points: 168,
      min_period_days: 14,

      // ElastiCache idle thresholds
      elasticache_idle_cpu_threshold: 2.0,
      elasticache_idle_memory_threshold: 5.0,

      // Age-based thresholds
      on_demand_running_days: 30,
      snapshot_max_age_days: 365,
      instance_max_age_days: 365,

      // RDS advanced thresholds
      rds_min_cost_for_ri: 20.0,
      rds_ri_cpu_threshold: 15.0,
      rds_min_storage_gb: 100.0,
      rds_free_storage_ratio: 0.7,
      rds_connection_idle_threshold: 1.0,

      // ECS thresholds
      ecs_min_cpu_threshold: 20.0,
      ecs_min_desired_count: 3,

      // Lambda thresholds
      lambda_min_memory_mb: 512,
      lambda_error_rate_threshold: 10.0,

      // Load balancer thresholds
      lb_idle_traffic_mb: 0.1,

      // EBS thresholds
      gp3_iops_baseline: 3000,

      // Classifier
      fuzzy_match_threshold: 0.7,

      // Scenario confidence — dynamic per attribute count
      scenario_confidence_base: 0.50,
      scenario_confidence_step: 0.075,
      scenario_confidence_max: 0.95,
      scenario_confidence_state_base: 0.80,

      // Savings multipliers
      savings_multipliers: {
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
      },
    },

    anomaly: {
      z_score_threshold: 2.0,
      pct_threshold: 20.0,
      min_cost: 1.0,
      rolling_window_days: 14,

      // Severity z-score tier cutoffs
      critical_z_score: 4.0,
      high_z_score: 3.0,
      medium_z_score: 2.5,

      // Trend analysis
      trend_min_data_points: 5,
      trend_significance_threshold: 0.01,
      forecast_days: 30,
    },

    quality: {
      excellent_threshold: 85,
      good_threshold: 70,
      fair_threshold: 50,
      savings_tier_high: 500,
      savings_tier_medium: 100,
      savings_tier_low: 20,
      title_min_length: 10,
      title_max_length: 80,
      description_full_length: 80,
      description_partial_length: 30,
      reasoning_full_length: 50,
      actionability_confidence_threshold: 0.9,
      actionability_max_bonus: 5,
      min_confidence_threshold: 0.40,
      savings_pct_high: 0.20,
      savings_pct_medium: 0.05,
    },

    mcp: {
      session_cost_limit: 1000,
      max_sessions: 100,
      http_rate_limit: 300,
      session_idle_timeout_ms: 1_800_000,
    },
  };
}
