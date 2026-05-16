/**
 * RDS cost optimization rules.
 * Ported from Go internal/ai/rules.go (RDS-001 through RDS-013).
 */

import type { Resource } from '../../aws/types.js';
import type { Recommendation, RuleContext } from '../types.js';
import type { ThresholdsOverride } from '../config.js';
import type { THRESHOLDS } from '../config.js';
import { suggestRDSRightsize, strConfig, boolConfig, numConfig, sanitizeResourceName, getMonthlyCost, getMonthlyCostStrict, confidenceFromUtilization } from './helpers.js';
import { clampConfidence, guardSavings } from '../../utils/numeric-guards.js';
import { RDS_GP2_STORAGE_PER_GB, RDS_GP3_STORAGE_PER_GB, RDS_IO1_STORAGE_PER_GB, RDS_IO2_STORAGE_PER_GB, estimateRDSCostSync } from '../../pricing/resources.js';

type Cfg = typeof THRESHOLDS & ThresholdsOverride;

/** RDS-001: Idle RDS instance (CPU avg < threshold). */
export function checkRDS001(r: Resource, cfg: Cfg, ctx?: RuleContext): Recommendation | null {
  if (r.type !== 'rds_instance' || !r.utilization) return null;
  if (r.utilization.cpuAverage >= cfg.rdsIdleCPUThreshold) return null;
  if (r.utilization.dataPoints <= 0) return null;
  const monthlyCost = getMonthlyCostStrict(r);
  if (monthlyCost === null) {
    ctx?.warn('RDS-001', r.id, r.type, 'monthly_cost missing or invalid');
    return null;
  }
  const filePath = strConfig(r, 'file_path');
  const confidence = confidenceFromUtilization(0.85, r.utilization);
  return {
    ruleId: 'RDS-001',
    resourceId: r.id,
    resourceType: r.type,
    title: `Stop or delete idle RDS instance ${r.name}`,
    description: `RDS instance ${r.name} (${r.instanceType}) has had near-zero CPU utilisation (${r.utilization.cpuAverage.toFixed(2)}%) for ${r.utilization.period} with no apparent activity.`,
    reasoning: 'Idle RDS instances are typically staging or dev databases forgotten after use. Stopping saves compute costs; snapshot+delete saves storage too.',
    impact: 'high',
    risk: 'medium',
    estimatedSavings: guardSavings(monthlyCost * cfg.rdsIdleMultiplier),
    suggestedAction: 'stop_or_delete',
    confidence: clampConfidence(confidence),
    filePath,
    currentConfig: { instance_class: r.instanceType, cpu_avg_pct: r.utilization.cpuAverage },
    suggestedConfig: { action: 'stop_or_delete' },
    patchContent: `# Stop idle RDS instance ${sanitizeResourceName(r.name)}\n# aws rds stop-db-instance --db-instance-identifier ${sanitizeResourceName(r.id)}`,
    implementationSteps: [
      'Confirm with the owning team that the database is not in use',
      'Take a final snapshot',
      'Stop the instance (preserves data, saves compute) or delete it',
      filePath ? `If deleting: remove aws_db_instance block from ${filePath}` : 'If deleting: remove the aws_db_instance block',
    ],
  };
}

/** RDS-002: Production RDS without Multi-AZ. */
export function checkRDS002(r: Resource, cfg: Cfg): Recommendation | null {
  void cfg;
  if (r.type !== 'rds_instance') return null;
  if (boolConfig(r, 'multi_az')) return null;
  // Normalize tag value to lowercase for case-insensitive comparison
  const envTag = (r.tags?.['Environment'] ?? r.tags?.['environment'] ?? '').toLowerCase();
  const isProduction = envTag === 'production' || envTag === 'prod';
  if (!isProduction) return null;
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'RDS-002',
    resourceId: r.id,
    resourceType: r.type,
    title: `Enable Multi-AZ on production RDS instance ${r.name}`,
    description: `Production RDS instance ${r.name} does not have Multi-AZ enabled. This is a reliability risk.`,
    reasoning: 'Single-AZ RDS instances have no automatic failover. A hardware failure in the AZ would cause downtime until the instance is recovered.',
    impact: 'high',
    risk: 'low',
    estimatedSavings: 0,
    suggestedAction: 'enable_multi_az',
    confidence: clampConfidence(0.9),
    filePath,
    currentConfig: { multi_az: false },
    suggestedConfig: { multi_az: true },
    patchContent: '  multi_az = true  # was: false (no automatic failover)',
    implementationSteps: [
      filePath ? `Update ${filePath}: multi_az = true` : 'Set multi_az = true',
      'Run terraform plan to verify the change',
      'Apply during a low-traffic window (brief I/O pause when standby replica is created)',
      'AWS will create a standby replica in another AZ automatically',
    ],
  };
}

