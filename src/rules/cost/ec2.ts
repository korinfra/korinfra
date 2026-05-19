/**
 * EC2 cost optimization rules.
 * Ported from Go internal/ai/rules.go (EC2-001 through EC2-013).
 */

import type { Resource } from '../../aws/types.js';
import type { Recommendation } from '../types.js';
import type { ThresholdsOverride } from '../config.js';
import type { THRESHOLDS } from '../config.js';
import { FALLBACK_EC2_PRICES, EBS_GP3_PER_GB, estimateEC2CostSync } from '../../pricing/resources.js';
import {
  splitInstanceType,
  previousGenFamilies,
  gravitonFamilies,
  isPreviousGen,
  suggestRightsize,
  sizeIndex,
  daysSince,
  strConfig,
  boolConfig,
  numConfig,
  sanitizeResourceName,
  normalizeToMonth,
  getMonthlyCost,
  confidenceFromUtilization,
} from './helpers.js';
import { clampConfidence, guardSavings } from '../../utils/numeric-guards.js';

type Cfg = typeof THRESHOLDS & ThresholdsOverride & { currency: string };

// Stopped instances still pay for attached EBS volumes (~$0.08/GB/mo for gp3).
// If we can't estimate exact EBS cost, assume minimum 1 volume of 20GB = ~$1.60/mo.
// Using $5 as conservative minimum to account for multiple volumes.
const EBS_MINIMUM_MONTHLY_USD = 5.0;

/** EC2-001: Idle instance (CPU avg < threshold). */
export function checkEC2001(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'ec2_instance' || !r.utilization) return null;
  const util = r.utilization;
  if (util.cpuAverage >= cfg.idleCPUThreshold) return null;
  if (util.dataPoints <= 0) return null;
  const monthlyCost = getMonthlyCost(r);
  // Savings = full cost minus retained EBS cost (still billed when stopped)
  const ebsGB = (r.configuration['ebs_volumes_total_gb'] as number | undefined) ?? 0;
  const ebsMonthlyCost = ebsGB * EBS_GP3_PER_GB;
  const savings = Math.max(EBS_MINIMUM_MONTHLY_USD, monthlyCost - ebsMonthlyCost);
  if (!Number.isFinite(savings) || savings < 0) return null;
  const confidence = confidenceFromUtilization(0.90, util);
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'EC2-001',
    resourceId: r.id,
    resourceType: r.type,
    title: `Stop or terminate idle EC2 instance ${r.name}`,
    description: `EC2 instance ${r.name} (${r.instanceType}) has average CPU utilisation of ${util.cpuAverage.toFixed(1)}% over the past ${util.period}, indicating it is idle.`,
    reasoning: `CPU average ${util.cpuAverage.toFixed(1)}% is below the ${cfg.idleCPUThreshold}% idle threshold. P95 CPU is ${util.cpuP95.toFixed(1)}%. This instance is consuming ${monthlyCost.toFixed(2)} ${cfg.currency}/mo with no productive workload.`,
    impact: 'high',
    risk: 'medium',
    estimatedSavings: guardSavings(savings),
    suggestedAction: 'stop_or_terminate',
    confidence: clampConfidence(confidence),
    filePath,
    currentConfig: { state: r.state, instance_type: r.instanceType, cpu_avg_pct: util.cpuAverage },
    suggestedConfig: { action: 'stop_or_terminate' },
    patchContent: `# Stop or terminate idle instance ${sanitizeResourceName(r.name)} (${sanitizeResourceName(r.instanceType)})\n# aws ec2 stop-instances --instance-ids ${sanitizeResourceName(r.id)}`,
    implementationSteps: [
      'Verify with the owning team that this instance is truly unused',
      'Create a snapshot of attached EBS volumes as a backup',
      'Stop the instance (or terminate if no longer needed)',
      filePath ? `If managed by Terraform, set desired_capacity = 0 or remove resource block in ${filePath}` : 'If managed by Terraform, remove the resource block',
    ],
  };
}

/** EC2-002: Stopped instance > threshold days with EBS volumes. */
export function checkEC2002(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'ec2_instance' || r.state !== 'stopped') return null;
  // Prefer state_transition_days (populated by collector) over stopped_at.
  // If neither is available, skip the rule — falling back to launchTime would
  // report the age of the instance, not how long it has been stopped.
  const stoppedAt = strConfig(r, 'stopped_at');
  const transitionDays = numConfig(r, 'state_transition_days');
  const stoppedDays = transitionDays || (stoppedAt ? daysSince(stoppedAt) : null);
  if (stoppedDays === null || stoppedDays < cfg.stoppedInstanceDays) return null;
  const monthlyCost = getMonthlyCost(r);
  let savings = monthlyCost * cfg.ec2StoppedEBSMultiplier;
  if (savings === 0) savings = EBS_MINIMUM_MONTHLY_USD;
  if (!Number.isFinite(savings) || savings < 0) return null;
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'EC2-002',
    resourceId: r.id,
    resourceType: r.type,
    title: `Stopped EC2 instance ${r.name} has attached EBS volumes incurring charges`,
    description: `Instance ${r.name} has been stopped for more than ${cfg.stoppedInstanceDays} days. Attached EBS volumes still accrue storage costs.`,
    reasoning: 'Stopped instances do not incur compute charges but EBS volumes attached to them continue to be billed at the standard rate.',
    impact: 'medium',
    risk: 'low',
    estimatedSavings: guardSavings(savings),
    suggestedAction: 'terminate_and_delete_volumes',
    confidence: clampConfidence(0.95),
    filePath,
    currentConfig: { state: r.state, stopped_age: `${stoppedDays} days` },
    suggestedConfig: { action: 'terminate_and_delete_volumes' },
    patchContent: `# Terminate stopped instance ${sanitizeResourceName(r.name)} and delete attached EBS volumes\n# aws ec2 terminate-instances --instance-ids ${sanitizeResourceName(r.id)}`,
    implementationSteps: [
      'Confirm the instance is no longer needed',
      'Snapshot attached volumes for archival',
      'Terminate the instance (volumes are then deletable)',
      filePath ? `Remove the resource block from ${filePath} and run terraform apply` : 'Remove the Terraform resource block and run terraform apply',
    ],
  };
}

