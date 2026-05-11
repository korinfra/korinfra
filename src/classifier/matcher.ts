/**
 * Multi-pass resource matcher — ports Go internal/classifier/matcher.go.
 *
 * CONSERVATIVE: defaults to Scenario A when uncertain.
 * A false Scenario B match is worse than a false Scenario A because it could
 * lead to auto-fixing the wrong resource.
 */

import { createHash } from 'node:crypto';

import type { Resource } from '../aws/types.js';
import type { Classification, MatchedPair, StateResource, TerraformResource } from './types.js';

function stateResourceKey(s: StateResource): string {
  if (s.id) return s.id;
  if (s.arn) return s.arn;
  return createHash('sha256').update(JSON.stringify(s)).digest('hex');
}

// ---------------------------------------------------------------------------
// Type normalization: Terraform resource type → normalized internal type
// ---------------------------------------------------------------------------

const typeNormalization: Record<string, string> = {
  // EC2
  aws_instance: 'ec2_instance',
  aws_ebs_volume: 'ebs_volume',
  aws_eip: 'elastic_ip',
  aws_ebs_snapshot: 'ebs_snapshot',
  // RDS (instances + Aurora clusters)
  aws_db_instance: 'rds_instance',
  aws_rds_cluster: 'rds_cluster',
  aws_rds_cluster_instance: 'rds_cluster_instance',
  // S3
  aws_s3_bucket: 's3_bucket',
  // Lambda
  aws_lambda_function: 'lambda_function',
  aws_lambda_function_url: 'lambda_function',
  // ECS
  aws_ecs_cluster: 'ecs_cluster',
  aws_ecs_service: 'ecs_service',
  // DynamoDB
  aws_dynamodb_table: 'dynamodb_table',
  // ElastiCache
  aws_elasticache_cluster: 'elasticache_cluster',
  aws_elasticache_replication_group: 'elasticache_cluster',
  aws_elasticache_serverless_cache: 'elasticache_cluster',
  // ELB
  aws_lb: 'load_balancer',
  aws_alb: 'load_balancer',
  // NAT Gateway
  aws_nat_gateway: 'nat_gateway',
  // Auto Scaling
  aws_autoscaling_group: 'autoscaling_group',
  // EKS
  aws_eks_cluster: 'eks_cluster',
  aws_eks_node_group: 'eks_node_group',
};

export function normalizeType(resourceType: string): string {
  return typeNormalization[resourceType] ?? resourceType.replace(/^aws_/, '');
}

// Build reverse maps once at module load time.
const reverseTypeMap = new Map<string, string>();
const reverseTypeMapAll = new Map<string, string[]>();
for (const [tfType, normalized] of Object.entries(typeNormalization)) {
  const existing = reverseTypeMap.get(normalized);
  if (!existing || tfType.length < existing.length) {
    reverseTypeMap.set(normalized, tfType);
  }
  const arr = reverseTypeMapAll.get(normalized) ?? [];
  arr.push(tfType);
  reverseTypeMapAll.set(normalized, arr);
}

/** Reverse lookup: normalized type → canonical (shortest) Terraform type. */
export function tfTypeForAWS(awsType: string): string {
  return reverseTypeMap.get(awsType) ?? `aws_${awsType}`;
}

/** Reverse lookup: normalized type → all matching Terraform types. */
export function tfTypesForAWS(awsType: string): string[] {
  return reverseTypeMapAll.get(awsType) ?? [`aws_${awsType}`];
}

// ---------------------------------------------------------------------------
// Comparable fields per resource type (for fuzzy / config-similarity matching)
// ---------------------------------------------------------------------------