/** RDS-003: Oversized RDS instance (CPU avg < threshold). */
export function checkRDS003(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'rds_instance' || !r.utilization) return null;
  if (r.utilization.cpuAverage >= cfg.rdsRightsizeCPUThreshold) return null;
  // Also guard on P95 — a bursty workload with low average but high P95 should not be downsized
  if (r.utilization.cpuP95 >= cfg.rdsRightsizeCPUThreshold) return null;

  // Multi-metric gating: active connections indicate the DB is in use despite low CPU
  if (r.utilization.connectionCount > cfg.rdsConnectionIdleThreshold * 5) return null;

  const suggestedType = suggestRDSRightsize(r.instanceType, r.utilization.cpuP95, cfg.rdsRightsizeCPUThreshold);
  if (!suggestedType || suggestedType === r.instanceType) return null;

  const monthlyCost = getMonthlyCost(r);
  const currentMonthly = estimateRDSCostSync(r.instanceType, r.region);
  const suggestedMonthly = estimateRDSCostSync(suggestedType, r.region);
  let savings: number;
  if (currentMonthly > 0 && suggestedMonthly > 0) {
    savings = currentMonthly - suggestedMonthly;
  } else {
    savings = monthlyCost * cfg.rdsRightsizeMultiplier;
  }
  savings = guardSavings(savings);

  let confidence = confidenceFromUtilization(0.80, r.utilization);
  const descriptionNotes: string[] = [];

  // Active connections: reduce confidence if DB has meaningful connections despite low CPU
  if (r.utilization.connectionCount >= 10) {
    confidence = Math.min(confidence, 0.55);
    descriptionNotes.push('Active connections detected');
  }

  // Connection burst pattern: peak much higher than average suggests bursty usage
  if (r.utilization.connectionCountMax > r.utilization.connectionCount * 3) {
    confidence = Math.min(confidence, 0.65);
    descriptionNotes.push('Connection burst pattern detected');
  }

  const filePath = strConfig(r, 'file_path');
  const notesSuffix = descriptionNotes.length > 0 ? ` Note: ${descriptionNotes.join('; ')}.` : '';
  return {
    ruleId: 'RDS-003',
    resourceId: r.id,
    resourceType: r.type,
    title: `Rightsize RDS instance ${r.name}: ${r.instanceType} → ${suggestedType}`,
    description: `RDS instance ${r.name} has CPU average of ${r.utilization.cpuAverage.toFixed(1)}% over ${r.utilization.period}. Suggest rightsizing from ${r.instanceType} to ${suggestedType}.${notesSuffix}`,
    reasoning: `CPU avg ${r.utilization.cpuAverage.toFixed(1)}% is well below the ${cfg.rdsRightsizeCPUThreshold}% RDS rightsizing threshold.`,
    impact: 'high',
    risk: 'medium',
    estimatedSavings: guardSavings(savings),
    suggestedAction: `rightsize_to_${suggestedType}`,
    confidence: clampConfidence(confidence),
    filePath,
    currentConfig: { instance_class: r.instanceType, cpu_avg_pct: r.utilization.cpuAverage },
    suggestedConfig: { instance_class: suggestedType },
    patchContent: `  instance_class = "${sanitizeResourceName(suggestedType)}"  # was: ${sanitizeResourceName(r.instanceType)} (CPU avg ${r.utilization.cpuAverage.toFixed(1)}%)`,
    implementationSteps: [
      filePath ? `Update ${filePath}: instance_class = "${sanitizeResourceName(suggestedType)}"` : `Set instance_class = "${sanitizeResourceName(suggestedType)}"`,
      'Run terraform plan to verify the change',
      'Schedule during a low-traffic window (requires a brief restart)',
      'Monitor CPU and memory for 48 hours post-change',
    ],
  };
}

/** RDS-004: Unencrypted RDS storage. */
export function checkRDS004(r: Resource, cfg: Cfg): Recommendation | null {
  void cfg;
  if (r.type !== 'rds_instance') return null;
  if (boolConfig(r, 'storage_encrypted')) return null;
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'RDS-004',
    resourceId: r.id,
    resourceType: r.type,
    title: `Enable storage encryption on RDS instance ${r.name}`,
    description: `RDS instance ${r.name} does not have storage encryption enabled.`,
    reasoning: 'Unencrypted RDS storage is a compliance and security risk. Encryption-at-rest is free and required by most compliance frameworks.',
    impact: 'high',
    risk: 'high',
    estimatedSavings: 0,
    suggestedAction: 'enable_storage_encryption',
    confidence: clampConfidence(0.99),
    filePath,
    currentConfig: { storage_encrypted: false },
    suggestedConfig: { storage_encrypted: true },
    patchContent: '  storage_encrypted = true  # was: false (required by PCI-DSS, SOC2, HIPAA)',
    implementationSteps: [
      'Encryption cannot be enabled on a running instance — you must create an encrypted snapshot',
      'Restore from the encrypted snapshot to a new instance',
      filePath ? `Update ${filePath}: storage_encrypted = true` : 'Set storage_encrypted = true',
      'Run terraform plan on the new instance, then terraform apply',
    ],
  };
}