/** EC2-003: Previous-generation instance family. */
export function checkEC2003(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'ec2_instance' || !isPreviousGen(r.instanceType)) return null;
  const [family, size] = splitInstanceType(r.instanceType);
  if (!size) return null;
  const newFamily = previousGenFamilies[family];
  if (!newFamily) return null;
  const suggestedType = newFamily + '.' + size;
  const monthlyCost = getMonthlyCost(r);
  // Use real pricing from fallback table when available; fallback to cfg value for conservative estimate
  const currentHourly = FALLBACK_EC2_PRICES[r.instanceType];
  const suggestedHourly = FALLBACK_EC2_PRICES[suggestedType];
  let savings: number;
  if (currentHourly !== undefined && suggestedHourly !== undefined && currentHourly > 0) {
    savings = monthlyCost * (1 - suggestedHourly / currentHourly);
  } else {
    savings = monthlyCost * cfg.ec2PreviousGenMultiplier; // conservative estimate for previous-gen upgrade
  }
  savings = Math.max(0, savings);
  if (!Number.isFinite(savings)) return null;
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'EC2-003',
    resourceId: r.id,
    resourceType: r.type,
    title: `Upgrade EC2 instance ${r.name} from ${r.instanceType} to current generation`,
    description: `Instance ${r.name} uses previous-generation type ${r.instanceType}. Upgrading to ${suggestedType} offers better price/performance.`,
    reasoning: `Previous-generation instance families typically cost 10-20% more per vCPU and have lower network bandwidth. Suggested replacement: ${suggestedType}.`,
    impact: 'medium',
    risk: 'low',
    estimatedSavings: guardSavings(savings),
    suggestedAction: `upgrade_to_${suggestedType}`,
    confidence: clampConfidence(0.85),
    filePath,
    currentConfig: { instance_type: r.instanceType },
    suggestedConfig: { instance_type: suggestedType },
    patchContent: `  instance_type = "${sanitizeResourceName(suggestedType)}"  # was: ${sanitizeResourceName(r.instanceType)}`,
    implementationSteps: [
      `Stop the instance and change instance type to ${sanitizeResourceName(suggestedType)}`,
      'Restart and validate application performance',
      filePath ? `Update ${filePath}: set instance_type = "${sanitizeResourceName(suggestedType)}"` : `Set instance_type = "${sanitizeResourceName(suggestedType)}"`,
      'Run terraform plan to verify the change, then terraform apply',
    ],
  };
}

