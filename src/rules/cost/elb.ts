/**
 * ELB cost optimization rules.
 * Ported from Go internal/ai/rules.go (ELB-001, ELB-002, ELB-003, LB-002, LB-003).
 */

import type { Resource } from '../../aws/types.js';
import type { Recommendation, RuleContext } from '../types.js';
import type { ThresholdsOverride } from '../config.js';
import type { THRESHOLDS } from '../config.js';
import { strConfig, boolConfig, numConfig, daysSince, sanitizeResourceName, normalizeToMonth, getMonthlyCost, getMonthlyCostStrict, confidenceFromUtilization } from './helpers.js';
import { clampConfidence, guardSavings } from '../../utils/numeric-guards.js';
import { HOURS_PER_MONTH, ALB_BASE_HOURLY } from '../../pricing/resources.js';

type Cfg = typeof THRESHOLDS & ThresholdsOverride;

/** ELB-001: Load balancer with 0 healthy targets. */
export function checkELB001(r: Resource, cfg: Cfg, ctx?: RuleContext): Recommendation | null {
  if (r.type !== 'load_balancer' && r.type !== 'alb' && r.type !== 'nlb' && r.type !== 'elb') return null;
  if (!('healthy_target_count' in r.configuration)) return null;
  const healthyTargets = numConfig(r, 'healthy_target_count');
  if (healthyTargets > 0) return null;
  const ageDays = daysSince(r.launchTime);
  if (ageDays === null || ageDays < cfg.elbIdleDays) return null;
  const monthlyCost = getMonthlyCostStrict(r);
  if (monthlyCost === null) {
    ctx?.warn('ELB-001', r.id, r.type, 'monthly_cost missing or invalid');
    return null;
  }
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'ELB-001',
    resourceId: r.id,
    resourceType: r.type,
    title: `Load balancer ${r.name} has 0 healthy targets (idle)`,
    description: `Load balancer ${r.name} has had 0 healthy registered targets for more than ${cfg.elbIdleDays} days. It is accruing hourly charges with no traffic.`,
    reasoning: `Load balancers charge ~$${ALB_BASE_HOURLY}/hr (~$${(ALB_BASE_HOURLY * HOURS_PER_MONTH).toFixed(0)}/mo) regardless of traffic. A load balancer with no healthy targets serves no purpose and should be deleted.`,
    impact: 'medium',
    risk: 'low',
    estimatedSavings: guardSavings(monthlyCost),
    suggestedAction: 'delete',
    confidence: clampConfidence(0.9),
    filePath,
    currentConfig: { healthy_target_count: 0, type: r.type },
    suggestedConfig: { action: 'delete' },
    patchContent: `# Delete idle load balancer ${sanitizeResourceName(r.name)}\n# aws elbv2 delete-load-balancer --load-balancer-arn ${sanitizeResourceName(r.arn)}`,
    implementationSteps: [
      'Verify no targets are expected (check deployment status)',
      'Delete associated listeners, target groups, and security group rules',
      filePath ? `Remove the aws_lb (or aws_alb) resource from ${filePath}` : 'Remove the aws_lb (or aws_alb) resource from Terraform',
      'Run terraform plan to verify, then terraform apply',
    ],
  };
}

/** LB-002: Idle load balancer with no healthy targets or negligible traffic. */
export function checkLB002(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'load_balancer' && r.type !== 'alb' && r.type !== 'nlb') return null;
  // ELB-001 handles the zero-healthy-targets case; skip here to avoid duplicate recommendations.
  if ('healthy_target_count' in r.configuration && numConfig(r, 'healthy_target_count') === 0) return null;
  let idle = false;
  if (r.utilization) {
    const monthlyNetworkMB = normalizeToMonth(r.utilization.networkInMB, r.utilization.period);
    if (monthlyNetworkMB < cfg.lbIdleTrafficMB) idle = true;
  }
  if (!idle) return null;
  const monthlyCost = getMonthlyCost(r);
  const savings = monthlyCost > 0 ? monthlyCost : ALB_BASE_HOURLY * HOURS_PER_MONTH;
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'LB-002',
    resourceId: r.id,
    resourceType: r.type,
    title: `Idle load balancer ${r.name} has no healthy targets`,
    description: `Load balancer ${r.name} has no healthy registered targets and negligible network traffic. It continues to accrue hourly charges (~$16/mo base) with no useful work.`,
    reasoning: `A load balancer with zero healthy targets serves no traffic. The ALB fixed charge of $${ALB_BASE_HOURLY}/hr applies regardless of traffic or target health. If this state persists for 7+ days, the load balancer is idle.`,
    impact: 'medium',
    risk: 'low',
    estimatedSavings: guardSavings(savings),
    suggestedAction: 'delete',
    confidence: clampConfidence(confidenceFromUtilization(0.9, r.utilization)),
    filePath,
    currentConfig: { healthy_target_count: 0, type: r.type },
    suggestedConfig: { action: 'delete' },
    patchContent: `# Delete idle load balancer ${sanitizeResourceName(r.name)}\n# aws elbv2 delete-load-balancer --load-balancer-arn ${sanitizeResourceName(r.arn)}`,
    implementationSteps: [
      'Verify no deployments are pending that would register new targets',
      'Delete associated listeners, target groups, and security group rules',
      filePath ? `Remove the aws_lb resource from ${filePath}` : 'Remove the aws_lb resource from Terraform',
      'Run terraform plan to verify, then terraform apply',
    ],
  };
}