/** RDS-005: Publicly accessible RDS instance. */
export function checkRDS005(r: Resource, cfg: Cfg): Recommendation | null {
  void cfg;
  if (r.type !== 'rds_instance') return null;
  if (!boolConfig(r, 'publicly_accessible')) return null;
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'RDS-005',
    resourceId: r.id,
    resourceType: r.type,
    title: `Disable public accessibility on RDS instance ${r.name}`,
    description: `RDS instance ${r.name} has publicly_accessible = true, exposing it to the internet.`,
    reasoning: 'Publicly accessible RDS instances are exposed to brute-force and exploitation attempts. Use a bastion host or VPN for remote access.',
    impact: 'high',
    risk: 'low',
    estimatedSavings: 0,
    suggestedAction: 'disable_public_access',
    confidence: clampConfidence(0.99),
    filePath,
    currentConfig: { publicly_accessible: true },
    suggestedConfig: { publicly_accessible: false },
    patchContent: '  publicly_accessible = false  # was: true (internet-exposed database)',
    implementationSteps: [
      'Set publicly_accessible = false in the RDS console',
      'Ensure all application connections use private VPC endpoints',
      filePath ? `Update ${filePath}: publicly_accessible = false` : 'Set publicly_accessible = false',
      'Run terraform plan to verify, then terraform apply',
    ],
  };
}

/** RDS-006: gp2 → gp3 storage migration. */
export function checkRDS006(r: Resource, cfg: Cfg): Recommendation | null {
  void cfg;
  if (r.type !== 'rds_instance') return null;
  if (strConfig(r, 'storage_type') !== 'gp2') return null;
  const monthlyCost = getMonthlyCost(r);
  const savings = guardSavings(monthlyCost * cfg.rdsGP2GP3Multiplier);
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'RDS-006',
    resourceId: r.id,
    resourceType: r.type,
    title: `Migrate RDS instance ${r.name} storage from gp2 to gp3 (20% cheaper)`,
    description: `RDS instance ${r.name} uses gp2 storage. gp3 provides the same baseline IOPS at ~20% lower cost.`,
    reasoning: 'RDS gp3 storage costs $0.115/GB/mo vs gp2\'s $0.138/GB/mo. Migration can be done with no downtime via a storage modification.',
    impact: 'medium',
    risk: 'low',
    estimatedSavings: guardSavings(savings),
    suggestedAction: 'migrate_storage_to_gp3',
    confidence: clampConfidence(0.95),
    filePath,
    currentConfig: { storage_type: 'gp2' },
    suggestedConfig: { storage_type: 'gp3' },
    patchContent: '  storage_type = "gp3"  # was: gp2 (20% cheaper, same baseline IOPS)',
    implementationSteps: [
      'Modify the RDS instance storage type to gp3 (no downtime required)',
      filePath ? `Update ${filePath}: storage_type = "gp3"` : 'Set storage_type = "gp3"',
      'Run terraform plan to verify, then terraform apply',
    ],
  };
}

/** RDS-007: Multi-AZ enabled in non-production environment. */
export function checkRDS007(r: Resource, cfg: Cfg): Recommendation | null {
  void cfg;
  if (r.type !== 'rds_instance') return null;
  if (!boolConfig(r, 'multi_az')) return null;
  const env = (r.tags?.['Environment'] ?? '').toLowerCase();
  const nonProdEnvs = new Set(['dev', 'development', 'staging', 'test']);
  if (!nonProdEnvs.has(env)) return null;
  const monthlyCost = getMonthlyCost(r);
  const savings = guardSavings(monthlyCost * cfg.rdsMultiAZMultiplier);
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'RDS-007',
    resourceId: r.id,
    resourceType: r.type,
    title: `Disable Multi-AZ on non-production RDS instance ${r.name} (${env})`,
    description: `RDS instance ${r.name} has Multi-AZ enabled in a ${env} environment. Non-production databases rarely need automatic failover.`,
    reasoning: 'Multi-AZ creates a synchronous standby replica in a second AZ, doubling the instance cost. For dev/staging environments this is typically unnecessary.',
    impact: 'high',
    risk: 'low',
    estimatedSavings: guardSavings(savings),
    suggestedAction: 'disable_multi_az_non_prod',
    confidence: clampConfidence(0.85),
    filePath,
    currentConfig: { multi_az: true, environment: env },
    suggestedConfig: { multi_az: false },
    patchContent: '  multi_az = false  # was: true (not needed for non-production)',
    implementationSteps: [
      'Disable Multi-AZ via the RDS console (requires a brief reboot)',
      filePath ? `Update ${filePath}: multi_az = false` : 'Set multi_az = false',
      'Run terraform plan to verify, then terraform apply',
    ],
  };
}

/**
 * Builds a Graviton equivalent RDS instance class string.
 * Maps db.<x86-family>.<size> → db.<graviton-family>.<size>.
 * Returns null if no clean mapping exists.
 */