/** EC2-004: Oversized instance (CPU P95 < threshold). */
export function checkEC2004(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'ec2_instance' || !r.utilization) return null;
  const util = r.utilization;
  if (util.cpuP95 >= cfg.rightsizeCPUThreshold) return null;
  if (r.instanceType.endsWith('.metal')) return null;

  const MEMORY_BOUND_THRESHOLD_MB = 2000;
  const NETWORK_INTENSIVE_THRESHOLD_MB = 100_000;
  const IOPS_INTENSIVE_THRESHOLD = 5000;

  // Multi-metric gating: skip if the instance is memory-, network-, or I/O-bound.
  // memoryAverage for EC2 is in MB — 2000 MB is a reasonable lower bound meaning
  // the instance is actively using memory and downsizing risks OOM.
  if (util.memoryAverage > MEMORY_BOUND_THRESHOLD_MB) return null;
  // networkOutMB is total MB in the collection period; >100 GB/period = network-intensive
  if (util.networkOutMB > NETWORK_INTENSIVE_THRESHOLD_MB) return null;
  // diskReadIOPS + diskWriteIOPS: >5000 combined indicates I/O-intensive workload
  if (util.diskReadIOPS + util.diskWriteIOPS > IOPS_INTENSIVE_THRESHOLD) return null;

  const suggested = suggestRightsize(r.instanceType, util.cpuP95, cfg.rightsizeCPUThreshold);
  if (suggested === r.instanceType) return null;
  const monthlyCost = getMonthlyCost(r);
  const [, currentSize] = splitInstanceType(r.instanceType);
  const [, suggestedSize] = splitInstanceType(suggested);
  const currentIdx = sizeIndex(currentSize);
  const suggestedIdx = sizeIndex(suggestedSize);

  // Prefer real pricing delta; fall back to exponential size-ratio approximation
  const currentMonthly = estimateEC2CostSync(r.instanceType, r.region);
  const suggestedMonthly = estimateEC2CostSync(suggested, r.region);
  let savings: number;
  if (currentMonthly > 0 && suggestedMonthly > 0) {
    savings = currentMonthly - suggestedMonthly;
  } else {
    const sizeRatio = suggestedIdx >= 0 && currentIdx > suggestedIdx
      ? Math.pow(0.5, currentIdx - suggestedIdx)
      : cfg.ec2RightsizeMultiplier;
    savings = monthlyCost * (1 - sizeRatio);
  }
  savings = Math.max(0, savings);
  if (!Number.isFinite(savings)) return null;

  // Assess memory data availability for risk/confidence rating
  const hasMemoryData = util.memoryAverage !== undefined && util.memoryAverage > 0;
  const risk = hasMemoryData ? 'low' : 'medium';
  let confidence = confidenceFromUtilization(0.85, util);
  // P99 spike detection: if P99 is high but P95 passed the threshold, flag uncertainty
  if ((util.cpuP99 ?? 0) > cfg.rightsizeCPUThreshold && util.cpuP95 < cfg.rightsizeCPUThreshold) {
    confidence = Math.min(confidence, 0.55);
  }
  if (!hasMemoryData) {
    confidence = Math.min(confidence, 0.65);
  }
  const memoryWarning = hasMemoryData
    ? `Memory average: ${util.memoryAverage.toFixed(0)} MB.`
    : 'Memory metrics unavailable (CloudWatch Agent not installed) — verify memory usage before downsizing to avoid OOM issues.';

  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'EC2-004',
    resourceId: r.id,
    resourceType: r.type,
    title: `Rightsize EC2 instance ${r.name}: ${r.instanceType} → ${suggested}`,
    description: hasMemoryData
      ? `Instance ${r.name} has CPU P95 of ${util.cpuP95.toFixed(1)}% on ${r.instanceType}. Rightsizing to ${suggested} could save ~${savings.toFixed(0)} ${cfg.currency}/mo.`
      : `Instance ${r.name} has CPU P95 of ${util.cpuP95.toFixed(1)}% on ${r.instanceType}. Rightsizing to ${suggested} could save ~${savings.toFixed(0)} ${cfg.currency}/mo. ⚠ Memory data unavailable — verify before applying.`,
    reasoning: `CPU P95 of ${util.cpuP95.toFixed(1)}% is well below the ${cfg.rightsizeCPUThreshold}% rightsizing threshold. Average CPU is ${util.cpuAverage.toFixed(1)}%. ${memoryWarning}`,
    impact: 'high',
    risk,
    estimatedSavings: guardSavings(savings),
    suggestedAction: `rightsize_to_${suggested}`,
    confidence: clampConfidence(confidence),
    filePath,
    currentConfig: { instance_type: r.instanceType, cpu_p95_pct: util.cpuP95 },
    suggestedConfig: { instance_type: suggested },
    patchContent: `  instance_type = "${sanitizeResourceName(suggested)}"  # was: ${sanitizeResourceName(r.instanceType)} (CPU P95 ${util.cpuP95.toFixed(1)}%)`,
    implementationSteps: [
      filePath ? `Change instance_type from ${sanitizeResourceName(r.instanceType)} to ${sanitizeResourceName(suggested)} in ${filePath}` : `Change instance_type from ${sanitizeResourceName(r.instanceType)} to ${sanitizeResourceName(suggested)}`,
      'Apply change during a maintenance window',
      'Monitor CPU and memory for 48 hours post-change',
      'Run terraform plan to verify, then terraform apply',
    ],
  };
}

/** EC2-005: On-demand instance running 30+ days — RI/Savings Plan opportunity. */
export function checkEC2005(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'ec2_instance' || r.state !== 'running') return null;
  const lifecycle = strConfig(r, 'lifecycle');
  if (lifecycle === 'spot') return null;
  const runningDays = daysSince(r.launchTime) ?? 0;
  if (runningDays < cfg.onDemandRunningDays) return null;
  const monthlyCost = getMonthlyCost(r);
  const savings = monthlyCost * cfg.ec2RIDiscountMultiplier;
  if (!Number.isFinite(savings) || savings < 0) return null;
  return {
    ruleId: 'EC2-005',
    resourceId: r.id,
    resourceType: r.type,
    title: `Purchase Reserved Instance or Savings Plan for ${r.name}`,
    description: `Instance ${r.name} (${r.instanceType}) has been running on-demand for ${cfg.onDemandRunningDays}+ days. Reserved Instances or Savings Plans save 30-60%.`,
    reasoning: `Instance has been running for ${runningDays} days. At ${monthlyCost.toFixed(2)} ${cfg.currency}/mo on-demand, a 1-year RI commitment saves ~${savings.toFixed(0)} ${cfg.currency}/mo.`,
    impact: 'high',
    risk: 'medium',
    estimatedSavings: guardSavings(savings),
    suggestedAction: 'purchase_reserved_instance',
    confidence: clampConfidence(0.8),
    currentConfig: { pricing: 'on_demand', instance_type: r.instanceType, running_days: runningDays },
    suggestedConfig: { pricing: 'reserved_1yr_no_upfront' },
    patchContent: `# Purchase 1-year No-Upfront RI for ${sanitizeResourceName(r.instanceType)} ${sanitizeResourceName(r.region)}\n# aws ec2 purchase-reserved-instances-offering ...`,
    implementationSteps: [
      'Review instance usage patterns over the past 30 days',
      'Purchase 1-year No Upfront Reserved Instance via AWS Console or CLI',
      'Alternatively, purchase a Compute Savings Plan for more flexibility',
    ],
  };
}

