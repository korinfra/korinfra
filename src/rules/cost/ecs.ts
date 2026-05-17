/**
 * ECS cost optimization rules.
 * Ported from Go internal/ai/rules.go (ECS-001, ECS-002, ECS-003).
 */

import type { Resource } from '../../aws/types.js';
import type { Recommendation } from '../types.js';
import type { ThresholdsOverride } from '../config.js';
import type { THRESHOLDS } from '../config.js';
import { strConfig, numConfig, daysSince, getMonthlyCost, confidenceFromUtilization } from './helpers.js';
import { clampConfidence, guardSavings } from '../../utils/numeric-guards.js';
import { FARGATE_LINUX_VCPU_HOURLY, FARGATE_LINUX_MEMORY_HOURLY, HOURS_PER_MONTH } from '../../pricing/resources.js';

type Cfg = typeof THRESHOLDS & ThresholdsOverride;

/** ECS-001: ECS service with 0 running tasks. */
export function checkECS001(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'ecs_service') return null;
  const runningCount = numConfig(r, 'running_count');
  const desiredCount = numConfig(r, 'desired_count');
  if (desiredCount <= 0 || runningCount > 0) return null;
  const ageDays = daysSince(r.launchTime);
  if (ageDays === null || ageDays < cfg.ecsIdleDays) return null;
  const monthlyCost = getMonthlyCost(r);
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'ECS-001',
    resourceId: r.id,
    resourceType: r.type,
    title: `ECS service ${r.name} has 0 running tasks but is still provisioned`,
    description: `ECS service ${r.name} has desired_count=${desiredCount} but 0 running tasks. The service holds cluster resources and target group registrations.`,
    reasoning: 'An ECS service with no running tasks still consumes load balancer target group slots and cluster capacity reservation. If unused, set desired_count=0 or delete it.',
    impact: 'medium',
    risk: 'low',
    estimatedSavings: guardSavings(monthlyCost),
    suggestedAction: 'set_desired_count_zero',
    confidence: clampConfidence(0.85),
    filePath,
    currentConfig: { desired_count: desiredCount, running_count: 0 },
    suggestedConfig: { desired_count: 0 },
    patchContent: '  desired_count = 0  # was: non-zero but 0 tasks running',
    implementationSteps: [
      'Verify the service is not expected to be running (check deployment failures)',
      filePath ? `Set desired_count = 0 in ${filePath} or delete the service` : 'Set desired_count = 0 or delete the service',
      'Run terraform plan to verify, then terraform apply',
    ],
  };
}

/** ECS-002: ECS service on EC2 launch type — consider Fargate. */
export function checkECS002(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'ecs_service') return null;
  const launchType = strConfig(r, 'launch_type');
  if (launchType !== 'EC2') return null;
  const monthlyCost = getMonthlyCost(r);
  const filePath = strConfig(r, 'file_path');

  // Estimate Fargate cost using task CPU/memory from config.
  // ECS task definitions store cpu in CPU units (1024 = 1 vCPU) and memory in MB.
  // Accept both task_cpu/task_memory keys (collector-set) and cpu/memory (ECS-native format).
  const rawCpuUnits =
    (r.configuration['task_cpu'] as number | string | undefined) ??
    (r.configuration['cpu'] as number | string | undefined) ??
    256;
  const rawMemoryMB =
    (r.configuration['task_memory'] as number | string | undefined) ??
    (r.configuration['memory'] as number | string | undefined) ??
    512;
  const taskCpuVcpus = Number(rawCpuUnits) / 1024;
  const taskMemoryGB = Number(rawMemoryMB) / 1024;
  const desiredCount = (r.configuration['desired_count'] as number | undefined) ?? 1;
  const fargateMonthlyCost =
    (taskCpuVcpus * FARGATE_LINUX_VCPU_HOURLY + taskMemoryGB * FARGATE_LINUX_MEMORY_HOURLY) *
    HOURS_PER_MONTH *
    desiredCount;
  const ec2Cost = monthlyCost;

  if (fargateMonthlyCost >= ec2Cost && ec2Cost > 0) {
    return null; // Fargate would be more expensive — don't recommend
  }

  const savings =
    ec2Cost > 0 && fargateMonthlyCost > 0
      ? ec2Cost - fargateMonthlyCost
      : monthlyCost * cfg.ecsEC2ToFargateSavingsMultiplier;

  return {
    ruleId: 'ECS-002',
    resourceId: r.id,
    resourceType: r.type,
    title: `Migrate ECS service ${r.name} from EC2 to Fargate launch type`,
    description: `ECS service ${r.name} runs on EC2 launch type. Fargate eliminates EC2 instance management and scales to zero, reducing costs for variable workloads.`,
    reasoning: 'EC2 launch type requires provisioning and paying for EC2 instances even during low-utilisation periods. Fargate charges only for running task vCPU and memory seconds. Fargate Spot can save up to 70% further.',
    impact: 'medium',
    risk: 'medium',
    estimatedSavings: guardSavings(savings),
    suggestedAction: 'migrate_to_fargate',
    confidence: clampConfidence(0.7),
    filePath,
    currentConfig: { launch_type: 'EC2' },
    suggestedConfig: { launch_type: 'FARGATE' },
    patchContent: '  launch_type = "FARGATE"  # was: EC2',
    implementationSteps: [
      'Review task definition for EC2-specific settings (host networking, privileged containers)',
      filePath ? `Update ${filePath}: launch_type = "FARGATE"` : 'Update Terraform: launch_type = "FARGATE"',
      'Add requires_compatibilities = ["FARGATE"] to the task definition',
      'Specify cpu and memory at the task level (required for Fargate)',
      'Run terraform plan to verify, then terraform apply',
      'Consider FARGATE_SPOT capacity provider for additional savings',
    ],
  };
}