function buildRDSGravitonType(instanceClass: string): string | null {
  if (!instanceClass.startsWith('db.')) return null;
  const withoutPrefix = instanceClass.slice(3); // e.g. "m5.large"
  const dotIdx = withoutPrefix.indexOf('.');
  if (dotIdx === -1) return null;
  const family = withoutPrefix.slice(0, dotIdx); // e.g. "m5"
  const size = withoutPrefix.slice(dotIdx + 1); // e.g. "large"

  const rdsGravitonFamilies: Record<string, string> = {
    // x86 → Graviton (April 2026)
    m5: 'm7g', m6i: 'm7g', m7i: 'm8g',
    r5: 'r7g', r6i: 'r7g', r7i: 'r8g',
    c5: 'c7g', c6i: 'c7g', c7i: 'c8g',
    t3: 't4g',
    // AMD → Graviton
    m6a: 'm7g', r6a: 'r7g',
  };

  const gravitonFamily = rdsGravitonFamilies[family];
  if (!gravitonFamily) return null;
  return `db.${gravitonFamily}.${size}`;
}

/** RDS-008: RDS instance eligible for Graviton migration. */
export function checkRDS008(r: Resource, cfg: Cfg): Recommendation | null {
  void cfg;
  if (r.type !== 'rds_instance') return null;
  const cls = r.instanceType;
  if (!cls.startsWith('db.')) return null;

  const suggestedClass = buildRDSGravitonType(cls);
  if (!suggestedClass) return null;

  const monthlyCost = getMonthlyCost(r);
  const currentMonthly = estimateRDSCostSync(cls, r.region);
  const gravitonMonthly = estimateRDSCostSync(suggestedClass, r.region);

  let savings: number;
  let confidence: number;
  if (currentMonthly > 0 && gravitonMonthly > 0) {
    savings = Math.max(0, currentMonthly - gravitonMonthly);
    confidence = 0.80;
  } else {
    savings = monthlyCost * cfg.rdsGravitonMultiplier;
    confidence = 0.65;
  }
  savings = guardSavings(savings);
  confidence = clampConfidence(confidence);

  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'RDS-008',
    resourceId: r.id,
    resourceType: r.type,
    title: `Migrate RDS instance ${r.name} from ${cls} to Graviton (${suggestedClass}, ~15% cheaper)`,
    description: `RDS instance ${r.name} uses ${cls}. Graviton equivalent ${suggestedClass} is 10-20% cheaper with comparable performance.`,
    reasoning: `AWS Graviton RDS instances offer better price/performance. ${cls} → ${suggestedClass} saves ~15%/mo.`,
    impact: 'medium',
    risk: 'low',
    estimatedSavings: guardSavings(savings),
    suggestedAction: `migrate_to_graviton_${suggestedClass}`,
    confidence: clampConfidence(confidence),
    filePath,
    currentConfig: { instance_class: cls },
    suggestedConfig: { instance_class: suggestedClass },
    patchContent: `  instance_class = "${sanitizeResourceName(suggestedClass)}"  # was: ${sanitizeResourceName(cls)} (Graviton, ~15% cheaper)`,
    implementationSteps: [
      'Verify the RDS engine version supports the Graviton instance class (MySQL 8.0+, PostgreSQL 12+, MariaDB 10.4+)',
      `Schedule a maintenance window and change instance_class to ${sanitizeResourceName(suggestedClass)}`,
      filePath ? `Update ${filePath}: instance_class = "${sanitizeResourceName(suggestedClass)}"` : `Set instance_class = "${sanitizeResourceName(suggestedClass)}"`,
      'Run terraform plan to verify, then terraform apply',
      'Monitor latency and CPU for 48 hours post-change',
    ],
  };
}

/** RDS-009: Idle RDS by connection count. */
export function checkRDS009(r: Resource, cfg: Cfg, ctx?: RuleContext): Recommendation | null {
  if (r.type !== 'rds_instance' || !r.utilization) return null;
  if (r.utilization.cpuAverage < cfg.rdsIdleCPUThreshold) return null;
  const connections = r.utilization.connectionCount ?? 0;
  if (connections >= cfg.rdsConnectionIdleThreshold) return null;
  if (r.utilization.dataPoints <= 0) return null;
  const monthlyCost = getMonthlyCostStrict(r);
  if (monthlyCost === null) {
    ctx?.warn('RDS-009', r.id, r.type, 'monthly_cost missing or invalid');
    return null;
  }
  const filePath = strConfig(r, 'file_path');
  const savings = guardSavings(monthlyCost * cfg.rdsIdleMultiplier);

  let confidence = confidenceFromUtilization(0.90, r.utilization);
  let peakNote = '';
  // If peak connections exceeded 5 despite low average, reduce confidence
  if (r.utilization.connectionCountMax > 5) {
    confidence = Math.min(confidence, 0.60);
    peakNote = ' Peak connections detected.';
  }

  return {
    ruleId: 'RDS-009',
    resourceId: r.id,
    resourceType: r.type,
    title: `RDS instance ${r.name} has zero client connections for ${r.utilization.period}`,
    description: `RDS instance ${r.name} (${r.instanceType}) shows <${cfg.rdsConnectionIdleThreshold} average connections over ${r.utilization.period} — no active clients are using this database.${peakNote} ⚠ Terminating would eliminate ~$${savings.toFixed(0)}/mo in compute costs. Note: automated backups will also be deleted on termination.`,
    reasoning: 'Zero database connections over 7+ days strongly indicates an abandoned or forgotten database. Stopping saves compute cost (~95% of compute); deleting with a snapshot saves storage too.',
    impact: 'high',
    risk: 'medium',
    estimatedSavings: guardSavings(savings),
    suggestedAction: 'stop_or_delete',
    confidence: clampConfidence(confidence),
    filePath,
    currentConfig: { instance_class: r.instanceType, connections_average: connections },
    suggestedConfig: { action: 'stop_or_delete' },
    patchContent: `# Stop idle RDS instance ${sanitizeResourceName(r.name)}\n# aws rds stop-db-instance --db-instance-identifier ${sanitizeResourceName(r.id)}`,
    implementationSteps: [
      'Confirm with the owning team that no application connects to this database',
      'Take a final snapshot',
      'Stop the instance (preserves data, saves compute) or delete it',
      filePath ? `If deleting: remove aws_db_instance block from ${filePath}` : 'If deleting: remove the aws_db_instance block',
    ],
  };
}

