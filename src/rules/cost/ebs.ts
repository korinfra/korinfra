/**
 * EBS and snapshot cost optimization rules.
 * Ported from Go internal/ai/rules.go (EBS-001 through EBS-007, SNAP-001, SNAP-002).
 */

import type { Resource } from '../../aws/types.js';
import type { Recommendation, RuleContext } from '../types.js';
import type { ThresholdsOverride } from '../config.js';
import type { THRESHOLDS } from '../config.js';
import { daysSince, strConfig, boolConfig, numConfig, sanitizeResourceName, getMonthlyCost, getMonthlyCostStrict, confidenceFromUtilization } from './helpers.js';
import { clampConfidence, guardSavings } from '../../utils/numeric-guards.js';
import { asStr } from '../../utils/coerce.js';
import { EBS_GP3_PER_GB, EBS_GP3_IOPS_PRICE, EBS_IO1_PER_GB, EBS_IO1_IOPS_PRICE, EBS_SNAPSHOT_PER_GB } from '../../pricing/resources.js';

type Cfg = typeof THRESHOLDS & ThresholdsOverride;

/** EBS-001: Unattached volume (state=available). */
export function checkEBS001(r: Resource, cfg: Cfg, ctx?: RuleContext): Recommendation | null {
  void cfg;
  if (r.type !== 'ebs_volume' || r.state !== 'available') return null;
  const monthlyCost = getMonthlyCostStrict(r);
  if (monthlyCost === null) {
    ctx?.warn('EBS-001', r.id, r.type, 'monthly_cost missing or invalid');
    return null;
  }
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'EBS-001',
    resourceId: r.id,
    resourceType: r.type,
    title: `Delete unattached EBS volume ${r.name}`,
    description: `EBS volume ${r.name} is not attached to any instance and is accruing charges (${monthlyCost.toFixed(2)} USD/mo).`,
    reasoning: 'Unattached EBS volumes cost the same as attached volumes. There is no benefit to keeping them unless they store critical data.',
    impact: 'high',
    risk: 'low',
    estimatedSavings: guardSavings(monthlyCost),
    suggestedAction: 'delete_volume',
    confidence: clampConfidence(0.98),
    filePath,
    currentConfig: { state: 'available', volume_type: strConfig(r, 'volume_type') },
    suggestedConfig: { action: 'delete' },
    patchContent: `# Delete unattached EBS volume ${sanitizeResourceName(r.name)}\n# aws ec2 delete-volume --volume-id ${sanitizeResourceName(r.id)}`,
    implementationSteps: [
      'Verify with the owning team that no data needs to be preserved',
      'Create a snapshot as a last-resort backup',
      'Delete the volume',
      filePath ? `Remove the aws_ebs_volume resource block from ${filePath}` : 'Remove the Terraform aws_ebs_volume resource block',
    ],
  };
}

/** EBS-002: Old snapshots > 90 days. */
export function checkEBS002(r: Resource, cfg: Cfg, ctx?: RuleContext): Recommendation | null {
  if (r.type !== 'ebs_snapshot') return null;
  const age = daysSince(r.launchTime);
  if (age === null || age <= cfg.snapshotRetentionDays) return null;
  const monthlyCost = getMonthlyCostStrict(r);
  if (monthlyCost === null) {
    ctx?.warn('EBS-002', r.id, r.type, 'monthly_cost missing or invalid');
    return null;
  }
  return {
    ruleId: 'EBS-002',
    resourceId: r.id,
    resourceType: r.type,
    title: `Review old EBS snapshot ${r.name} (${age} days old)`,
    description: `Snapshot ${r.name} is ${age} days old. Old snapshots cost ~$${EBS_SNAPSHOT_PER_GB}/GB/month.`,
    reasoning: `EBS snapshots older than ${cfg.snapshotRetentionDays} days are unlikely to be needed for point-in-time recovery. Review and delete if obsolete.`,
    impact: 'low',
    risk: 'low',
    estimatedSavings: guardSavings(monthlyCost),
    suggestedAction: 'review_and_delete',
    confidence: clampConfidence(0.6),
    currentConfig: { age_days: age },
    suggestedConfig: { action: 'review_and_delete' },
    patchContent: `# Delete old snapshot ${sanitizeResourceName(r.name)} (>90 days)\n# aws ec2 delete-snapshot --snapshot-id ${sanitizeResourceName(r.id)}`,
    implementationSteps: [
      'Confirm the snapshot is not referenced by an AMI or restore plan',
      'Delete the snapshot if no longer needed',
    ],
  };
}