/** ECS-003: ECS service over-provisioned with too many tasks. */
export function checkECS003(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'ecs_service' || !r.utilization) return null;
  if (r.utilization.cpuAverage >= cfg.ecsMinCPUThreshold) return null;
  const desiredCount = numConfig(r, 'desired_count') || numConfig(r, 'running_count') || 2;
  if (desiredCount < cfg.ecsMinDesiredCount) return null;
  const monthlyCost = getMonthlyCost(r);
  const suggestedCount = Math.max(1, Math.floor(desiredCount / 2));
  const reductionRatio = (desiredCount - suggestedCount) / desiredCount;
  // Use actual reduction ratio but cap at cfg multiplier (conservative upper bound)
  const savings = monthlyCost * Math.min(reductionRatio, cfg.ecsOverProvisionedSavingsMultiplier);
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'ECS-003',
    resourceId: r.id,
    resourceType: r.type,
    title: `ECS service ${r.name} may be over-provisioned (${desiredCount} tasks, ${r.utilization.cpuAverage.toFixed(1)}% CPU avg)`,
    description: `ECS service ${r.name} has ${desiredCount} desired tasks but only ${r.utilization.cpuAverage.toFixed(1)}% average CPU utilization. Consider reducing to ${suggestedCount} task(s) based on current load.`,
    reasoning: `With ${r.utilization.cpuAverage.toFixed(1)}% CPU average across ${desiredCount} tasks, the effective single-task CPU is even lower. Reducing desired_count from ${desiredCount} to ${suggestedCount} (${(reductionRatio * 100).toFixed(0)}% reduction) would right-size the service.`,
    impact: 'medium',
    risk: 'medium',
    estimatedSavings: guardSavings(savings),
    suggestedAction: 'reduce_desired_count',
    confidence: clampConfidence(confidenceFromUtilization(0.75, r.utilization)),
    filePath,
    currentConfig: { desired_count: desiredCount, cpu_avg_pct: r.utilization.cpuAverage },
    suggestedConfig: { desired_count: suggestedCount },
    patchContent: `  desired_count = ${suggestedCount}  # was: ${desiredCount} (CPU avg ${r.utilization.cpuAverage.toFixed(1)}%)`,
    implementationSteps: [
      'Review traffic patterns and SLA requirements before reducing task count',
      'Enable ECS Service Auto Scaling with target-tracking on CPU utilization (target: 60-70%)',
      filePath ? `Gradually reduce desired_count from ${desiredCount} to ${suggestedCount} in ${filePath} and monitor error rates` : `Gradually reduce desired_count from ${desiredCount} to ${suggestedCount} and monitor error rates`,
      'Run terraform plan to verify, then terraform apply',
      'Optionally add scheduled scaling to reduce tasks during off-peak hours',
    ],
  };
}

/**
 * ECS-004: ECS service is degraded — running_count < desired_count with no
 * pending tasks. This indicates tasks are failing to start (bad task
 * definition, resource exhaustion, image pull error, etc.) and the service
 * cannot reach its desired capacity. Unlike ECS-001 (zero running tasks),
 * this rule catches partial failures where some tasks run but the service
 * is operating below capacity.
 */
export function checkECS004(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'ecs_service') return null;
  const desiredCount = numConfig(r, 'desired_count');
  const runningCount = numConfig(r, 'running_count');
  const pendingCount = numConfig(r, 'pending_count');
  // Only fire when partially running but not at desired capacity and no tasks are pending
  if (desiredCount <= 0 || runningCount <= 0) return null;
  if (runningCount >= desiredCount) return null;
  if (pendingCount > 0) return null; // still launching tasks — let it stabilize
  const ageDays = daysSince(r.launchTime);
  if (ageDays === null || ageDays < cfg.ecsDegradedDays) return null;

  const shortfall = desiredCount - runningCount;
  const filePath = strConfig(r, 'file_path');

  return {
    ruleId: 'ECS-004',
    resourceId: r.id,
    resourceType: r.type,
    title: `ECS service ${r.name} is degraded: ${runningCount}/${desiredCount} tasks running`,
    description:
      `ECS service ${r.name} has ${runningCount} running tasks but desired_count=${desiredCount}. ` +
      `${shortfall} task(s) are not running and none are pending, which indicates tasks are failing to start. ` +
      `Common causes: bad task definition, image pull errors, resource exhaustion, or IAM permission issues.`,
    reasoning:
      `A service stuck below desired capacity with no pending tasks is in a degraded state that will not self-heal. ` +
      `This pattern indicates tasks are crash-looping or failing to start. ` +
      `Left unresolved it affects availability and wastes cluster capacity for partially-allocated resources.`,
    impact: 'high',
    risk: 'low',
    estimatedSavings: 0, // operational issue — savings depends on root cause resolution
    suggestedAction: 'investigate_task_failures',
    confidence: clampConfidence(0.9),
    filePath,
    currentConfig: { desired_count: desiredCount, running_count: runningCount, pending_count: 0 },
    suggestedConfig: { desired_count: desiredCount }, // desired stays same — fix task failures
    implementationSteps: [
      `Run: aws ecs describe-services --cluster <cluster> --services ${r.name} --query 'services[].events[:5]'`,
      'Check ECS stopped task reasons: aws ecs list-tasks --cluster <cluster> --service-name <service> --desired-status STOPPED',
      'Review CloudWatch Logs for the task definition log group',
      'Common fixes: update task definition image tag, increase memory/CPU, check IAM task role permissions',
      filePath ? `Update ${filePath} if task definition changes are needed, then re-deploy` : 'Update task definition and re-deploy',
    ],
  };
}

export const ecsRules = [checkECS001, checkECS002, checkECS003, checkECS004];