/** EC2-006: Graviton migration (x86_64 → arm64). */
export function checkEC2006(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'ec2_instance') return null;
  const arch = strConfig(r, 'architecture');
  if (arch !== 'x86_64') return null;
  const [family, size] = splitInstanceType(r.instanceType);
  const gravitonFamily = gravitonFamilies[family];
  if (!gravitonFamily) return null;
  const suggestedType = gravitonFamily + '.' + size;
  const monthlyCost = getMonthlyCost(r);
  // Prefer real pricing delta; fall back to configured multiplier estimate
  const currentMonthly = estimateEC2CostSync(r.instanceType, r.region);
  const gravitonMonthly = estimateEC2CostSync(suggestedType, r.region);
  let savings: number;
  let confidence: number;
  if (currentMonthly > 0 && gravitonMonthly > 0) {
    savings = Math.max(0, currentMonthly - gravitonMonthly);
    confidence = 0.85;
  } else {
    savings = monthlyCost * cfg.ec2GravitonMultiplier;
    confidence = 0.65; // instance type not in fallback pricing table
  }
  if (!Number.isFinite(savings) || savings < 0) return null;
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'EC2-006',
    resourceId: r.id,
    resourceType: r.type,
    title: `Migrate EC2 instance ${r.name} from ${r.instanceType} to Graviton (${suggestedType}, ~20% cheaper)`,
    description: `Instance ${r.name} uses x86_64 architecture on ${r.instanceType}. Graviton equivalent ${suggestedType} costs ~20% less with equal or better performance.`,
    reasoning: `AWS Graviton processors offer better price/performance for most workloads. Migrating ${r.instanceType} to ${suggestedType} saves ~20% per month.`,
    impact: 'medium',
    risk: 'low',
    estimatedSavings: guardSavings(savings),
    suggestedAction: `migrate_to_graviton_${suggestedType}`,
    confidence: clampConfidence(confidence),
    filePath,
    currentConfig: { instance_type: r.instanceType, architecture: 'x86_64' },
    suggestedConfig: { instance_type: suggestedType, architecture: 'arm64' },
    patchContent: `  instance_type = "${sanitizeResourceName(suggestedType)}"  # was: ${sanitizeResourceName(r.instanceType)} (Graviton, ~20% cheaper)`,
    implementationSteps: [
      'Verify the application and all dependencies support arm64 (most Linux workloads do)',
      `Stop the instance and change instance_type to ${sanitizeResourceName(suggestedType)}`,
      'Restart and run smoke tests to validate functionality',
      filePath ? `Update ${filePath}: instance_type = "${sanitizeResourceName(suggestedType)}"` : `Set instance_type = "${sanitizeResourceName(suggestedType)}"`,
      'Run terraform plan to verify, then terraform apply',
    ],
  };
}

/** EC2-007: t2 → t3 migration (also recommends t4g as preferred target). */
export function checkEC2007(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'ec2_instance') return null;
  const [family, size] = splitInstanceType(r.instanceType);
  if (family !== 't2') return null;
  const suggestedType = 't3.' + size;
  const monthlyCost = getMonthlyCost(r);
  // Prefer real pricing delta; fall back to configured multiplier estimate
  const currentMonthly = estimateEC2CostSync(r.instanceType, r.region);
  const t3Monthly = estimateEC2CostSync(suggestedType, r.region);
  const savings = currentMonthly > 0 && t3Monthly > 0
    ? Math.max(0, currentMonthly - t3Monthly)
    : monthlyCost * cfg.ec2T2T3Multiplier;
  if (!Number.isFinite(savings) || savings < 0) return null;
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'EC2-007',
    resourceId: r.id,
    resourceType: r.type,
    title: `Upgrade EC2 instance ${r.name} from t2 to t3 (${r.instanceType} → ${suggestedType})`,
    description: `Instance ${r.name} uses t2 which is older and more expensive than t3. t3 offers unlimited burst by default and better baseline CPU performance. Note: t3 instances enable unlimited burst by default, which charges $0.05/vCPU-hour when CPU credits are depleted. If your workload sustains high CPU, verify unlimited mode does not increase costs before switching.`,
    reasoning: 't3 instances are cheaper per hour than t2 and use the newer unlimited burst credit model. The migration is drop-in compatible for all t2 sizes.',
    impact: 'low',
    risk: 'low',
    estimatedSavings: guardSavings(savings),
    suggestedAction: `upgrade_to_${suggestedType}`,
    confidence: clampConfidence(0.9),
    filePath,
    currentConfig: { instance_type: r.instanceType },
    suggestedConfig: { instance_type: suggestedType },
    patchContent: `  instance_type = "${sanitizeResourceName(suggestedType)}"  # was: ${sanitizeResourceName(r.instanceType)} (t3 is cheaper with better burst)`,
    implementationSteps: [
      `Stop the instance and change instance_type from ${sanitizeResourceName(r.instanceType)} to ${sanitizeResourceName(suggestedType)}`,
      'Restart the instance — t3 is API-compatible with t2 for the same sizes',
      filePath ? `Update ${filePath}: instance_type = "${sanitizeResourceName(suggestedType)}"` : `Set instance_type = "${sanitizeResourceName(suggestedType)}"`,
      'Run terraform plan to verify, then terraform apply',
    ],
  };
}

