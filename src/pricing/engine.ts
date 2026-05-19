/**
 * Cost estimation dispatcher.
 * Dispatches by resource type to per-service estimators in resources.ts.
 * The pricing client is optional — every estimator falls back to hardcoded rates.
 */

import type { Resource } from '../aws/types.js';
import { floatValue, boolValue } from '../utils/coerce.js';
import type { AwsPricingClient } from './client.js';
import {
  estimateEC2Cost,
  estimateRDSCost,
  estimateEBSCost,
  estimateS3Cost,
  estimateLambdaCost,
  estimateELBCost,
  estimateElastiCacheCost,
  estimateDynamoDBCost,
  estimateNATGatewayCost,
  estimateEIPCost,
  estimateECSCost,
  EBS_SNAPSHOT_PER_GB,
} from './resources.js';

// ─── Helper utilities ─────────────────────────────────────────────────────────

function parsePeriodDays(period: string): number {
  if (!period.endsWith('d')) return 0;
  const n = parseInt(period.slice(0, -1), 10);
  return isNaN(n) ? 0 : n;
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export class CostEngine {
  constructor(private readonly client: AwsPricingClient | null = null) {}

  /**
   * Estimates monthly cost for a resource dispatching by resource type.
   * Returns 0 for unknown types rather than throwing.
   */
  async estimateMonthlyCost(resource: Resource): Promise<number> {
    // Preserve an existing cost if already populated
    const cfg = resource.configuration ?? {};

    switch (resource.type) {
      case 'ec2_instance': {
        const platform = (cfg['platform'] as string | undefined) ?? 'Linux';
        return estimateEC2Cost(this.client, resource.instanceType, resource.region, platform);
      }

      case 'rds_instance': {
        const dbEngine = (cfg['engine'] as string | undefined) ?? 'MySQL';
        const multiAZ = boolValue(cfg['multi_az']);
        const allocatedStorage = floatValue(cfg['allocated_storage']);
        return estimateRDSCost(
          this.client,
          resource.instanceType,
          dbEngine,
          multiAZ,
          allocatedStorage,
          resource.region,
        );
      }

      case 'ebs_volume': {
        const volumeType = (cfg['volume_type'] as string | undefined) ?? 'gp3';
        const sizeGB = floatValue(cfg['size_gb']);
        const iops = floatValue(cfg['iops']);
        const throughput = floatValue(cfg['throughput']);
        return estimateEBSCost(this.client, resource.region, volumeType, sizeGB, iops, throughput);
      }

      case 'ebs_snapshot': {
        const sizeGB = floatValue(cfg['volume_size']) || floatValue(cfg['size_gb']);
        const snapshotCost = sizeGB * EBS_SNAPSHOT_PER_GB;
        if (!Number.isFinite(snapshotCost) || snapshotCost < 0) return 0;
        return snapshotCost;
      }

      case 's3_bucket': {
        const storageClass = (cfg['storage_class'] as string | undefined) ?? 'STANDARD';
        const sizeGB = floatValue(cfg['size_gb']);
        return estimateS3Cost(this.client, resource.region, storageClass, sizeGB);
      }

      case 'lambda_function': {
        let memoryMB = floatValue(cfg['memory_mb']);
        if (memoryMB === 0) memoryMB = 128;
        let avgDurationMs = 0;
        let invocationsPerMonth = 0;
        if (resource.utilization) {
          // Use dedicated avgDurationMs field when available. CPUAverage is a percentage
          // (0-100), NOT milliseconds — do not use it as a duration proxy.
          avgDurationMs = resource.utilization.avgDurationMs ?? 0;
          const periodDays = parsePeriodDays(resource.utilization.period);
          if (periodDays > 0) {
            const rawInvocations = resource.utilization.invocations ?? 0;
            invocationsPerMonth = rawInvocations * (30 / periodDays);
          }
        }
        return estimateLambdaCost(memoryMB, avgDurationMs, invocationsPerMonth);
      }

      case 'load_balancer': {
        let lbType = (cfg['type'] as string | undefined) ?? '';
        if (!lbType) lbType = (cfg['lb_type'] as string | undefined) ?? '';
        return estimateELBCost(this.client, resource.region, lbType);
      }

      case 'elasticache_cluster': {
        const numNodes = Math.floor(floatValue(cfg['num_cache_nodes'])) || 1;
        return estimateElastiCacheCost(this.client, resource.instanceType, numNodes, resource.region);
      }

      case 'dynamodb_table': {
        const billingMode = (cfg['billing_mode'] as string | undefined) ?? 'PROVISIONED';
        const rcu = floatValue(cfg['read_capacity_units']);
        const wcu = floatValue(cfg['write_capacity_units']);
        const tableSizeBytes = floatValue(cfg['table_size_bytes']);
        const storageGB = tableSizeBytes / (1024 * 1024 * 1024);
        // For PAY_PER_REQUEST tables, capacity cost is unknown from configuration alone.
        // The collector populates configuration.monthlyCost from Cost Explorer when available;
        // pass it through so PAY_PER_REQUEST estimates reflect actual spend.
        const ceActual =
          resource.monthlyCostSource === 'cost_explorer' || cfg['monthlyCostSource'] === 'cost_explorer'
            ? floatValue(cfg['monthlyCost'])
            : undefined;
        return estimateDynamoDBCost(
          this.client,
          resource.region,
          billingMode,
          rcu,
          wcu,
          storageGB,
          ceActual,
        );
      }

      case 'nat_gateway': {
        const networkIn = resource.utilization?.networkInMB ?? 0;
        const networkOut = resource.utilization?.networkOutMB ?? 0;
        const processedGB = (networkIn + networkOut) / 1024;
        return estimateNATGatewayCost(this.client, resource.region, processedGB);
      }

      case 'elastic_ip':
        return estimateEIPCost(resource.state === 'associated');

      case 'ecs_service': {
        // For Fargate, estimate based on task CPU/memory if available, otherwise use defaults
        const taskCpuVcpus = floatValue(cfg['task_cpu']) || 0.25;
        const taskMemoryGB = floatValue(cfg['task_memory']) / 1024 || 0.5;
        const desiredCount = floatValue(cfg['desired_count']) || 1;
        return estimateECSCost(taskCpuVcpus, taskMemoryGB) * desiredCount;
      }

      default:
        return 0;
    }
  }
}

/**
 * Convenience function — estimates monthly cost for a Resource.
 * Creates a one-shot CostEngine with the optional client.
 */
export async function estimateMonthlyCost(
  resource: Resource,
  client: AwsPricingClient | null = null,
): Promise<number> {
  const result = await new CostEngine(client).estimateMonthlyCost(resource);
  if (!Number.isFinite(result) || result < 0) return 0;
  return result;
}
