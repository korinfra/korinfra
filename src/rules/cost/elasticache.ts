/**
 * ElastiCache cost optimization rules.
 * Ported from Go internal/ai/rules.go (ELC-001, ELC-002, ELC-003).
 */

import type { Resource } from '../../aws/types.js';
import type { Recommendation } from '../types.js';
import type { ThresholdsOverride } from '../config.js';
import type { THRESHOLDS } from '../config.js';
import { strConfig, suggestCacheRightsize, sanitizeResourceName, getMonthlyCost, confidenceFromUtilization } from './helpers.js';

type Cfg = typeof THRESHOLDS & ThresholdsOverride;

/** ELC-001: Overprovisioned ElastiCache cluster (<10% memory utilization). */
export function checkELC001(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'elasticache_cluster' || !r.utilization) return null;

  const util = r.utilization;
  const lowMemory = (util.memoryAverage ?? 0) < cfg.cacheMemoryThreshold;
  const lowCPU = (util.cpuAverage ?? 0) < 10;
  const lowConnections = (util.connectionCount ?? Infinity) < 5;

  // Require low memory AND at least one additional signal (low CPU or low connections)
  if (!lowMemory || (!lowCPU && !lowConnections)) return null;

  // If peak memory was significantly higher, the cluster is not truly overprovisioned
  if ((util.memoryP95 ?? 0) > cfg.cacheMemoryThreshold * 2) return null;

  const suggested = suggestCacheRightsize(r.instanceType, util.memoryAverage, cfg.cacheMemoryThreshold);
  if (suggested === r.instanceType) return null;
  const monthlyCost = getMonthlyCost(r);
  // Rightsize: one step down = ~50% cost reduction. Actual savings depend on instance family and region pricing.
  const CACHE_RIGHTSIZE_SAVINGS = 0.5;
  const savings = monthlyCost * CACHE_RIGHTSIZE_SAVINGS;
  const confidence = confidenceFromUtilization(0.80, r.utilization);
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'ELC-001',
    resourceId: r.id,
    resourceType: r.type,
    title: `Rightsize ElastiCache cluster ${r.name} (${util.memoryAverage.toFixed(1)}% memory used)`,
    description: `ElastiCache cluster ${r.name} uses only ${util.memoryAverage.toFixed(1)}% of available memory on ${r.instanceType}. Downsizing to ${suggested} would save ~${savings.toFixed(0)}/mo (estimate based on ~50% reduction; actual savings depend on instance family).`,
    reasoning: `Memory utilisation of ${util.memoryAverage.toFixed(1)}% over ${util.period} indicates significant overprovisioning. Savings estimate is ~50% and varies by instance family and region.`,
    impact: 'medium',
    risk: 'medium',
    estimatedSavings: savings,
    suggestedAction: `rightsize_to_${suggested}`,
    confidence,
    filePath,
    currentConfig: { node_type: r.instanceType, memory_avg_pct: util.memoryAverage },
    suggestedConfig: { node_type: suggested },
    patchContent: `  node_type = "${sanitizeResourceName(suggested)}"  # was: ${sanitizeResourceName(r.instanceType)} (memory avg ${util.memoryAverage.toFixed(1)}%)`,
    implementationSteps: [
      `Scale down the ElastiCache node type to ${sanitizeResourceName(suggested)} during a maintenance window`,
      filePath ? `Update ${filePath}: node_type = "${sanitizeResourceName(suggested)}"` : `Set node_type = "${sanitizeResourceName(suggested)}"`,
      'Run terraform plan to verify, then terraform apply',
      'Monitor hit rate and latency closely after scaling',
    ],
  };
}