/** EC2-008: GPU/ML/specialty previous-generation instance upgrade (April 2026). */
export function checkEC2008(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'ec2_instance' || !r.instanceType) return null;
  // Skip families already handled by EC2-003 (previousGenFamilies in helpers.ts)
  if (isPreviousGen(r.instanceType)) return null;
  const upgradePaths: Record<string, string> = {
    // GPU / ML accelerator upgrades (April 2026)
    g2: 'g5', g3: 'g5', g4dn: 'g6',
    p2: 'p5', p3: 'p5',
    inf1: 'inf2',
    x1: 'x2idn', x1e: 'x2iedn',
    h1: 'd3',
  };
  const [family, size] = splitInstanceType(r.instanceType);
  const newFamily = upgradePaths[family];
  if (!newFamily) return null;
  const suggestedType = newFamily + '.' + size;
  const monthlyCost = getMonthlyCost(r);
  const savings = monthlyCost * cfg.ec2GPUPreviousGenMultiplier;
  if (!Number.isFinite(savings) || savings < 0) return null;
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'EC2-008',
    resourceId: r.id,
    resourceType: r.type,
    title: `Upgrade EC2 instance ${r.name} from previous-generation ${r.instanceType} to ${suggestedType}`,
    description: `Instance ${r.name} uses previous-generation type ${r.instanceType}. Upgrading to current-generation ${suggestedType} offers better price/performance (4-25% savings depending on family).`,
    reasoning: `Previous-generation instance families (${family}) have been superseded. The current-generation equivalent ${suggestedType} delivers more vCPU performance and lower cost per compute unit.`,
    impact: 'medium',
    risk: 'low',
    estimatedSavings: guardSavings(savings),
    suggestedAction: `upgrade_to_${suggestedType}`,
    confidence: clampConfidence(0.85),
    filePath,
    currentConfig: { instance_type: r.instanceType },
    suggestedConfig: { instance_type: suggestedType },
    patchContent: `  instance_type = "${sanitizeResourceName(suggestedType)}"  # was: ${sanitizeResourceName(r.instanceType)} (previous-generation)`,
    implementationSteps: [
      `Stop the instance and change instance_type to ${sanitizeResourceName(suggestedType)}`,
      'Restart and validate application performance — architecture is compatible for most workloads',
      filePath ? `Update ${filePath}: instance_type = "${sanitizeResourceName(suggestedType)}"` : `Set instance_type = "${sanitizeResourceName(suggestedType)}"`,
      'Run terraform plan to verify, then terraform apply',
    ],
  };
}

/** EC2-009: Stopped instance with ongoing EBS charges. */
export function checkEC2009(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'ec2_instance' || r.state !== 'stopped') return null;
  // Defer to EC2-002 when the instance has been stopped long enough for EC2-002 to fire
  const transitionDays = numConfig(r, 'state_transition_days');
  const stoppedAt = strConfig(r, 'stopped_at');
  const stoppedDays = transitionDays || (stoppedAt ? daysSince(stoppedAt) : null);
  if (stoppedDays !== null && stoppedDays >= cfg.stoppedInstanceDays) return null;
  const ebsGB = numConfig(r, 'ebs_volumes_total_gb');
  let savings: number;
  let ebsDesc: string;
  if (ebsGB > 0) {
    savings = ebsGB * EBS_GP3_PER_GB;
    ebsDesc = `${ebsGB.toFixed(0)} GiB of attached EBS storage (est. ${savings.toFixed(2)} ${cfg.currency}/mo)`;
  } else {
    savings = EBS_MINIMUM_MONTHLY_USD * 4; // $20 baseline: ~4 volumes × $5 minimum
    ebsDesc = `attached EBS volumes (est. ${EBS_MINIMUM_MONTHLY_USD * 4} ${cfg.currency}/mo baseline)`;
  }
  if (!Number.isFinite(savings) || savings < 0) return null;
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'EC2-009',
    resourceId: r.id,
    resourceType: r.type,
    title: `Stopped EC2 instance ${r.name} is still incurring EBS charges`,
    description: `Instance ${r.name} is stopped but has ${ebsDesc}. Stopped instances do not incur compute charges but EBS volumes continue to be billed.`,
    reasoning: 'EBS volumes attached to stopped EC2 instances are billed at the standard storage rate regardless of instance state. If the instance is no longer needed, terminating it (with a snapshot backup) eliminates the storage cost.',
    impact: 'medium',
    risk: 'low',
    estimatedSavings: guardSavings(savings),
    suggestedAction: 'terminate_after_snapshot',
    confidence: clampConfidence(0.90),
    filePath,
    currentConfig: { state: 'stopped', ebs_volumes_total_gb: ebsGB },
    suggestedConfig: { action: 'terminate_after_snapshot' },
    patchContent: `# Terminate stopped instance ${sanitizeResourceName(r.name)} and delete EBS volumes after snapshotting\n# aws ec2 terminate-instances --instance-ids ${sanitizeResourceName(r.id)}`,
    implementationSteps: [
      'Confirm the instance is no longer required with the owning team',
      'Create snapshots of all attached EBS volumes for archival',
      'Terminate the instance — EBS volumes can then be deleted',
      filePath ? `Remove the aws_instance resource block from ${filePath}` : 'Remove the Terraform aws_instance resource block',
      'Run terraform plan to verify, then terraform apply',
    ],
  };
}