/** EBS-003: gp2 → gp3 migration (20% savings). */
export function checkEBS003(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'ebs_volume') return null;
  if (strConfig(r, 'volume_type') !== 'gp2') return null;
  const monthlyCost = getMonthlyCost(r);
  const savings = monthlyCost * cfg.ebsGP2ToGP3SavingsRatio;
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'EBS-003',
    resourceId: r.id,
    resourceType: r.type,
    title: `Migrate EBS volume ${r.name} from gp2 to gp3 (20% cheaper)`,
    description: `Volume ${r.name} uses gp2. gp3 is 20% cheaper with the same baseline performance.`,
    reasoning: 'gp3 volumes provide 3,000 IOPS and 125 MB/s baseline at $0.08/GB vs gp2\'s $0.10/GB. Migration has zero downtime.',
    impact: 'medium',
    risk: 'low',
    estimatedSavings: guardSavings(savings),
    suggestedAction: 'migrate_to_gp3',
    confidence: clampConfidence(0.95),
    filePath,
    currentConfig: { volume_type: 'gp2' },
    suggestedConfig: { volume_type: 'gp3' },
    patchContent: '  volume_type = "gp3"  # was: gp2 (20% cheaper, same baseline performance)',
    implementationSteps: [
      'Modify the EBS volume type from gp2 to gp3 (no downtime required)',
      filePath ? `Update ${filePath}: volume_type = "gp3"` : 'Set volume_type = "gp3"',
      'Run terraform plan to verify, then terraform apply',
    ],
  };
}

/** EBS-004: Unencrypted EBS volume. */
export function checkEBS004(r: Resource, cfg: Cfg): Recommendation | null {
  void cfg;
  if (r.type !== 'ebs_volume') return null;
  if (boolConfig(r, 'encrypted')) return null;
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'EBS-004',
    resourceId: r.id,
    resourceType: r.type,
    title: `Enable encryption on EBS volume ${r.name}`,
    description: `EBS volume ${r.name} is not encrypted. Encryption protects data at rest at no additional cost.`,
    reasoning: 'AWS EBS encryption is available at no additional charge since 2017. Unencrypted volumes are a compliance risk.',
    impact: 'high',
    risk: 'medium',
    estimatedSavings: 0,
    suggestedAction: 'enable_encryption',
    confidence: clampConfidence(0.99),
    filePath,
    currentConfig: { encrypted: false },
    suggestedConfig: { encrypted: true },
    patchContent: '  encrypted = true  # was: false (encryption is free; required by most compliance frameworks)',
    implementationSteps: [
      'Create an encrypted snapshot from the current volume',
      'Create a new encrypted volume from the snapshot',
      'Detach the old volume and attach the new one',
      filePath ? `Update ${filePath}: encrypted = true` : 'Set encrypted = true',
      'Run terraform plan to verify, then terraform apply',
    ],
  };
}