/** RDS-010: Reserved Instance opportunity for stable workload. */
export function checkRDS010(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'rds_instance' || r.state !== 'available') return null;
  if (!r.utilization) return null;
  if (r.utilization.cpuAverage < cfg.rdsRICPUThreshold) return null;
  // Require at least 100 data points (~30 days at ~3-4 hour granularity) before flagging idle instances; avoids false positives from recently-launched instances.
  if (r.utilization.dataPoints < 100) return null;
  const monthlyCost = getMonthlyCost(r);
  if (monthlyCost < cfg.rdsMinCostForRI) return null;
  const savings = guardSavings(monthlyCost * cfg.rdsRIDiscountMultiplier);
  return {
    ruleId: 'RDS-010',
    resourceId: r.id,
    resourceType: r.type,
    title: `Consider Reserved Instance for stable RDS workload ${r.name} (${r.instanceType})`,
    description: `RDS instance ${r.name} (${r.instanceType}) has been running steadily with ${r.utilization.cpuAverage.toFixed(1)}% average CPU over 30 days. A 1-year Reserved Instance saves ~33% vs on-demand (${savings.toFixed(0)} USD/mo savings).`,
    reasoning: `RDS instance ${r.name} has CPU average of ${r.utilization.cpuAverage.toFixed(1)}% over 30 days — it is actively used and stable (threshold: ${cfg.rdsRICPUThreshold}% CPU, $${cfg.rdsMinCostForRI}/mo min cost). A 1-year No-Upfront Reserved Instance for ${r.instanceType} saves ~33% compared to on-demand pricing.`,
    impact: 'high',
    risk: 'low',
    estimatedSavings: guardSavings(savings),
    suggestedAction: 'purchase_rds_reserved_instance',
    confidence: clampConfidence(0.70),
    currentConfig: { pricing: 'on_demand', instance_class: r.instanceType, cpu_avg_pct: r.utilization.cpuAverage, running_days: 30 },
    suggestedConfig: { pricing: 'reserved_1yr_no_upfront' },
    patchContent: `# Purchase 1-year No-Upfront RDS Reserved Instance for ${sanitizeResourceName(r.instanceType)} ${sanitizeResourceName(r.region)}\n# Check AWS Cost Explorer > RI recommendations first to avoid duplicates`,
    implementationSteps: [
      'Open AWS Cost Explorer > Reserved Instance > Recommendations for RDS',
      'Verify this instance is not already covered by an existing RI',
      `Purchase a 1-year No-Upfront RI for ${sanitizeResourceName(r.instanceType)} in ${sanitizeResourceName(r.region)}`,
      'Alternatively, consider AWS Savings Plans for more flexibility across instance families',
      'Review monthly to ensure RI utilisation stays above 80%',
    ],
  };
}

/** RDS-011: RDS without automated backups. */
export function checkRDS011(r: Resource, cfg: Cfg): Recommendation | null {
  void cfg;
  if (r.type !== 'rds_instance') return null;
  if (!('backup_retention_period' in r.configuration)) return null;
  if (numConfig(r, 'backup_retention_period') !== 0) return null;
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'RDS-011',
    resourceId: r.id,
    resourceType: r.type,
    title: `RDS instance ${r.name} has automated backups disabled`,
    description: `RDS instance ${r.name} has backup_retention_period = 0. Automated backups are disabled, preventing point-in-time recovery.`,
    reasoning: 'Automated RDS backups enable point-in-time recovery within the retention window. Without backups, a corrupted or accidentally deleted database cannot be restored. Enabling 7-day retention is AWS-recommended minimum.',
    impact: 'high',
    risk: 'low',
    estimatedSavings: 0,
    suggestedAction: 'enable_automated_backups',
    confidence: clampConfidence(0.95),
    filePath,
    currentConfig: { backup_retention_period: 0 },
    suggestedConfig: { backup_retention_period: 7 },
    patchContent: '  backup_retention_period = 7  # was: 0 (backups disabled)',
    implementationSteps: [
      'Enable automated backups by setting backup_retention_period to at least 7 days',
      filePath ? `Update ${filePath}: backup_retention_period = 7` : 'Set backup_retention_period = 7',
      'Run terraform plan to verify, then terraform apply',
      'Consider also enabling deletion_protection = true to prevent accidental deletion',
    ],
  };
}

