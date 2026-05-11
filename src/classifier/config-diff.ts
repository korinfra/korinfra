/**
 * Config diff detection — ports Go internal/classifier/config-diff.go.
 *
 * For each Scenario B matched pair, compares Terraform configuration against
 * live AWS configuration and reports fields that differ.
 */

import type { ConfigDiffField, MatchedPair } from './types.js';

// ---------------------------------------------------------------------------
// Config diff field specs per normalized resource type
// ---------------------------------------------------------------------------

interface ConfigDiffSpec {
  field: string;
  severity: ConfigDiffField['severity'];
  /** If set, use this key when reading from TF config (instead of field). */
  tfKey?: string;
  /** If set, use this key when reading from AWS config (instead of field). */
  awsKey?: string;
  /** When true, comparison is case-sensitive. Defaults to false. */
  caseSensitive?: boolean;
}

const configDiffSpecs: Record<string, ConfigDiffSpec[]> = {
  ec2_instance: [
    { field: 'instance_type', severity: 'high' },
    { field: 'ami', severity: 'high' },
    {
      field: 'vpc_security_group_ids',
      severity: 'high',
      tfKey: 'vpc_security_group_ids',
      awsKey: 'security_groups',
      caseSensitive: true,
    },
    { field: 'iam_instance_profile', severity: 'high', caseSensitive: true },
    { field: 'tags', severity: 'low' },
    { field: 'monitoring', severity: 'medium' },
  ],
  rds_cluster_instance: [
    { field: 'instance_class', severity: 'high' },
    { field: 'engine', severity: 'high' },
    { field: 'publicly_accessible', severity: 'high' },
    { field: 'performance_insights_enabled', severity: 'medium' },
  ],
  rds_instance: [
    { field: 'instance_class', severity: 'high' },
    { field: 'engine_version', severity: 'medium' },
    { field: 'multi_az', severity: 'high' },
    { field: 'storage_encrypted', severity: 'high' },
    { field: 'publicly_accessible', severity: 'high' },
    { field: 'backup_retention_period', severity: 'medium' },
    { field: 'storage_type', severity: 'medium' },
  ],
  s3_bucket: [
    { field: 'versioning', severity: 'medium' },
    {
      field: 'server_side_encryption_configuration',
      severity: 'high',
      tfKey: 'server_side_encryption_configuration',
      awsKey: 'encryption',
    },
    {
      field: 'public_access_block_configuration',
      severity: 'high',
      tfKey: 'public_access_block_configuration',
      awsKey: 'public_access_block',
    },
    { field: 'lifecycle_rule', severity: 'medium' },
  ],
  lambda_function: [
    { field: 'runtime', severity: 'high' },
    { field: 'memory_size', severity: 'medium' },
    { field: 'timeout', severity: 'low' },
    { field: 'handler', severity: 'high' },
    { field: 'architectures', severity: 'medium' },
  ],
  dynamodb_table: [
    { field: 'billing_mode', severity: 'high' },
    { field: 'read_capacity', severity: 'medium', tfKey: 'read_capacity', awsKey: 'read_capacity_units' },
    { field: 'write_capacity', severity: 'medium', tfKey: 'write_capacity', awsKey: 'write_capacity_units' },
  ],
  load_balancer: [
    { field: 'scheme', severity: 'high' },
    { field: 'ip_address_type', severity: 'medium' },
  ],
  elasticache_cluster: [
    { field: 'node_type', severity: 'high', tfKey: 'node_type', awsKey: 'cache_node_type' },
    { field: 'engine_version', severity: 'medium' },
    { field: 'num_cache_nodes', severity: 'high' },
    {
      field: 'parameter_group_name',
      severity: 'medium',
      tfKey: 'parameter_group_name',
      awsKey: 'cache_parameter_group',
    },
  ],
  nat_gateway: [
    { field: 'connectivity_type', severity: 'medium' },
    { field: 'subnet_id', severity: 'high', caseSensitive: true },
  ],
  ecs_service: [
    { field: 'desired_count', severity: 'medium' },
    { field: 'launch_type', severity: 'high' },
    { field: 'platform_version', severity: 'medium' },
    { field: 'deployment_maximum_percent', severity: 'low' },
  ],
  ebs_volume: [
    { field: 'volume_type', severity: 'high' },
    { field: 'size', severity: 'medium', tfKey: 'size', awsKey: 'size_gb' },
    { field: 'iops', severity: 'medium' },
    { field: 'encrypted', severity: 'high' },
  ],
  elastic_ip: [{ field: 'tags', severity: 'low' }],
};

// ---------------------------------------------------------------------------
// Value normalization
// ---------------------------------------------------------------------------

/** Normalizes a config value to a comparable string. */
function normalizeConfigValue(config: Record<string, unknown> | undefined, key: string): string {
  if (!config) return '';
  const val = config[key];
  if (val === undefined || val === null) return '';

  if (typeof val === 'string') return val.trim();
  if (typeof val === 'boolean') return String(val);
  if (typeof val === 'number') {
    // Emit integers without decimals (mirrors Go's int64 check).
    return Number.isInteger(val) ? String(val) : val.toFixed(2);
  }
  if (Array.isArray(val)) {
    // Sort list items so order differences don't produce false positives.
    const parts = val.map((item) => String(item));
    parts.sort();
    return parts.join(',');
  }
  if (typeof val === 'object') {
    return flattenMap(val as Record<string, unknown>);
  }
  return typeof val === 'string' || typeof val === 'number' ? String(val) : '[object]';
}