/** EBS-005: io1/io2 → gp3 migration. Only recommend when IOPS <= 3000 (gp3 baseline). */
export function checkEBS005(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'ebs_volume') return null;
  const volumeType = strConfig(r, 'volume_type');
  if (volumeType !== 'io1' && volumeType !== 'io2') return null;
  const iops = numConfig(r, 'iops');
  if (iops > cfg.gp3IOPSBaseline) return null; // Only fire if IOPS <= 3000; above that, EBS-006 handles it

  // Pricing constants from pricing module (us-east-1 baseline)
  // GP3_IOPS_OVERAGE = EBS_GP3_IOPS_PRICE, GP3_GB = EBS_GP3_PER_GB

  const sizeGb = (r.configuration['size_gb'] as number | undefined) ?? 0;
  const reportedMonthlyCost = getMonthlyCost(r);

  let savings: number;
  let currentMonthlyCost: number;
  if (reportedMonthlyCost > 0) {
    // When actual monthly cost is available from AWS, estimate savings for io1/io2 → gp3 migration.
    // Precise calculation shows 80-90% savings for IOPS <= 3000.
    currentMonthlyCost = reportedMonthlyCost;
    savings = reportedMonthlyCost * cfg.ebsIO1ToGP3Multiplier;
  } else {
    // Fall back to pricing calculation when cost data unavailable
    currentMonthlyCost = iops * EBS_IO1_IOPS_PRICE + sizeGb * EBS_IO1_PER_GB;
    const gp3IopsCost = Math.max(0, iops - cfg.gp3IOPSBaseline) * EBS_GP3_IOPS_PRICE;
    const gp3MonthlyCost = gp3IopsCost + sizeGb * EBS_GP3_PER_GB;
    savings = Math.max(0, currentMonthlyCost - gp3MonthlyCost);
  }

  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'EBS-005',
    resourceId: r.id,
    resourceType: r.type,
    title: `Downgrade EBS volume ${r.name} from ${volumeType} to gp3 (IOPS ${iops} <= 3000 baseline)`,
    description: `EBS volume ${r.name} uses ${volumeType} with ${iops} IOPS. gp3 covers up to 3000 IOPS baseline at lower cost. ⚠ Verify IOPS requirements before migrating.`,
    reasoning: `io1/io2 charges $${EBS_IO1_IOPS_PRICE}/provisioned IOPS/mo + $${EBS_IO1_PER_GB}/GB/mo. gp3 charges $${EBS_GP3_PER_GB}/GB/mo with 3000 IOPS baseline included. For ${iops} IOPS <= 3000, gp3 saves ~${(savings > 0 ? (savings / currentMonthlyCost * 100).toFixed(0) : '60')}%.`,
    impact: 'high',
    risk: 'medium',
    estimatedSavings: guardSavings(savings),
    suggestedAction: 'migrate_to_gp3',
    confidence: clampConfidence(0.85),
    filePath,
    currentConfig: { volume_type: volumeType, iops, size_gb: sizeGb },
    suggestedConfig: { volume_type: 'gp3', iops: cfg.gp3IOPSBaseline },
    patchContent: `  volume_type = "gp3"  # was: ${volumeType} (cheaper for IOPS <= 3000)`,
    implementationSteps: [
      `Modify the EBS volume type from ${volumeType} to gp3 (no downtime required)`,
      `gp3 provides 3,000 IOPS baseline at $0.08/GB — no extra cost for your IOPS level`,
      filePath ? `Update ${filePath}: volume_type = "gp3"` : 'Set volume_type = "gp3"',
      'Run terraform plan to verify, then terraform apply',
      'Monitor IOPS and throughput after the change to confirm performance is acceptable',
    ],
  };
}

/**
 * EBS-006: io1/io2 volume with over-provisioned IOPS (>3000).
 *
 * Triggers when an io1/io2 volume has IOPS > 3000. If CloudWatch P95 actual IOPS data is
 * available and shows utilization < 50% of provisioned, recommends reducing IOPS to
 * P95 * 1.2 (20% headroom). Without CW data, emits a low-confidence review hint.
 *
 * Threshold rationale: io1/io2 charge $0.065/provisioned-IOPS/month, so a 50% over-provision
 * on a 10,000-IOPS volume wastes ~$325/month. The 50% utilization gate avoids flagging
 * volumes whose burst usage (P95) is close to provisioned. The 20% headroom matches the
 * standard SRE guidance for steady-state reservation above observed P95.
 *
 * False-positive analysis: spiky workloads where average is low but max is near provisioned
 * are protected by using P95 (not average). Volumes without CW data only get a low-confidence
 * "review" recommendation (confidence 0.6) — never an auto-applied resize.
 *
 * Example: io1 volume with 10,000 IOPS provisioned, P95 actual = 2,000 IOPS → recommend
 * reducing to 2,400 IOPS (2,000 * 1.2), saving (10,000 - 2,400) * $0.065 = $494/month.
 */
