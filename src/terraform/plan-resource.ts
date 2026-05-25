/**
 * Resource synthesis from Terraform plan resource_changes.
 *
 * Converts a `change.before` or `change.after` payload into:
 *   - `Resource` shape consumed by `CostEngine.estimateMonthlyCost`
 *     and `evaluateRules` (cost rules).
 *   - `TerraformResource` shape consumed by `evaluateSecurityRules`.
 *
 * Plus a `costStatus` flag that surfaces whether the cost figure is
 * trustworthy (`known`), variable with a fixed-base floor (`variable`),
 * unknown because `after_unknown` masks pricing fields (`partial-unknown` /
 * `unknown`), or unpriced because the resource type isn't supported by
 * the pricing engine (`unpriced`).
 */

import type { Resource } from '../aws/types.js';
import { asStr, boolValue, floatValue } from '../utils/coerce.js';
import { normalizeResourceType } from './parser.js';
import type { TerraformPlanChange, TerraformResourceChange } from './plan-parser.js';
import type { TerraformResource } from './types.js';

// ---------------------------------------------------------------------------
// Action normalization
// ---------------------------------------------------------------------------

export type NormalizedAction =
  | 'create'
  | 'update'
  | 'destroy'
  | 'replace'
  | 'no-op'
  | 'read';

/**
 * Map Terraform's `change.actions` arrays to a single normalized action.
 *
 * Replace flows come in two equivalent orderings: ["delete","create"]
 * (delete-before-create, default) and ["create","delete"] (create-before-
 * destroy when `create_before_destroy` is set).
 */
export function resolveAction(actions: readonly string[]): NormalizedAction {
  if (actions.length === 0) return 'no-op';
  if (actions.length === 1) {
    const first = actions[0] ?? '';
    switch (first) {
      case 'create':
        return 'create';
      case 'update':
        return 'update';
      case 'delete':
        return 'destroy';
      case 'read':
        return 'read';
      case 'no-op':
        return 'no-op';
      default:
        return 'no-op';
    }
  }
  if (actions.length === 2) {
    const set = new Set(actions);
    if (set.has('delete') && set.has('create')) return 'replace';
  }
  return 'no-op';
}

// ---------------------------------------------------------------------------
// Cost status
// ---------------------------------------------------------------------------

export type CostStatus =
  | 'known'           // All pricing fields resolved; deltaUsd is the real monthly cost
  | 'variable'        // Usage-dependent with a fixed-cost floor (Lambda, S3, DynamoDB on-demand)
  | 'partial-unknown' // Best-effort cost; some fields unknown (e.g. ECS task def unresolved)
  | 'unknown'         // Pricing-critical field masked (e.g. instance_type); deltaUsd = 0
  | 'unpriced';       // Resource type not in the pricing engine; excluded from net total

// ---------------------------------------------------------------------------
// Task definition index (for ECS service resolution)
// ---------------------------------------------------------------------------

export interface TaskDefEntry {
  cpu: number;
  memory: number;
  moduleAddress: string;
}

export interface TaskDefIndex {
  /** Keyed by: plan address | family | family:revision | arn */
  byKey: Map<string, TaskDefEntry>;
  /** Keyed by moduleAddress → single entry, or null when multiple task defs exist in the same module */
  byModule: Map<string, TaskDefEntry | null>;
}

/**
 * Build a lookup index of all aws_ecs_task_definition resources in a plan's
 * resource_changes list. Used by synthesizeResource to resolve the CPU/memory
 * for aws_ecs_service resources in the same plan.
 *
 * Indexes each task def by:
 *   1. Plan address ("aws_ecs_task_definition.api")
 *   2. family ("api") — removed when two task defs share the same family (ambiguous)
 *   3. family:revision ("api:3") — only when both are known at plan time
 *   4. ARN ("arn:aws:ecs:...") — only when known at plan time
 */