/** ELB-002: Classic Load Balancer in use. */
export function checkELB002(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'classic_load_balancer') return null;
  const monthlyCost = getMonthlyCost(r);
  const savings = monthlyCost * cfg.elbClassicToALBMultiplier;
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'ELB-002',
    resourceId: r.id,
    resourceType: r.type,
    title: `Migrate Classic Load Balancer ${r.name} to ALB or NLB`,
    description: `Classic Load Balancer ${r.name} is previous-generation. AWS recommends migrating to Application Load Balancer (ALB) or Network Load Balancer (NLB) for better performance and features.`,
    reasoning: 'Classic Load Balancers lack HTTP/2, WebSocket, and path/host-based routing. ALB offers better LCU efficiency for modern workloads. AWS is phasing out CLB for new features.',
    impact: 'medium',
    risk: 'medium',
    estimatedSavings: guardSavings(savings),
    suggestedAction: 'migrate_to_alb',
    confidence: clampConfidence(0.85),
    filePath,
    currentConfig: { lb_type: 'classic' },
    suggestedConfig: { lb_type: 'application' },
    patchContent: '  # Replace aws_elb with aws_lb (type = "application") and aws_lb_target_group',
    implementationSteps: [
      'Create a new ALB with equivalent listener configuration',
      'Register existing targets in a new target group',
      'Update DNS to point to the new ALB',
      filePath ? `Replace aws_elb with aws_lb in ${filePath}` : 'Replace aws_elb with aws_lb in Terraform',
      'Delete the Classic Load Balancer after traffic cutover',
      'Run terraform plan to verify, then terraform apply',
    ],
  };
}

/** ELB-003: ALB without HTTPS listener. */
export function checkELB003(r: Resource, _cfg: Cfg): Recommendation | null {
  if (r.type !== 'load_balancer' && r.type !== 'alb') return null;
  const lbType = strConfig(r, 'lb_type');
  if (lbType !== 'application' && lbType !== '') return null;
  if (!('has_https_listener' in r.configuration)) return null;
  if (boolConfig(r, 'has_https_listener')) return null;
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'ELB-003',
    resourceId: r.id,
    resourceType: r.type,
    title: `ALB ${r.name} has no HTTPS listener — traffic is unencrypted`,
    description: `Application Load Balancer ${r.name} does not have an HTTPS listener configured. HTTP traffic is transmitted in plaintext.`,
    reasoning: 'HTTPS termination at the ALB protects data in transit. AWS Certificate Manager (ACM) provides free TLS certificates. Serving only HTTP is a security and compliance risk.',
    impact: 'high',
    risk: 'low',
    estimatedSavings: 0,
    suggestedAction: 'add_https_listener',
    confidence: clampConfidence(0.9),
    filePath,
    currentConfig: { has_https_listener: false, lb_type: 'application' },
    suggestedConfig: { has_https_listener: true },
    patchContent: '  # Add aws_lb_listener for port 443 with protocol = "HTTPS" and ACM certificate',
    implementationSteps: [
      'Request or import a certificate into ACM for your domain',
      'Add an HTTPS listener on port 443 pointing to the same target group',
      'Add an HTTP to HTTPS redirect listener on port 80',
      filePath ? `Add aws_lb_listener resources to ${filePath}` : 'Add aws_lb_listener resources in Terraform',
      'Run terraform plan to verify, then terraform apply',
    ],
  };
}

export const elbRules = [checkELB001, checkLB002, checkELB002, checkELB003];