function checkEBS006(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'ebs_volume') return null;
  const volumeType = strConfig(r, 'volume_type');
  if (volumeType !== 'io1' && volumeType !== 'io2') return null;
  const provisionedIops = numConfig(r, 'iops');
  if (provisionedIops <= cfg.gp3IOPSBaseline) return null; // EBS-005 handles <= 3000

  const sizeGb = (r.configuration['size_gb'] as number | undefined) ?? 0;
  const filePath = strConfig(r, 'file_path');

  // Prefer P95 actual IOPS from CloudWatch when available.
  const actualIOPS = r.utilization
    ? r.utilization.diskReadIOPS + r.utilization.diskWriteIOPS
    : 0;
  const hasCloudWatchData = r.utilization !== undefined && actualIOPS >= 0;

  if (hasCloudWatchData && actualIOPS < provisionedIops * cfg.ebsIO1HighIOPSUtilThreshold) {
    // Strong signal: actual P95 < 50% of provisioned. Recommend specific IOPS target.
    const recommendedIops = Math.max(
      cfg.gp3IOPSBaseline,
      Math.ceil(actualIOPS * cfg.ebsIO1HighIOPSHeadroom),
    );
    const iopsToTrim = Math.max(0, provisionedIops - recommendedIops);
    const savings = iopsToTrim * EBS_IO1_IOPS_PRICE;
    return {
      ruleId: 'EBS-006',
      resourceId: r.id,
      resourceType: r.type,
      title: `Reduce provisioned IOPS on ${volumeType} volume ${r.name} from ${provisionedIops} to ${recommendedIops}`,
      description: `EBS volume ${r.name} (${volumeType}) has ${provisionedIops} provisioned IOPS but P95 actual is only ${actualIOPS.toFixed(0)} IOPS. Reducing to ${recommendedIops} (P95 + 20% headroom) saves ~${savings.toFixed(0)} USD/mo.`,
      reasoning: `io1/io2 charge $${EBS_IO1_IOPS_PRICE}/provisioned IOPS/month. With P95 actual of ${actualIOPS.toFixed(0)} IOPS (${((actualIOPS / provisionedIops) * 100).toFixed(0)}% utilization), the ${iopsToTrim} excess IOPS above the recommended ${recommendedIops} target are wasted. Modify-volume operations on io1/io2 are online and non-disruptive.`,
      impact: 'medium',
      risk: 'low',
      estimatedSavings: guardSavings(savings),
      suggestedAction: 'reduce_provisioned_iops',
      confidence: clampConfidence(0.8),
      filePath,
      currentConfig: { volume_type: volumeType, iops: provisionedIops, actual_iops_p95: actualIOPS, size_gb: sizeGb },
      suggestedConfig: { iops: recommendedIops },
      patchContent: `  iops = ${recommendedIops}  # was: ${sanitizeResourceName(String(provisionedIops))} (P95 actual ${actualIOPS.toFixed(0)} IOPS + 20% headroom)`,
      implementationSteps: [
        `Reduce provisioned IOPS from ${provisionedIops} to ${recommendedIops} via the EBS console (online, no downtime)`,
        filePath ? `Update ${filePath}: iops = ${recommendedIops}` : `Set iops = ${recommendedIops}`,
        'Run terraform plan to verify, then terraform apply',
        'Monitor IOPS for 7+ days after the change to confirm headroom is sufficient',
      ],
    };
  }

  // No CW data — emit low-confidence review hint only.
  return {
    ruleId: 'EBS-006',
    resourceId: r.id,
    resourceType: r.type,
    title: `Review IOPS on ${volumeType} volume ${r.name} (${provisionedIops} provisioned)`,
    description: `EBS volume ${r.name} (${volumeType}) has ${provisionedIops} provisioned IOPS at $${EBS_IO1_IOPS_PRICE}/IOPS/month. Verify actual IOPS usage in CloudWatch and reduce if over-provisioned.`,
    reasoning: `io1/io2 with >3000 IOPS cost $${EBS_IO1_IOPS_PRICE}/provisioned IOPS/month. CloudWatch utilization data is unavailable; manually verify whether the workload actually uses the full ${provisionedIops} IOPS before reducing.`,
    impact: 'medium',
    risk: 'low',
    estimatedSavings: 0,
    suggestedAction: 'review_provisioned_iops',
    confidence: clampConfidence(0.6),
    filePath,
    currentConfig: { volume_type: volumeType, iops: provisionedIops, size_gb: sizeGb },
    suggestedConfig: { action: 'review_in_cloudwatch' },
    patchContent: `# Review CloudWatch VolumeReadOps + VolumeWriteOps for ${sanitizeResourceName(r.id)} before reducing iops`,
    implementationSteps: [
      `Inspect CloudWatch VolumeReadOps + VolumeWriteOps P95 for volume ${sanitizeResourceName(r.id)} over the last 14 days`,
      'If P95 actual IOPS < 50% of provisioned, reduce iops to P95 + 20% headroom',
      filePath ? `Update ${filePath}: iops = <new value>` : 'Set iops = <new value>',
      'Run terraform plan to verify, then terraform apply',
    ],
  };
}