/**
 * Extracts vCPU count from an RDS instance class string.
 * Format: db.<family>.<size> — we extract the size suffix.
 * Fallback: 2 vCPUs (smallest practical instance).
 */
function rdsVCpuFromInstanceClass(instanceClass: string): number {
  const size = instanceClass.split('.').at(-1) ?? '';
  const vcpuMap: Record<string, number> = {
    micro: 2, small: 2, medium: 2, large: 2,
    xlarge: 4, '2xlarge': 8, '4xlarge': 16, '8xlarge': 32,
    '12xlarge': 48, '16xlarge': 64, '24xlarge': 96, '32xlarge': 128,
  };
  return vcpuMap[size] ?? 2;
}

/** RDS-012: RDS Extended Support surcharge (MySQL <8.4, PostgreSQL ≤14). Updated April 2026. */
export function checkRDS012(r: Resource, cfg: Cfg): Recommendation | null {
  void cfg;
  if (r.type !== 'rds_instance') return null;
  const engine = strConfig(r, 'engine');
  const engineVersion = strConfig(r, 'engine_version');
  if (!engine || !engineVersion) return null;

  let isExtended = false;
  let suggestedVersion = '';
  let isMySql8p0 = false;

  if (engine.includes('mysql')) {
    if (engineVersion.startsWith('5.')) {
      isExtended = true;
      suggestedVersion = '8.4';
    } else if (engineVersion.startsWith('8.0')) {
      // MySQL 8.0 reached end-of-standard-support April 2026, entered Extended Support
      isExtended = true;
      isMySql8p0 = true;
      suggestedVersion = '8.4';
    }
  } else if (engine.includes('postgres')) {
    const majorStr = engineVersion.split('.')[0] ?? '0';
    const major = parseInt(majorStr, 10);
    // PG 14: Extended Support started Nov 2025 — flag it
    // PG 15: Standard support until Oct 2027 — do NOT flag it
    if (Number.isFinite(major) && major > 0 && major <= 14) {
      isExtended = true;
      suggestedVersion = '17';
    }
  }

  if (!isExtended) return null;

  // AWS RDS Extended Support billing: per-vCPU-hour
  // Year 1: $0.12/vCPU/hr, Year 2+: $0.24/vCPU/hr
  const EXTENDED_SUPPORT_RATE_YR1 = 0.12;
  const EXTENDED_SUPPORT_RATE_YR2 = 0.24;
  const HOURS_PER_MONTH = 730;

  // Determine which year of extended support based on when it started
  const extSupportStartDates: Record<string, Date> = {
    'mysql-5': new Date('2024-10-01'), // MySQL 5.7 EOL Oct 2023, extended support started
    'mysql-8.0': new Date('2026-04-01'), // MySQL 8.0 standard support ended Apr 2026
    'postgres-9': new Date('2021-11-01'),
    'postgres-10': new Date('2022-11-01'),
    'postgres-11': new Date('2023-11-01'),
    'postgres-12': new Date('2024-11-01'),
    'postgres-13': new Date('2024-11-01'),
    'postgres-14': new Date('2025-11-01'),
  };

  let extStartDate: Date | undefined;
  if (engine.includes('mysql')) {
    extStartDate = engineVersion.startsWith('5.')
      ? extSupportStartDates['mysql-5']
      : extSupportStartDates['mysql-8.0'];
  } else if (engine.includes('postgres')) {
    const majorStr = engineVersion.split('.')[0] ?? '0';
    const major = parseInt(majorStr, 10);
    extStartDate = extSupportStartDates[`postgres-${major}`];
  }

  const now = new Date();
  const monthsInExt = extStartDate
    ? (now.getFullYear() - extStartDate.getFullYear()) * 12 + (now.getMonth() - extStartDate.getMonth())
    : 0;
  const ratePerVcpuHour = monthsInExt >= 12 ? EXTENDED_SUPPORT_RATE_YR2 : EXTENDED_SUPPORT_RATE_YR1;

  const vcpus = rdsVCpuFromInstanceClass(r.instanceType || strConfig(r, 'instance_class'));
  const savings = guardSavings(vcpus * ratePerVcpuHour * HOURS_PER_MONTH);

  // MySQL 8.0 is in Extended Support but upgrade is optional (Extended Support runs until 2032)
  const impact = isMySql8p0 ? 'low' : 'medium';

  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'RDS-012',
    resourceId: r.id,
    resourceType: r.type,
    title: `RDS instance ${r.name} on ${engine} ${engineVersion} incurs Extended Support surcharge`,
    description: `RDS instance ${r.name} (${vcpus} vCPU) runs ${engine} ${engineVersion}, which is on Extended Support. AWS charges $${ratePerVcpuHour}/vCPU/hr (year ${monthsInExt >= 12 ? '2+' : '1'}). For this instance, Extended Support costs ~$${savings.toFixed(0)}/mo. ${isMySql8p0 ? 'Extended Support covers MySQL 8.0 until 2032, so upgrading is optional.' : 'Upgrading to ' + suggestedVersion + ' eliminates this charge.'}`,
    reasoning: `AWS Extended Support charges apply to MySQL versions before 8.4 and PostgreSQL versions ≤14 (as of April 2026). This ${vcpus}-vCPU ${engine} instance pays $${ratePerVcpuHour}/vCPU/hr = ~$${savings.toFixed(0)}/mo. ${isMySql8p0 ? 'MySQL 8.0 is supported until 2032 with Extended Support, so upgrading is optional.' : 'Upgrading to a newer major version removes this surcharge.'}`,
    impact,
    risk: 'medium',
    estimatedSavings: guardSavings(savings),
    suggestedAction: `upgrade_engine_to_${suggestedVersion}`,
    confidence: clampConfidence(0.85),
    filePath,
    currentConfig: { engine, engine_version: engineVersion, vCPU: vcpus },
    suggestedConfig: { engine_version: suggestedVersion },
    patchContent: `  engine_version = "${sanitizeResourceName(suggestedVersion)}"  # was: ${sanitizeResourceName(engineVersion)} (Extended Support surcharge)`,
    implementationSteps: [
      `Test application compatibility with ${sanitizeResourceName(engine)} ${sanitizeResourceName(suggestedVersion)} in a staging environment`,
      'Schedule a maintenance window for the major version upgrade',
      `Upgrade using aws rds modify-db-instance --engine-version ${sanitizeResourceName(suggestedVersion)} --allow-major-version-upgrade`,
      filePath ? `Update ${filePath}: engine_version = "${sanitizeResourceName(suggestedVersion)}"` : `Set engine_version = "${sanitizeResourceName(suggestedVersion)}"`,
      'Run terraform plan to verify, then terraform apply',
      'Monitor application behaviour for 48 hours post-upgrade',
    ],
  };
}