export function buildTaskDefIndex(changes: readonly TerraformResourceChange[]): TaskDefIndex {
  const byKey = new Map<string, TaskDefEntry>();
  const byModule = new Map<string, TaskDefEntry | null>();
  const ambiguousFamilies = new Set<string>();

  for (const change of changes) {
    if (change.type !== 'aws_ecs_task_definition') continue;
    const action = resolveAction(change.change.actions);
    if (action === 'destroy' || action === 'no-op' || action === 'read') continue;

    const after = change.change.after;
    if (after === null || after === undefined) continue;

    const afterUnknown = change.change.after_unknown ?? {};
    if (afterUnknown['cpu'] === true || afterUnknown['memory'] === true) continue;

    const cpu = floatValue(after['cpu']);
    const memory = floatValue(after['memory']);
    if (cpu <= 0 || memory <= 0) continue;

    const moduleAddress = change.module_address ?? '';
    const family = asStr(after['family']);
    const arn = asStr(after['arn']);
    const entry: TaskDefEntry = { cpu, memory, moduleAddress };

    byKey.set(change.address, entry);

    if (family !== '' && afterUnknown['family'] !== true) {
      if (!ambiguousFamilies.has(family)) {
        if (byKey.has(family)) {
          // Second task def with the same family — bare-family key is ambiguous.
          byKey.delete(family);
          ambiguousFamilies.add(family);
        } else {
          byKey.set(family, entry);
        }
      }
      const revision = floatValue(after['revision']);
      if (revision > 0 && afterUnknown['revision'] !== true) {
        byKey.set(`${family}:${revision}`, entry);
      }
    }

    if (arn !== '' && afterUnknown['arn'] !== true) byKey.set(arn, entry);

    if (!byModule.has(moduleAddress)) {
      byModule.set(moduleAddress, entry);
    } else {
      byModule.set(moduleAddress, null); // ambiguous: multiple task defs in same module
    }
  }

  return { byKey, byModule };
}

// ---------------------------------------------------------------------------
// Side selection
// ---------------------------------------------------------------------------

export type Side = 'before' | 'after';

function pickSide(change: TerraformPlanChange, side: Side): Record<string, unknown> | null {
  const raw = side === 'before' ? change.before : change.after;
  if (raw === null || raw === undefined) return null;
  return raw;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function mergeTags(after: Record<string, unknown>): Record<string, string> {
  const tagsAll = asObject(after['tags_all']);
  const tags = asObject(after['tags']);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tagsAll)) out[k] = asStr(v);
  for (const [k, v] of Object.entries(tags)) out[k] = asStr(v);
  return out;
}

function isUnknown(afterUnknown: Record<string, unknown> | undefined, key: string): boolean {
  if (afterUnknown === undefined) return false;
  return afterUnknown[key] === true;
}

function metadataHttpTokens(after: Record<string, unknown>): string {
  const md: unknown = after['metadata_options'];
  if (Array.isArray(md) && md.length > 0) {
    const first: unknown = md[0];
    if (first !== null && typeof first === 'object') {
      return asStr((first as Record<string, unknown>)['http_tokens']);
    }
  }
  if (md !== null && typeof md === 'object' && !Array.isArray(md)) {
    return asStr((md as Record<string, unknown>)['http_tokens']);
  }
  return '';
}

const NOW = new Date().toISOString();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SynthesizedResource {
  /** Resource shape consumed by CostEngine + evaluateRules (cost rules). */
  resource: Resource;
  /** TerraformResource shape consumed by evaluateSecurityRules. */
  tfResource: TerraformResource;
  /** How trustworthy the cost figure is — surfaced in the cost-impact table. */
  costStatus: CostStatus;
  /** Warnings to surface in the top-level output warnings[]. */
  warnings?: string[];
}

/**
 * Synthesize Resource + TerraformResource pairs from a plan resource_change.
 *
 * Returns `null` when the side has no data (e.g. `before` for a create) or
 * the resource is a data source or read action — those rows are skipped
 * entirely from cost-impact output.
 */