/** Converts a nested object to a deterministic string. Keys are sorted, recurses into nested objects. */
function flattenMap(m: Record<string, unknown>): string {
  const keys = Object.keys(m).sort();
  return keys.map((k) => {
    const v = m[k];
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      return `${k}={${flattenMap(v as Record<string, unknown>)}}`;
    }
    return `${k}=${String(v)}`;
  }).join(';');
}

// ---------------------------------------------------------------------------
// Severity ordering (for filtering)
// ---------------------------------------------------------------------------

const SEVERITY_LEVEL: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export function severityLevel(s: string): number {
  return SEVERITY_LEVEL[s] ?? 0;
}

// ---------------------------------------------------------------------------
// Core config diff detection
// ---------------------------------------------------------------------------

import { normalizeType } from './matcher.js';

// ---------------------------------------------------------------------------
// AWS-applied defaults — when TF omits a field, AWS sets these values.
// Suppress reports when tfVal is empty and awsVal matches the default.
// ---------------------------------------------------------------------------

const awsDefaults: Record<string, Record<string, string>> = {
  ec2_instance: { monitoring: 'false', ebs_optimized: 'false' },
  rds_instance: { multi_az: 'false', publicly_accessible: 'false', storage_encrypted: 'false' },
  ebs_volume: { encrypted: 'false' },
  lambda_function: { architectures: 'x86_64' },
  s3_bucket: { versioning: 'false' },
};

/** Detects config diffs for a single matched pair. */
function detectConfigDiffsForPair(pair: MatchedPair): ConfigDiffField[] {
  const specs = configDiffSpecs[normalizeType(pair.terraform.type)];
  if (!specs) return [];

  // Prefer terraform.configuration as the TF-side source of truth — it
  // reflects what the user declared in .tf files. Fall back to state
  // attributes only when configuration is absent or empty (e.g. when the
  // resource was imported without a corresponding .tf file).
  const stateAttrs = pair.state?.attributes;
  const hasTfConfig = pair.terraform.configuration && Object.keys(pair.terraform.configuration).length > 0;
  const tfConfig: Record<string, unknown> =
    hasTfConfig ? pair.terraform.configuration : (stateAttrs ?? {});
  const awsConfig: Record<string, unknown> = (pair.aws.configuration) ?? {};

  const diffs: ConfigDiffField[] = [];

  for (const spec of specs) {
    const tfKey = spec.tfKey ?? spec.field;
    const awsKey = spec.awsKey ?? spec.field;

    const tfVal = normalizeConfigValue(tfConfig, tfKey);
    const awsVal = normalizeConfigValue(awsConfig, awsKey);

    // No diff if neither side defines the field.
    if (tfVal === '' && awsVal === '') continue;

    // Suppress false positives: TF omitted the field and AWS applied its
    // default. Only report when the AWS value differs from the default.
    if (tfVal === '' && awsVal !== '') {
      const resourceType = normalizeType(pair.terraform.type);
      const knownDefault = awsDefaults[resourceType]?.[spec.field];
      if (awsVal.toLowerCase() === knownDefault?.toLowerCase()) {
        continue;
      }
    }

    const isDifferent = spec.caseSensitive === true
      ? tfVal !== awsVal
      : tfVal.toLowerCase() !== awsVal.toLowerCase();

    if (isDifferent) {
      let { severity } = spec;
      let note: string | undefined;

      // ECS desired_count mismatch is expected for auto-scaled REPLICA services.
      // Auto-scaling manages the live count independently of TF config.
      if (
        normalizeType(pair.terraform.type) === 'ecs_service' &&
        spec.field === 'desired_count' &&
        (awsConfig['scheduling_strategy'] as string | undefined)?.toUpperCase() === 'REPLICA'
      ) {
        severity = 'low';
        note = 'ECS REPLICA service may be managed by auto-scaling; desired_count mismatch is expected';
      }

      diffs.push({
        field: spec.field,
        tfValue: tfVal,
        awsValue: awsVal,
        severity,
        ...(note !== undefined ? { note } : {}),
      });
    }
  }

  return diffs;
}

/**
 * Runs config diff detection for all matched pairs and returns new pairs with
 * the configDiffs field populated.
 */
export function detectConfigDiffs(pairs: MatchedPair[]): MatchedPair[] {
  return pairs.map((pair) => ({ ...pair, configDiffs: detectConfigDiffsForPair(pair) }));
}

/**
 * Filters config diff fields to only those at or above minSeverity.
 */
export function filterConfigDiffsBySeverity(diffs: ConfigDiffField[], minSeverity: string): ConfigDiffField[] {
  const min = severityLevel(minSeverity);
  return diffs.filter((d) => severityLevel(d.severity) >= min);
}