/** RDS-013: RDS with low storage utilization. */
export function checkRDS013(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'rds_instance') return null;
  const allocatedGB = numConfig(r, 'allocated_storage');
  const freeGB = numConfig(r, 'free_storage_gb');
  if (allocatedGB === 0) return null;
  if (allocatedGB <= cfg.rdsMinStorageGB) return null;
  if (freeGB <= 0) return null;
  if (freeGB >= allocatedGB) return null; // stale metric: free storage cannot exceed allocated
  const freeRatio = freeGB / allocatedGB;
  if (freeRatio <= cfg.rdsFreeStorageRatio) return null;
  const usedGB = allocatedGB - freeGB;
  let suggestedGB = usedGB * cfg.rdsStorageHeadroomRatio;
  if (suggestedGB < 20) suggestedGB = 20;
  const storageType = strConfig(r, 'storage_type') || 'gp3';
  // RDS storage rates (not EBS): gp3 $0.115/GB, gp2 $0.138/GB, io1/io2 $0.125/GB
  const storageRatePerGB: Record<string, number> = {
    io1: RDS_IO1_STORAGE_PER_GB,
    io2: RDS_IO2_STORAGE_PER_GB,
    gp2: RDS_GP2_STORAGE_PER_GB,
    gp3: RDS_GP3_STORAGE_PER_GB,
  };
  const currentRate = storageRatePerGB[storageType] ?? RDS_GP3_STORAGE_PER_GB;
  const currentStorageCost = allocatedGB * currentRate;
  const gp3StorageCost = suggestedGB * RDS_GP3_STORAGE_PER_GB;
  const savings = Math.max(0, currentStorageCost - gp3StorageCost);
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'RDS-013',
    resourceId: r.id,
    resourceType: r.type,
    title: `RDS instance ${r.name} has >${(cfg.rdsFreeStorageRatio * 100).toFixed(0)}% free storage (${usedGB.toFixed(0)}/${allocatedGB.toFixed(0)} GB used)`,
    description: `RDS instance ${r.name} has ${allocatedGB.toFixed(0)} GB allocated but only ${usedGB.toFixed(0)} GB used (${(freeRatio * 100).toFixed(0)}% free). Reducing to ${suggestedGB.toFixed(0)} GB could save ~${savings.toFixed(0)} USD/mo.`,
    reasoning: `RDS ${storageType} storage costs $${currentRate}/GB/month. Current: $${currentStorageCost.toFixed(0)}/mo. At ${suggestedGB.toFixed(0)} GB on gp3 ($${RDS_GP3_STORAGE_PER_GB}/GB): $${gp3StorageCost.toFixed(0)}/mo. Savings: ~$${savings.toFixed(0)}/mo.`,
    impact: 'medium',
    risk: 'low',
    estimatedSavings: guardSavings(savings),
    suggestedAction: 'reduce_allocated_storage',
    confidence: clampConfidence(0.8),
    filePath,
    currentConfig: { allocated_storage_gb: allocatedGB, free_storage_gb: freeGB },
    suggestedConfig: { allocated_storage_gb: suggestedGB },
    patchContent: `  allocated_storage = ${suggestedGB.toFixed(0)}  # was: ${allocatedGB.toFixed(0)} GB (${(freeRatio * 100).toFixed(0)}% free)`,
    implementationSteps: [
      'Note: RDS does not support storage reduction — this requires migration to a new instance',
      'Create a new RDS instance with reduced allocated_storage and restore from a snapshot',
      filePath ? `Update ${filePath}: allocated_storage = ${suggestedGB.toFixed(0)}` : `Set allocated_storage = ${suggestedGB.toFixed(0)}`,
      'Run terraform plan to verify, then terraform apply',
      'Decommission the old instance after verifying the new one',
    ],
  };
}