/** ELC-002: Previous-generation ElastiCache node type (Graviton upgrade). */
export function checkELC002(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'elasticache_cluster') return null;
  const nodeType = r.instanceType || strConfig(r, 'node_type');
  if (!nodeType) return null;

  const elcGravitonMap: Record<string, string> = {
    'cache.r5': 'cache.r7g',
    'cache.r6': 'cache.r7g',
    'cache.m5': 'cache.m7g',
    'cache.m6': 'cache.m7g',
    'cache.t3': 'cache.t4g',
  };

  let oldPrefix = '';
  let newPrefix = '';
  for (const [old, next] of Object.entries(elcGravitonMap)) {
    if (nodeType.startsWith(old)) {
      oldPrefix = old;
      newPrefix = next;
      break;
    }
  }
  if (!newPrefix) return null;

  const suggestedType = newPrefix + nodeType.slice(oldPrefix.length);
  const monthlyCost = getMonthlyCost(r);
  const savings = monthlyCost * cfg.elastiCacheGravitonMultiplier;
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'ELC-002',
    resourceId: r.id,
    resourceType: r.type,
    title: `Upgrade ElastiCache cluster ${r.name} from ${nodeType} to Graviton (${suggestedType}, ~5% cheaper)`,
    description: `ElastiCache cluster ${r.name} uses node type ${nodeType}. Upgrading to Graviton equivalent ${suggestedType} saves ~5% with equal or better performance.`,
    reasoning: `AWS Graviton ElastiCache nodes offer better price/performance. ${nodeType} → ${suggestedType} reduces cost by ~5%/mo.`,
    impact: 'medium',
    risk: 'low',
    estimatedSavings: savings,
    suggestedAction: `upgrade_to_${suggestedType}`,
    confidence: 0.8,
    filePath,
    currentConfig: { node_type: nodeType },
    suggestedConfig: { node_type: suggestedType },
    patchContent: `  node_type = "${sanitizeResourceName(suggestedType)}"  # was: ${sanitizeResourceName(nodeType)} (Graviton, ~5% cheaper)`,
    implementationSteps: [
      'Verify the ElastiCache engine version supports the Graviton node type',
      `Schedule a maintenance window and change node_type to ${sanitizeResourceName(suggestedType)}`,
      filePath ? `Update ${filePath}: node_type = "${sanitizeResourceName(suggestedType)}"` : `Set node_type = "${sanitizeResourceName(suggestedType)}"`,
      'Run terraform plan to verify, then terraform apply',
      'Monitor cluster performance for 24 hours post-change',
    ],
  };
}

/** ELC-003: Idle ElastiCache cluster (near-zero CPU and memory). */
export function checkELC003(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'elasticache_cluster' || !r.utilization) return null;
  if (r.utilization.cpuAverage >= cfg.elastiCacheIdleCPUThreshold) return null;
  if (r.utilization.memoryAverage >= cfg.elastiCacheIdleMemoryThreshold) return null;
  const monthlyCost = getMonthlyCost(r);
  const savings = monthlyCost * 0.9;
  const nodeType = r.instanceType || strConfig(r, 'node_type');
  const filePath = strConfig(r, 'file_path');
  const confidence = confidenceFromUtilization(0.85, r.utilization);
  return {
    ruleId: 'ELC-003',
    resourceId: r.id,
    resourceType: r.type,
    title: `ElastiCache cluster ${r.name} is idle (CPU ${r.utilization.cpuAverage.toFixed(1)}%, memory ${r.utilization.memoryAverage.toFixed(1)}%)`,
    description: `ElastiCache cluster ${r.name} (${nodeType}) has ${r.utilization.cpuAverage.toFixed(1)}% average CPU and ${r.utilization.memoryAverage.toFixed(1)}% memory utilization — near zero usage indicates the cluster is likely unused. Deleting would eliminate ~${savings.toFixed(0)} USD/mo (estimate assumes no saved backups; retained snapshots will incur storage costs).`,
    reasoning: `CPU average of ${r.utilization.cpuAverage.toFixed(1)}% and memory average of ${r.utilization.memoryAverage.toFixed(1)}% are both below idle thresholds (${cfg.elastiCacheIdleCPUThreshold}% CPU, ${cfg.elastiCacheIdleMemoryThreshold}% memory). Savings estimate (~90%) excludes retained snapshot storage costs.`,
    impact: 'high',
    risk: 'medium',
    estimatedSavings: savings,
    suggestedAction: 'delete',
    confidence,
    filePath,
    currentConfig: { node_type: nodeType, cpu_avg_pct: r.utilization.cpuAverage, memory_avg_pct: r.utilization.memoryAverage },
    suggestedConfig: { action: 'delete' },
    patchContent: `# Delete idle ElastiCache cluster ${sanitizeResourceName(r.name)}\n# aws elasticache delete-cache-cluster --cache-cluster-id ${sanitizeResourceName(r.id)}`,
    implementationSteps: [
      'Confirm with the owning team that no application is using this cache',
      'Check CloudWatch CacheMisses and CacheHits metrics to verify zero traffic',
      'Delete the cluster via the AWS console or CLI',
      filePath ? `Remove the aws_elasticache_cluster resource block from ${filePath}` : 'Remove the aws_elasticache_cluster resource block from Terraform',
      'Run terraform plan to verify, then terraform apply',
    ],
  };
}

export const elastiCacheRules = [checkELC001, checkELC002, checkELC003];