/** EBS-007: gp3 volume with very low IOPS utilization (excess provisioned IOPS). */
export function checkEBS007(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'ebs_volume') return null;
  if (strConfig(r, 'volume_type') !== 'gp3') return null;
  if (!r.utilization) return null;
  const actualIOPS = r.utilization.diskReadIOPS + r.utilization.diskWriteIOPS;
  if (actualIOPS >= cfg.ebsLowActualIOPS) return null;
  const provisionedIOPS = numConfig(r, 'iops');
  if (provisionedIOPS <= 3000) return null;
  const excessIOPS = provisionedIOPS - 3000;
  const savings = excessIOPS * EBS_GP3_IOPS_PRICE;
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'EBS-007',
    resourceId: r.id,
    resourceType: r.type,
    title: `EBS gp3 volume ${r.name} has ${provisionedIOPS} provisioned IOPS but <100 actual IOPS/s`,
    description: `EBS volume ${r.name} (gp3) has ${provisionedIOPS} IOPS provisioned but actual usage is only ${actualIOPS.toFixed(0)} IOPS. Reducing to the 3000 baseline saves ~${savings.toFixed(0)} USD/mo.`,
    reasoning: `gp3 charges $${EBS_GP3_IOPS_PRICE}/IOPS/month for IOPS above the 3000 baseline. With ${actualIOPS.toFixed(0)} actual IOPS, the ${excessIOPS.toFixed(0)} provisioned IOPS above baseline are wasted.`,
    impact: 'medium',
    risk: 'low',
    estimatedSavings: guardSavings(savings),
    suggestedAction: 'reduce_provisioned_iops_to_3000',
    confidence: clampConfidence(confidenceFromUtilization(0.85, r.utilization)),
    filePath,
    currentConfig: { volume_type: 'gp3', iops: provisionedIOPS, actual_iops_avg: actualIOPS },
    suggestedConfig: { iops: 3000 },
    patchContent: `  iops = 3000  # was: ${sanitizeResourceName(String(provisionedIOPS))} (actual usage ${actualIOPS.toFixed(0)} IOPS)`,
    implementationSteps: [
      `Reduce provisioned IOPS from ${provisionedIOPS} to 3000 via the EBS console (no downtime required)`,
      filePath ? `Update ${filePath}: iops = 3000` : 'Set iops = 3000',
      'Run terraform plan to verify, then terraform apply',
      'Monitor IOPS after the change to confirm 3000 baseline is sufficient',
    ],
  };
}