export function synthesizeResource(
  change: TerraformResourceChange,
  side: Side,
  defaultRegion: string,
  taskDefIndex?: TaskDefIndex,
): SynthesizedResource | null {
  // Data sources never contribute to cost.
  if (change.address.startsWith('data.')) return null;

  const action = resolveAction(change.change.actions);
  if (action === 'no-op' || action === 'read') return null;

  const after = pickSide(change.change, side);
  if (after === null) return null;

  const afterUnknown = side === 'after' ? change.change.after_unknown : undefined;
  const tags = mergeTags(after);
  const region = (() => {
    const r = asStr(after['region']);
    return r === '' ? defaultRegion : r;
  })();

  const normalizedType = normalizeResourceType(change.type);
  const baseResource: Omit<Resource, 'type' | 'instanceType' | 'configuration'> = {
    id: change.address,
    arn: '',
    name: change.address,
    region,
    state: 'planned',
    tags,
    launchTime: NOW,
    collectedAt: NOW,
  };

  const tfResource: TerraformResource = {
    address: change.address,
    type: change.type,
    // Use the full address as the name — `for_each` keys may contain dots
    // (e.g. `aws_instance.foo["a.b"]`), so simple string-splitting would
    // produce wrong names. Security rules read `resource.address` for the
    // finding's `resource` field, not `name`.
    name: change.address,
    provider: 'aws',
    module: change.module_address ?? '',
    filePath: '',
    lineNumber: 0,
    configuration: after,
    dependencies: [],
  };

  switch (change.type) {
    case 'aws_instance': {
      const instanceType = asStr(after['instance_type']);
      const platform = asStr(after['platform'], 'Linux');
      const httpTokens = metadataHttpTokens(after);
      const costStatus: CostStatus = isUnknown(afterUnknown, 'instance_type')
        ? 'unknown'
        : instanceType === ''
          ? 'unknown'
          : 'known';
      const configuration: Record<string, unknown> = {
        platform,
        ...(httpTokens !== '' ? { metadata_options_http_tokens: httpTokens } : {}),
      };
      return {
        resource: { ...baseResource, type: 'ec2_instance', instanceType, configuration },
        tfResource,
        costStatus,
      };
    }
    case 'aws_db_instance': {
      const instanceType = asStr(after['instance_class']);
      const costStatus: CostStatus = isUnknown(afterUnknown, 'instance_class')
        ? 'unknown'
        : instanceType === ''
          ? 'unknown'
          : 'known';
      const configuration: Record<string, unknown> = {
        engine: asStr(after['engine'], 'MySQL'),
        multi_az: boolValue(after['multi_az']),
        allocated_storage: floatValue(after['allocated_storage']),
        storage_type: asStr(after['storage_type'], 'gp3'),
        iops: floatValue(after['iops']),
        storage_encrypted: boolValue(after['storage_encrypted']),
        publicly_accessible: boolValue(after['publicly_accessible']),
        backup_retention_period: floatValue(after['backup_retention_period']),
      };
      return {
        resource: { ...baseResource, type: 'rds_instance', instanceType, configuration },
        tfResource,
        costStatus,
      };
    }
    case 'aws_ebs_volume': {
      const sizeUnknown = isUnknown(afterUnknown, 'size');
      const size = floatValue(after['size']);
      const costStatus: CostStatus = sizeUnknown ? 'partial-unknown' : 'known';
      const configuration: Record<string, unknown> = {
        volume_type: asStr(after['type'], 'gp3'),
        size_gb: size,
        iops: floatValue(after['iops']),
        throughput: floatValue(after['throughput']),
        encrypted: boolValue(after['encrypted']),
      };
      return {
        resource: { ...baseResource, type: 'ebs_volume', instanceType: '', configuration },
        tfResource,
        costStatus,
      };
    }
    case 'aws_ebs_snapshot': {
      const configuration: Record<string, unknown> = {
        volume_size: floatValue(after['volume_size']),
      };
      return {
        resource: { ...baseResource, type: 'ebs_snapshot', instanceType: '', configuration },
        tfResource,
        costStatus: 'known',
      };
    }
    case 'aws_s3_bucket': {
      const configuration: Record<string, unknown> = {
        storage_class: 'STANDARD',
        size_gb: 0,
      };
      return {
        resource: { ...baseResource, type: 's3_bucket', instanceType: '', configuration },
        tfResource,
        costStatus: 'variable',
      };
    }
    case 'aws_lambda_function': {
      const memoryMb = floatValue(after['memory_size']) > 0 ? floatValue(after['memory_size']) : 128;
      const configuration: Record<string, unknown> = {
        memory_mb: memoryMb,
      };
      return {
        resource: { ...baseResource, type: 'lambda_function', instanceType: '', configuration },
        tfResource,
        costStatus: 'variable',
      };
    }
    case 'aws_lb':
    case 'aws_alb': {
      const lbType = asStr(after['load_balancer_type'], 'application');
      const configuration: Record<string, unknown> = {
        lb_type: lbType,
      };
      return {
        resource: { ...baseResource, type: 'load_balancer', instanceType: '', configuration },
        tfResource,
        costStatus: 'known',
      };
    }
    case 'aws_elasticache_cluster': {
      const nodeType = asStr(after['node_type']);
      const costStatus: CostStatus = isUnknown(afterUnknown, 'node_type')
        ? 'unknown'
        : nodeType === ''
          ? 'unknown'
          : 'known';
      const configuration: Record<string, unknown> = {
        num_cache_nodes: floatValue(after['num_cache_nodes']) > 0 ? floatValue(after['num_cache_nodes']) : 1,
      };
      return {
        resource: {
          ...baseResource,
          type: 'elasticache_cluster',
          instanceType: nodeType,
          configuration,
        },
        tfResource,
        costStatus,
      };
    }
    case 'aws_dynamodb_table': {
      const billingMode = asStr(after['billing_mode'], 'PROVISIONED');
      const configuration: Record<string, unknown> = {
        billing_mode: billingMode,
        read_capacity_units: floatValue(after['read_capacity']),
        write_capacity_units: floatValue(after['write_capacity']),
      };
      const costStatus: CostStatus = billingMode === 'PAY_PER_REQUEST' ? 'variable' : 'known';
      return {
        resource: { ...baseResource, type: 'dynamodb_table', instanceType: '', configuration },
        tfResource,
        costStatus,
      };
    }
    case 'aws_nat_gateway': {
      return {
        resource: { ...baseResource, type: 'nat_gateway', instanceType: '', configuration: {} },
        tfResource,
        costStatus: 'known',
      };
    }
    case 'aws_eip': {
      const associated =
        asStr(after['network_interface']) !== '' ||
        asStr(after['instance']) !== '';
      return {
        resource: {
          ...baseResource,
          type: 'elastic_ip',
          state: associated ? 'associated' : 'available',
          instanceType: '',
          configuration: {},
        },
        tfResource,
        costStatus: 'known',
      };
    }
    case 'aws_ecs_service': {
      // Preserve desired_count=0 (stopped service, $0 cost). Only fall back to 1
      // when the field is absent entirely (null/undefined) from the plan.
      const rawDesiredCount = floatValue(after['desired_count']);
      const desiredCount = after['desired_count'] === null || after['desired_count'] === undefined ? 1 : rawDesiredCount;
      const configuration: Record<string, unknown> = { desired_count: desiredCount };

      let costStatus: CostStatus = 'partial-unknown';
      let warnings: string[] | undefined;

      if (taskDefIndex !== undefined && side === 'after') {
        const taskDefUnknown = isUnknown(afterUnknown, 'task_definition');
        const taskDefRef = taskDefUnknown ? '' : asStr(after['task_definition']);
        const moduleAddress = change.module_address ?? '';
        let taskDef: TaskDefEntry | undefined;

        if (taskDefRef !== '') {
          // 1. Direct lookup by plan address, family, family:revision, or deployed ARN
          taskDef = taskDefIndex.byKey.get(taskDefRef);

          // 2. ARN form — parse family[:revision] from the ARN path segment
          if (taskDef === undefined && taskDefRef.startsWith('arn:')) {
            const m = /task-definition\/([^:/]+)(?::(\d+))?$/.exec(taskDefRef);
            if (m !== null) {
              const fam = m[1] ?? '';
              const rev = m[2];
              if (rev !== undefined) taskDef = taskDefIndex.byKey.get(`${fam}:${rev}`);
              if (taskDef === undefined) taskDef = taskDefIndex.byKey.get(fam);
            }
          }
        } else if (taskDefUnknown) {
          // 3. task_definition ARN is unknown at plan time (computed by apply).
          //    Try byModule first (unambiguous single task def in same module),
          //    then fall back to sibling address heuristic.
          const moduleEntry = taskDefIndex.byModule.get(moduleAddress);
          if (moduleEntry !== null && moduleEntry !== undefined) {
            taskDef = moduleEntry;
          } else {
            // Sibling address heuristic:
            //   aws_ecs_service.api           → aws_ecs_task_definition.api
            //   module.web.aws_ecs_service.api → module.web.aws_ecs_task_definition.api
            const typeMarker = '.aws_ecs_service.';
            const lastDotIdx = change.address.lastIndexOf(typeMarker);
            const siblingAddress = lastDotIdx !== -1
              ? change.address.slice(0, lastDotIdx) + '.aws_ecs_task_definition.' +
                change.address.slice(lastDotIdx + typeMarker.length)
              : change.address.startsWith('aws_ecs_service.')
                ? 'aws_ecs_task_definition.' + change.address.slice('aws_ecs_service.'.length)
                : change.address;
            taskDef = taskDefIndex.byKey.get(siblingAddress);
          }
        }

        if (taskDef !== undefined) {
          configuration['task_cpu'] = taskDef.cpu / 1024; // CPU units → vCPUs
          configuration['task_memory'] = taskDef.memory;  // MB; engine divides by 1024 for GB
          costStatus = 'known';
        } else if (taskDefUnknown) {
          warnings = [
            `${change.address}: task definition (unknown at plan time) not found in plan` +
            ` — cost estimate uses engine defaults (0.25 vCPU / 0.5 GB)`,
          ];
        } else if (taskDefRef !== '') {
          warnings = [
            `${change.address}: task definition "${taskDefRef}" not found in plan` +
            ` — cost estimate uses engine defaults (0.25 vCPU / 0.5 GB)`,
          ];
        } else {
          warnings = [
            `${change.address}: task_definition is empty — no task definition reference found` +
            ` — cost estimate uses engine defaults (0.25 vCPU / 0.5 GB)`,
          ];
        }
      }

      return {
        resource: { ...baseResource, type: 'ecs_service', instanceType: '', configuration },
        tfResource,
        costStatus,
        ...(warnings !== undefined ? { warnings } : {}),
      };
    }
    default: {
      return {
        resource: {
          ...baseResource,
          type: normalizedType,
          instanceType: '',
          configuration: {},
        },
        tfResource,
        costStatus: 'unpriced',
      };
    }
  }
}