/** EC2-010: High outbound data transfer (>1 TB/mo estimated). */
export function checkEC2010(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'ec2_instance' || !r.utilization) return null;
  const DATA_TRANSFER_USD_PER_GB = 0.09;
  const estimatedMonthlyMB = normalizeToMonth(r.utilization.networkOutMB, r.utilization.period);
  if (estimatedMonthlyMB <= cfg.ec2HighNetworkOutThresholdMB) return null;
  const networkOutGB = estimatedMonthlyMB / 1024.0;
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'EC2-010',
    resourceId: r.id,
    resourceType: r.type,
    title: `EC2 instance ${r.name} has high outbound data transfer (~${networkOutGB.toFixed(0)} GB/mo estimated)`,
    description: `Instance ${r.name} transferred ${r.utilization.networkOutMB.toFixed(1)} MB outbound in the collection period (~${networkOutGB.toFixed(0)} GB/month estimated). At ${DATA_TRANSFER_USD_PER_GB} ${cfg.currency}/GB this costs ~${(networkOutGB * DATA_TRANSFER_USD_PER_GB).toFixed(0)} ${cfg.currency}/mo in data transfer charges. CloudFront or VPC endpoints may reduce this cost.`,
    reasoning: `AWS charges ${DATA_TRANSFER_USD_PER_GB} ${cfg.currency}/GB for outbound data to the internet after the first GB. At an estimated ${networkOutGB.toFixed(0)} GB/mo the transfer cost alone is ~${(networkOutGB * DATA_TRANSFER_USD_PER_GB).toFixed(0)} ${cfg.currency}/mo. CloudFront caching or VPC Gateway Endpoints for S3/DynamoDB can substantially reduce these charges.`,
    impact: 'medium',
    risk: 'low',
    estimatedSavings: 0,
    suggestedAction: 'add_cloudfront_or_vpc_endpoints',
    confidence: clampConfidence(0.7),
    filePath,
    currentConfig: { network_out_mb_avg_hourly: r.utilization.networkOutMB, network_out_gb_mo_estimated: networkOutGB },
    suggestedConfig: { action: 'add_cloudfront_or_vpc_endpoints' },
    patchContent: '# Add CloudFront distribution or VPC Gateway Endpoints to reduce data transfer costs',
    implementationSteps: [
      'Review what data is being transferred — use VPC Flow Logs to identify destinations',
      'Add free VPC Gateway Endpoints for S3 and DynamoDB to eliminate NAT/internet charges',
      'Consider CloudFront for content served to end users to reduce origin egress',
      `Review traffic patterns for instance ${r.name} in CloudWatch NetworkOut metric`,
    ],
  };
}

/** EC2-011: No EBS optimization (non-burstable instance). */
export function checkEC2011(r: Resource, cfg: Cfg): Recommendation | null {
  void cfg;
  if (r.type !== 'ec2_instance') return null;
  if (!('ebs_optimized' in r.configuration)) return null;
  if (boolConfig(r, 'ebs_optimized')) return null;
  const [family] = splitInstanceType(r.instanceType);
  if (['t2', 't3', 't3a', 't4g'].includes(family)) return null;
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'EC2-011',
    resourceId: r.id,
    resourceType: r.type,
    title: `EC2 instance ${r.name} (${r.instanceType}) does not have EBS optimization enabled`,
    description: `Instance ${r.name} (${r.instanceType}) has ebs_optimized = false. Non-burstable instances without EBS optimization share bandwidth between EBS and network traffic, degrading I/O performance.`,
    reasoning: 'EBS-optimized instances have dedicated bandwidth for EBS I/O, preventing contention with network traffic. Most current-generation instance types support EBS optimization and it has no additional cost for many families.',
    impact: 'medium',
    risk: 'low',
    estimatedSavings: 0,
    suggestedAction: 'enable_ebs_optimization',
    confidence: clampConfidence(0.8),
    filePath,
    currentConfig: { instance_type: r.instanceType, ebs_optimized: false },
    suggestedConfig: { ebs_optimized: true },
    patchContent: '  ebs_optimized = true  # was: false',
    implementationSteps: [
      'Verify the instance type supports EBS optimization (most current-gen types do, and it is free)',
      'Stop the instance, enable EBS optimization, and restart',
      filePath ? `Update ${filePath}: ebs_optimized = true` : 'Set ebs_optimized = true',
      'Run terraform plan to verify, then terraform apply',
    ],
  };
}