/** SNAP-001: Orphaned snapshot (source volume deleted or unknown). */
export function checkSNAP001(r: Resource, cfg: Cfg): Recommendation | null {
  void cfg;
  if (r.type !== 'ebs_snapshot') return null;
  if (r.state !== 'available') return null;
  const volumeID = r.configuration?.['volume_id'];
  if (volumeID === undefined || volumeID === '' || volumeID === null) return null; // insufficient data
  const sizeGB = numConfig(r, 'volume_size') || numConfig(r, 'size_gb');
  const monthlyCost = getMonthlyCost(r);
  const savings = monthlyCost > 0 ? monthlyCost : sizeGB > 0 ? sizeGB * EBS_SNAPSHOT_PER_GB : 0;

  const volumeIDStr = asStr(volumeID);
  return {
    ruleId: 'SNAP-001',
    resourceId: r.id,
    resourceType: r.type,
    title: `Review EBS snapshot ${r.name} — verify source volume exists`,
    description: `EBS snapshot ${r.name} (source volume ${volumeIDStr}) costs ~$${EBS_SNAPSHOT_PER_GB}/GiB/month. If the source volume has been deleted, this snapshot serves no recovery purpose.`,
    reasoning: 'Snapshots whose source EBS volume has been deleted are orphans and should be reviewed for deletion. Verify the source volume still exists before removing the snapshot. Cross-resource context is unavailable at this pass — manual verification is required.',
    impact: 'low',
    risk: 'low',
    estimatedSavings: guardSavings(savings),
    suggestedAction: 'delete_orphaned_snapshot',
    confidence: clampConfidence(0.4),
    currentConfig: { volume_id: volumeIDStr, size_gb: sizeGB },
    suggestedConfig: { action: 'delete' },
    patchContent: `# Delete snapshot ${sanitizeResourceName(r.name)} after confirming source volume ${sanitizeResourceName(volumeIDStr)} no longer exists\n# aws ec2 delete-snapshot --snapshot-id ${sanitizeResourceName(r.id)}`,
    implementationSteps: [
      `Confirm source volume ${sanitizeResourceName(volumeIDStr)} no longer exists: aws ec2 describe-volumes --volume-ids ${sanitizeResourceName(volumeIDStr)}`,
      'Verify the snapshot is not referenced by an AMI or a restore plan',
      'Delete the snapshot via the AWS Console or CLI',
      `# aws ec2 delete-snapshot --snapshot-id ${sanitizeResourceName(r.id)}`,
    ],
  };
}

/** SNAP-002: EBS snapshot older than 1 year. */
export function checkSNAP002(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'ebs_snapshot') return null;
  if (!r.launchTime) return null;
  const age = daysSince(r.launchTime);
  if (age === null || age <= cfg.snapshotMaxAgeDays) return null;
  const sizeGB = numConfig(r, 'volume_size') || numConfig(r, 'size_gb');
  const monthlyCost = getMonthlyCost(r);
  const savings = monthlyCost > 0 ? monthlyCost : sizeGB > 0 ? sizeGB * EBS_SNAPSHOT_PER_GB : 0;
  return {
    ruleId: 'SNAP-002',
    resourceId: r.id,
    resourceType: r.type,
    title: `EBS snapshot ${r.name} is over ${cfg.snapshotMaxAgeDays} days old (${age} days)`,
    description: `EBS snapshot ${r.name} was created ${age} days ago. Snapshots older than ${cfg.snapshotMaxAgeDays} days are very unlikely to be needed for recovery. Review and delete to save ~${savings.toFixed(2)} USD/mo.`,
    reasoning: `Most disaster recovery policies require point-in-time recovery within 30-90 days. A snapshot that is ${age} days old (threshold: ${cfg.snapshotMaxAgeDays} days) is well outside any reasonable recovery window and is unlikely to provide recovery value.`,
    impact: 'medium',
    risk: 'low',
    estimatedSavings: guardSavings(savings),
    suggestedAction: 'delete_old_snapshot',
    confidence: clampConfidence(0.8),
    currentConfig: { age_days: age, size_gb: sizeGB },
    suggestedConfig: { action: 'delete' },
    patchContent: `# Delete snapshot ${sanitizeResourceName(r.name)} (${age} days old)\n# aws ec2 delete-snapshot --snapshot-id ${sanitizeResourceName(r.id)}`,
    implementationSteps: [
      'Verify the snapshot is not registered as an AMI or referenced by a restore plan',
      'Confirm the source volume and its current data are still accessible',
      `Delete the snapshot: aws ec2 delete-snapshot --snapshot-id ${sanitizeResourceName(r.id)}`,
      'Consider implementing a snapshot lifecycle policy to automate future cleanup',
    ],
  };
}

export const ebsRules = [
  checkEBS001,
  checkEBS002,
  checkEBS003,
  checkEBS004,
  checkEBS005,
  checkEBS006,
  checkEBS007,
  checkSNAP001,
  checkSNAP002,
];