const comparableFields: Record<string, string[]> = {
  ec2_instance: ['instance_type', 'ami', 'subnet_id', 'availability_zone'],
  rds_instance: ['instance_class', 'engine', 'engine_version', 'db_name'],
  rds_cluster_instance: ['instance_class', 'engine', 'cluster_identifier', 'publicly_accessible'],
  s3_bucket: ['bucket', 'acl', 'region'],
  lambda_function: ['function_name', 'runtime', 'handler', 'memory_size'],
  dynamodb_table: ['name', 'billing_mode', 'hash_key'],
  load_balancer: ['name', 'scheme', 'ip_address_type'],
  ecs_service: ['name', 'cluster', 'task_definition'],
  autoscaling_group: ['name', 'min_size', 'max_size'],
  eks_cluster: ['name', 'version'],
  elasticache_cluster: ['node_type', 'engine', 'num_cache_nodes'],
  nat_gateway: ['subnet_id', 'connectivity_type'],
  ecs_cluster: ['name'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractConfigString(config: Record<string, unknown> | undefined, key: string): string {
  if (!config) return '';
  const v = config[key];
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return '[object]';
}

function normalizeComparableValue(value: string): string {
  return value.trim().toLowerCase();
}

function buildComparableValueMap(
  config: Record<string, unknown> | undefined,
  fields: string[],
): Map<string, string> {
  const values = new Map<string, string>();
  for (const field of fields) {
    const raw = extractConfigString(config, field);
    if (!raw) continue;
    const normalized = normalizeComparableValue(raw);
    if (normalized) values.set(field, normalized);
  }
  return values;
}

/**
 * Computes a similarity score (0.0-1.0) from pre-normalized comparable fields.
 */
function configSimilarity(
  fields: string[],
  tfComparable: ReadonlyMap<string, string>,
  awsComparable: ReadonlyMap<string, string>,
): number {
  let matchCount = 0;
  let totalCompared = 0;

  for (const field of fields) {
    const tfVal = tfComparable.get(field) ?? '';
    const awsVal = awsComparable.get(field) ?? '';
    if (tfVal === '' && awsVal === '') continue; // absent on both sides — skip
    totalCompared++;
    if (tfVal === awsVal) matchCount++;
  }

  if (totalCompared === 0) return 0;
  return matchCount / totalCompared;
}

/** Deduplicates AWS resources by (type + id + region). */
function deduplicateAWSResources(resources: Resource[]): Resource[] {
  const seen = new Set<string>();
  const result: Resource[] = [];
  for (const r of resources) {
    const key = `${r.type}|${r.id}|${r.region}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(r);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Classifier options
// ---------------------------------------------------------------------------

export interface MatcherOptions {
  /**
   * Minimum config similarity for Pass 4 fuzzy matching (0.0-1.0).
   * Higher = fewer false positives. Default: 0.7.
   */
  fuzzyMatchThreshold?: number;
}

// ---------------------------------------------------------------------------
// Main classifier
// ---------------------------------------------------------------------------

/**
 * Classifies resources into three scenarios via 4-pass matching:
 * - Scenario A (terraformOnly): in .tf but not found in AWS
 * - Scenario B (matched): exists in both — check for config mismatches
 * - Scenario C (awsOnly): in AWS but not tracked in Terraform
 *
 * CONSERVATIVE: defaults to Scenario A when uncertain.
 */
export function classifyResources(
  awsResources: Resource[],
  tfResources: TerraformResource[],
  stateResources: StateResource[] = [],
  opts: MatcherOptions = {},
): Classification {
  const fuzzyThreshold = opts.fuzzyMatchThreshold ?? 0.7;

  // --- Prepare TF entries with normalized types --------------------------
  type TFEntry = { resource: TerraformResource; normalizedType: string; matched: boolean };
  const tfEntries: TFEntry[] = tfResources.map((r) => ({
    resource: r,
    normalizedType: normalizeType(r.type),
    matched: false,
  }));

  // --- Deduplicate AWS resources -----------------------------------------
  const awsDeduped = deduplicateAWSResources(awsResources);
  const awsMatched = new Array<boolean>(awsDeduped.length).fill(false);

  // --- Build AWS lookup maps --------------------------------------------
  const awsByARN = new Map<string, number>();   // ARN → index
  const awsByTypeID = new Map<string, number>(); // "type|id" → index
  for (let i = 0; i < awsDeduped.length; i++) {
    const r = awsDeduped[i];
    if (!r) continue;
    if (r.arn) awsByARN.set(r.arn, i);
    if (r.id) awsByTypeID.set(`${r.type}|${r.id}`, i);
  }

  // --- Build state lookup multimap ------------------------------------
  // count/for_each can produce multiple state resources with the same type+name
  // key. Use an array per key so none are lost.
  const stateByTypeName = new Map<string, StateResource[]>(); // "type|name" → states
  for (const s of stateResources) {
    const key = `${s.type}|${s.name}`;
    const arr = stateByTypeName.get(key) ?? [];
    arr.push(s);
    stateByTypeName.set(key, arr);
  }
  // Track which state resource IDs have already been consumed by a match.
  const matchedStateIds = new Set<string>();

  /** Returns the first unmatched state resource for a given type|name key. */
  function findUnmatchedState(key: string): StateResource | undefined {
    const arr = stateByTypeName.get(key);
    if (!arr) return undefined;
    return arr.find((s) => !matchedStateIds.has(stateResourceKey(s)));
  }

  function consumeState(s: StateResource): void {
    matchedStateIds.add(stateResourceKey(s));
  }

  const matched: MatchedPair[] = [];

  // =========================================================================
  // Pass 1: Exact ARN match via state file (confidence: 1.0)
  // =========================================================================
  for (const entry of tfEntries) {
    if (entry.matched) continue;
    const state = findUnmatchedState(`${entry.resource.type}|${entry.resource.name}`);
    if (!state?.arn) continue;

    const awsIdx = awsByARN.get(state.arn);
    if (awsIdx === undefined || awsMatched[awsIdx]) {
      // State entry exists (resource was applied) but no AWS resource matches
      // the state ARN — the resource was destroyed outside of Terraform.
      // Mark so downstream scenario recommendations can distinguish this from
      // "never applied".
      entry.resource.destroyedInAws = true;
      continue;
    }

    const aws = awsDeduped[awsIdx];
    if (entry.normalizedType !== aws?.type) continue;

    matched.push({
      terraform: entry.resource,
      aws,
      state,
      confidence: 1.0,
      matchType: 'arn',
      configDiffs: [],
    });
    entry.matched = true;
    awsMatched[awsIdx] = true;
    consumeState(state);
  }

  // =========================================================================
  // Pass 2: Resource type + AWS resource ID match (confidence: 0.9–0.95)
  // =========================================================================
  for (const entry of tfEntries) {
    if (entry.matched) continue;

    // Try state file ID first (0.95).
    const state = findUnmatchedState(`${entry.resource.type}|${entry.resource.name}`);
    if (state?.id) {
      const awsIdx = awsByTypeID.get(`${entry.normalizedType}|${state.id}`);
      if (awsIdx !== undefined && !awsMatched[awsIdx]) {
        const awsRes = awsDeduped[awsIdx];
        if (!awsRes) continue;
        matched.push({
          terraform: entry.resource,
          aws: awsRes,
          state,
          confidence: 0.95,
          matchType: 'id',
          configDiffs: [],
        });
        entry.matched = true;
        awsMatched[awsIdx] = true;
        consumeState(state);
        continue;
      }
    }

    // Fall back to TF config "id" field (0.9).
    const configId = extractConfigString(entry.resource.configuration, 'id');
    if (configId) {
      const awsIdx = awsByTypeID.get(`${entry.normalizedType}|${configId}`);
      if (awsIdx !== undefined && !awsMatched[awsIdx]) {
        const awsRes = awsDeduped[awsIdx];
        if (!awsRes) continue;
        matched.push({
          terraform: entry.resource,
          aws: awsRes,
          confidence: 0.9,
          matchType: 'id',
          configDiffs: [],
        });
        entry.matched = true;
        awsMatched[awsIdx] = true;
        if (state) consumeState(state);
      }
    }
  }

  // --- Pre-computed index: name → AWS indices (for Pass 3 O(1) lookup) ----
  // Keys: lowercase Name tag or resource.name; values: indices into awsDeduped.
  const nameToAwsIndices = new Map<string, number[]>();
  for (let j = 0; j < awsDeduped.length; j++) {
    const aws = awsDeduped[j];
    if (!aws) continue;
    const name = (aws.tags?.['Name'] ?? aws.name)?.toLowerCase();
    if (name) {
      const arr = nameToAwsIndices.get(name) ?? [];
      arr.push(j);
      nameToAwsIndices.set(name, arr);
    }
  }

  // --- Pre-computed index: type → AWS indices (for Pass 4 O(1) lookup) ----
  const typeToAwsIndices = new Map<string, number[]>();
  for (let j = 0; j < awsDeduped.length; j++) {
    const awsEntry = awsDeduped[j];
    if (!awsEntry) continue;
    const type = awsEntry.type;
    const arr = typeToAwsIndices.get(type) ?? [];
    arr.push(j);
    typeToAwsIndices.set(type, arr);
  }

  // =========================================================================
  // Pass 3: Resource type + Name tag match (confidence: 0.6)
  // Low confidence — flagged for review.
  //
  // KNOWN LIMITATION: TF resource label names rarely match AWS Name tags.
  // The match also checks configuration['name'] and configuration['bucket']
  // from the TF side, which are more reliable than the resource label for
  // resource types that expose an explicit name attribute (e.g. S3 buckets,
  // DynamoDB tables, Lambda functions, ECS services).
  // =========================================================================
  for (const entry of tfEntries) {
    if (entry.matched) continue;

    // Build a set of candidate TF name strings to try (label + config name fields).
    const tfNameCandidates = new Set<string>();
    tfNameCandidates.add(entry.resource.name.toLowerCase());
    for (const nameKey of ['name', 'bucket', 'function_name', 'table_name', 'cluster_name']) {
      const v = extractConfigString(entry.resource.configuration, nameKey);
      if (v) tfNameCandidates.add(v.toLowerCase());
    }

    for (const candidateName of tfNameCandidates) {
      const indices = nameToAwsIndices.get(candidateName) ?? [];
      let found = false;
      for (const j of indices) {
        const awsCandidate = awsDeduped[j];
        if (!awsCandidate || awsMatched[j] || awsCandidate.type !== entry.normalizedType) continue;
        // Prefer the Name tag but fall back to resource.name — the primary
        // identifier for Lambda, DynamoDB, S3 and other services that use the
        // resource name rather than a tag for identification.
        matched.push({
          terraform: entry.resource,
          aws: awsCandidate,
          confidence: 0.6,
          matchType: 'name',
          configDiffs: [],
        });
        entry.matched = true;
        awsMatched[j] = true;
        found = true;
        break;
      }
      if (found) break;
    }
  }

  const tfComparableCache = tfEntries.map((entry) =>
    buildComparableValueMap(entry.resource.configuration, comparableFields[entry.normalizedType] ?? []),
  );
  const awsComparableCache = awsDeduped.map((aws) =>
    buildComparableValueMap(aws.configuration, comparableFields[aws.type] ?? []),
  );

  // =========================================================================
  // Pass 4: Config similarity / fuzzy match (confidence: max 0.42)
  // CONSERVATIVE: only accept when similarity >= fuzzyThreshold (default 70%).
  // =========================================================================
  for (let entryIdx = 0; entryIdx < tfEntries.length; entryIdx++) {
    const entry = tfEntries[entryIdx];
    if (!entry || entry.matched) continue;

    const fields = comparableFields[entry.normalizedType];
    if (!fields || fields.length === 0) continue;

    const tfComparable = tfComparableCache[entryIdx] ?? new Map<string, string>();

    let bestIdx = -1;
    let bestScore = 0;

    for (const j of typeToAwsIndices.get(entry.normalizedType) ?? []) {
      if (awsMatched[j]) continue;
      const awsCmp = awsComparableCache[j] ?? new Map<string, string>();
      const score = configSimilarity(fields, tfComparable, awsCmp);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = j;
      }
    }

    if (bestIdx >= 0 && bestScore >= fuzzyThreshold) {
      const bestAws = awsDeduped[bestIdx];
      if (!bestAws) continue;
      matched.push({
        terraform: entry.resource,
        aws: bestAws,
        confidence: Math.min(bestScore * 0.42, 0.42),
        matchType: 'fuzzy',
        configDiffs: [],
      });
      entry.matched = true;
      awsMatched[bestIdx] = true;
    }
  }

  // --- Collect unmatched resources ----------------------------------------
  const terraformOnly = tfEntries.filter((e) => !e.matched).map((e) => e.resource);
  const awsOnly = awsDeduped.filter((_, i) => !awsMatched[i]);

  return { matched, terraformOnly, awsOnly };
}