/** EC2-012: IMDSv2 not enforced. */
export function checkEC2012(r: Resource, cfg: Cfg): Recommendation | null {
  void cfg;
  if (r.type !== 'ec2_instance') return null;
  if (!('metadata_options_http_tokens' in r.configuration)) return null;
  if (strConfig(r, 'metadata_options_http_tokens') === 'required') return null;
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'EC2-012',
    resourceId: r.id,
    resourceType: r.type,
    title: `EC2 instance ${r.name} does not enforce IMDSv2 (metadata_options.http_tokens != required)`,
    description: `Instance ${r.name} allows IMDSv1 access. IMDSv1 is vulnerable to SSRF attacks that can be used to steal IAM credentials. Setting http_tokens = required enforces IMDSv2.`,
    reasoning: 'IMDSv1 SSRF vulnerabilities have led to high-profile breaches. IMDSv2 requires a PUT request with a session token before metadata can be read, preventing SSRF exploitation. This is a zero-cost security hardening step.',
    impact: 'high',
    risk: 'low',
    estimatedSavings: 0,
    suggestedAction: 'enforce_imdsv2',
    confidence: clampConfidence(0.95),
    filePath,
    currentConfig: { metadata_options_http_tokens: 'optional' },
    suggestedConfig: { metadata_options_http_tokens: 'required' },
    patchContent: '  metadata_options {\n    http_tokens = "required"  # was: optional (enforce IMDSv2)\n  }',
    implementationSteps: [
      'Verify the application does not use IMDSv1 directly (most SDKs support IMDSv2 automatically)',
      `Enable IMDSv2: aws ec2 modify-instance-metadata-options --instance-id ${sanitizeResourceName(r.id)} --http-tokens required`,
      filePath ? `Update ${filePath}: metadata_options { http_tokens = "required" }` : 'Set metadata_options { http_tokens = "required" }',
      'Run terraform plan to verify, then terraform apply',
      'Test the application to confirm IMDSv2 compatibility',
    ],
  };
}

/** EC2-013: Instance running for more than 1 year. */
export function checkEC2013(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'ec2_instance' || r.state !== 'running') return null;
  if (!r.launchTime) return null;
  const age = daysSince(r.launchTime);
  if (age === null || age <= cfg.instanceMaxAgeDays) return null;
  const monthlyCost = getMonthlyCost(r);
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'EC2-013',
    resourceId: r.id,
    resourceType: r.type,
    title: `EC2 instance ${r.name} has been running continuously for ${age} days (>${cfg.instanceMaxAgeDays} days)`,
    description: `Instance ${r.name} (${r.instanceType}) has been running for ${age} days without stopping (threshold: ${cfg.instanceMaxAgeDays} days). Long-running instances should be reviewed for continued relevance and evaluated for Reserved Instance or Savings Plan coverage.`,
    reasoning: `Instances running continuously for over a year without a stop/restart may be forgotten workloads, over-provisioned, or strong RI/Savings Plan candidates. At ${monthlyCost.toFixed(2)} ${cfg.currency}/mo over ${age} days, this is a high-value review target.`,
    impact: 'low',
    risk: 'low',
    estimatedSavings: 0,
    suggestedAction: 'review_and_consider_ri',
    confidence: clampConfidence(0.7),
    filePath,
    currentConfig: { instance_type: r.instanceType, age_days: age, state: 'running' },
    suggestedConfig: { action: 'review_and_consider_ri' },
    patchContent: `# Review long-running instance ${sanitizeResourceName(r.name)} (${sanitizeResourceName(r.instanceType)}, ${age} days)\n# Consider Reserved Instance: aws ec2 describe-reserved-instances-offerings`,
    implementationSteps: [
      'Review with the owning team whether this instance is still needed',
      'Check if the workload is suitable for a Reserved Instance or Savings Plan (1-year saves ~40%)',
      'Consider whether the instance should be managed by an Auto Scaling Group for resiliency',
      'Verify the instance type is current-generation (see EC2-003/EC2-008 recommendations)',
      `Open AWS Cost Explorer > RI Recommendations for ${sanitizeResourceName(r.instanceType)} in ${sanitizeResourceName(r.region)}`,
    ],
  };
}

/**
 * EC2-014: On-demand instance is a candidate for Spot pricing.
 *
 * Fires on long-running on-demand instances that look like good Spot candidates.
 * Two independent triggers (the issue spec's third — `autoscale_min_size === 0` —
 * is deferred until an Auto Scaling collector populates that field).
 *
 *   Branch A — tag corroboration: Environment tag in {dev,staging,test} AND uptime > 14d.
 *   Branch B — stable workload:   uptime > 30d AND CPU is non-idle, not maxed, not spiky.
 *
 * Savings: `monthlyCost × cfg.ec2SpotSavingsMultiplier` (default 0.70). We don't
 * use the real-pricing-delta pattern (`estimateEC2CostSync`) because
 * `FALLBACK_EC2_PRICES` only knows on-demand rates — Spot prices are volatile
 * per AZ/time and cannot be hardcoded. This matches EC2-005's RI multiplier approach.
 */