/** RDS-014: Proactive EOL warning — engine version entering Extended Support within 180 days. */
export function checkRDS014(r: Resource, _cfg: Cfg): Recommendation | null {
  if (r.type !== 'rds_instance') return null;
  const engine = strConfig(r, 'engine');
  const engineVersion = strConfig(r, 'engine_version');
  if (!engine || !engineVersion) return null;

  // EOL dates: when standard support ends and Extended Support billing begins
  const RDS_EOL_DATES: Record<string, Date> = {
    'postgres-15': new Date('2027-10-01'),
    'postgres-16': new Date('2029-11-01'),
    'mysql-8.4': new Date('2032-04-01'),
  };
  const EXTENDED_SUPPORT_WARN_DAYS = 180;

  const now = new Date();
  let eolDate: Date | undefined;

  if (engine.includes('postgres')) {
    const major = parseInt(engineVersion.split('.')[0] ?? '0', 10);
    eolDate = RDS_EOL_DATES[`postgres-${major}`];
  } else if (engine.includes('mysql')) {
    if (engineVersion.startsWith('8.4')) eolDate = RDS_EOL_DATES['mysql-8.4'];
  }

  if (!eolDate) return null;
  const daysUntilEol = Math.floor((eolDate.getTime() - now.getTime()) / 86_400_000);
  if (daysUntilEol > EXTENDED_SUPPORT_WARN_DAYS || daysUntilEol <= 0) return null;

  const vcpus = rdsVCpuFromInstanceClass(r.instanceType || strConfig(r, 'instance_class'));
  const monthlySurcharge = guardSavings(vcpus * 0.12 * 730); // $0.12/vCPU/hr year 1, 730 hrs/mo
  const filePath = strConfig(r, 'file_path');
  const eolDateStr = eolDate.toISOString().slice(0, 10);

  return {
    ruleId: 'RDS-014',
    resourceId: r.id,
    resourceType: r.type,
    title: `RDS instance ${r.name} (${engine} ${engineVersion}) enters Extended Support in ${daysUntilEol} days`,
    description: `${engine} ${engineVersion} standard support ends on ${eolDateStr}. After that date, AWS charges Extended Support fees (~$${monthlySurcharge.toFixed(0)}/mo for ${vcpus} vCPUs at $0.12/vCPU/hr, year 1 rate). Upgrade before ${eolDateStr} to avoid the surcharge.`,
    reasoning: `Extended Support adds $0.12/vCPU/hr (year 1) or $0.24/vCPU/hr (year 2+) on top of your existing instance cost. With ${vcpus} vCPUs and 730 hours/month, that is ~$${monthlySurcharge.toFixed(0)}/mo additional. Upgrading before the EOL date avoids this entirely.`,
    impact: 'medium',
    risk: 'medium',
    estimatedSavings: guardSavings(monthlySurcharge),
    suggestedAction: 'upgrade_before_extended_support',
    confidence: clampConfidence(0.9),
    filePath,
    currentConfig: { engine, engine_version: engineVersion, days_until_eol: daysUntilEol },
    suggestedConfig: { engine_version: 'latest' },
    patchContent: `# Upgrade ${engine} ${engineVersion} before ${eolDateStr} to avoid Extended Support charges`,
    implementationSteps: [
      `Test application compatibility with the latest ${engine} version in staging`,
      'Schedule upgrade during a maintenance window',
      filePath ? `Update ${filePath}: engine_version = "latest"` : 'Update engine_version in Terraform',
      'Run terraform plan to verify, then terraform apply',
    ],
  };
}

export const rdsRules = [
  checkRDS001,
  checkRDS002,
  checkRDS003,
  checkRDS004,
  checkRDS005,
  checkRDS006,
  checkRDS007,
  checkRDS008,
  checkRDS009,
  checkRDS010,
  checkRDS011,
  checkRDS012,
  checkRDS013,
  checkRDS014,
];