export function checkEC2014(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'ec2_instance' || r.state !== 'running') return null;

  // Skip already-committed pricing (Spot or scheduled both have committed rates)
  const lifecycle = strConfig(r, 'lifecycle');
  if (lifecycle === 'spot' || lifecycle === 'scheduled') return null;

  // Bare-metal has poor Spot capacity and slow recovery — skip
  if (r.instanceType.endsWith('.metal')) return null;

  const uptimeDays = daysSince(r.launchTime);
  if (uptimeDays === null || uptimeDays <= cfg.spotMinUptimeDays) return null;

  // Branch A — tag corroboration
  const env = (r.tags['Environment'] ?? r.tags['environment'] ?? '').toLowerCase();
  const tagMatch =
    cfg.spotNonProdEnvironments.includes(env) &&
    uptimeDays > cfg.spotNonProdUptimeDays;

  // Branch B — stable workload (CPU stability proxy; raw variance not collected)
  let stableWorkload = false;
  const util = r.utilization;
  if (util && util.dataPoints > 0 && uptimeDays > cfg.spotStableUptimeDays) {
    const spikeRatio = util.cpuP99 / Math.max(util.cpuP95, 1);
    stableWorkload =
      util.cpuAverage >= cfg.idleCPUThreshold && // not idle — EC2-001 territory
      util.cpuP99 <= cfg.spotP99CeilingPct &&    // not maxed-out — interruption rescue risky
      spikeRatio < cfg.spotSpikeRatioMax;        // not spiky
  }

  if (!tagMatch && !stableWorkload) return null;

  const monthlyCost = getMonthlyCost(r);
  const savings = monthlyCost * cfg.ec2SpotSavingsMultiplier;
  if (!Number.isFinite(savings) || savings <= 0) return null;

  // Confidence: medium with variance alone, high when tag corroborates
  const baseConfidence = stableWorkload && tagMatch ? 0.85
                       : tagMatch                   ? 0.80
                       :                              0.55;
  const confidence = confidenceFromUtilization(baseConfidence, util);
  const risk = tagMatch ? 'low' : 'medium';

  const reasoningParts: string[] = [];
  if (tagMatch) reasoningParts.push(`tagged Environment=${env}`);
  if (stableWorkload && util) {
    reasoningParts.push(`stable workload (avg ${util.cpuAverage.toFixed(1)}%, P95 ${util.cpuP95.toFixed(1)}%, P99 ${util.cpuP99.toFixed(1)}%)`);
  }
  const filePath = strConfig(r, 'file_path');

  return {
    ruleId: 'EC2-014',
    resourceId: r.id,
    resourceType: r.type,
    title: `Migrate on-demand EC2 instance ${r.name} (${r.instanceType}) to Spot pricing`,
    description: `Instance ${r.name} (${r.instanceType}) has run on-demand for ${uptimeDays} days; ${reasoningParts.join(' and ')}. Spot is 60-90% cheaper than on-demand but can be reclaimed with 2-minute notice — best for fault-tolerant or non-production workloads.`,
    reasoning: `${reasoningParts.join('. ')}. Recommendation applies a ${(cfg.ec2SpotSavingsMultiplier * 100).toFixed(0)}% Spot savings multiplier to the monthly on-demand cost (${monthlyCost.toFixed(2)} ${cfg.currency}/mo).`,
    impact: 'high',
    risk,
    estimatedSavings: guardSavings(savings),
    suggestedAction: 'migrate_to_spot',
    confidence: clampConfidence(confidence),
    filePath,
    currentConfig: {
      pricing: 'on_demand',
      instance_type: r.instanceType,
      environment: env || null,
      uptime_days: uptimeDays,
    },
    suggestedConfig: { pricing: 'spot_or_asg_with_spot' },
    patchContent: `# Migrate ${sanitizeResourceName(r.name)} to Spot via a Spot-backed Auto Scaling Group\n# https://docs.aws.amazon.com/autoscaling/ec2/userguide/asg-purchase-options.html`,
    implementationSteps: [
      'Verify the workload is fault-tolerant (handles SIGTERM, has retries, no long-running in-memory state)',
      'Create a launch template based on the current instance configuration',
      'Create an Auto Scaling group with a mixed instances policy: 100% Spot or 80/20 Spot/On-Demand',
      filePath ? `Update ${filePath} to point at the new ASG, then drain and terminate the existing instance` : 'Drain the existing instance via target group deregistration, then terminate',
    ],
  };
}

export const ec2Rules = [
  checkEC2001,
  checkEC2002,
  checkEC2003,
  checkEC2004,
  checkEC2005,
  checkEC2006,
  checkEC2007,
  checkEC2008,
  checkEC2009,
  checkEC2010,
  checkEC2011,
  checkEC2012,
  checkEC2013,
  checkEC2014,
];
