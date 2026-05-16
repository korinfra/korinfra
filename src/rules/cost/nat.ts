/**
 * NAT Gateway cost optimization rules.
 * Ported from Go internal/ai/rules.go (NET-001, NAT-001).
 */

import type { Resource } from '../../aws/types.js';
import type { Recommendation } from '../types.js';
import type { ThresholdsOverride } from '../config.js';
import type { THRESHOLDS } from '../config.js';
import { strConfig, normalizeToMonth, getMonthlyCost, confidenceFromUtilization } from './helpers.js';
import { clampConfidence, guardSavings } from '../../utils/numeric-guards.js';
import { NAT_GATEWAY_HOURLY, NAT_GATEWAY_PER_GB, HOURS_PER_MONTH } from '../../pricing/resources.js';

// NAT Gateway consolidation: merging multiple NAT GWs into one reduces per-AZ charges.
// NAT Gateways charge two separate fees: $0.045/hour (per-AZ hourly charge) AND $0.045/GB (data processing).
// These coincidentally have the same rate but are different charges.
// Estimate: based on eliminating redundant per-AZ hourly charges ($0.045/hr each) when consolidating to fewer NAT GWs.
// This ratio is now tunable via cfg.natGatewayReplacementMultiplier.

type Cfg = typeof THRESHOLDS & ThresholdsOverride;

/** NET-001: Low-traffic NAT Gateway — consider NAT instance. */
export function checkNET001(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'nat_gateway') return null;
  if (!r.utilization) return null;
  const rawMB = r.utilization.networkInMB + r.utilization.networkOutMB;
  const throughputGB = normalizeToMonth(rawMB, r.utilization.period) / 1024.0;
  if (throughputGB >= cfg.natLowTrafficGB) return null;
  const monthlyCost = getMonthlyCost(r);
  const savings = monthlyCost > 0 ? monthlyCost * cfg.natGatewayReplacementMultiplier : NAT_GATEWAY_HOURLY * HOURS_PER_MONTH * cfg.natGatewayReplacementMultiplier;
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'NET-001',
    resourceId: r.id,
    resourceType: r.type,
    title: `Replace NAT Gateway ${r.name} with NAT Instance for low-traffic workloads`,
    description: `NAT Gateway ${r.name} processes only ${throughputGB.toFixed(3)} GB/month. The hourly charge ($${NAT_GATEWAY_HOURLY}/hr) dominates the cost. Savings estimate based on typical traffic patterns; actual savings depend on your workload.`,
    reasoning: `NAT Gateway fixed cost is ~$${(NAT_GATEWAY_HOURLY * HOURS_PER_MONTH).toFixed(0)}/mo. A t3.nano NAT instance costs ~$3.50/mo for ${throughputGB.toFixed(3)} GB/mo traffic (threshold: ${cfg.natLowTrafficGB} GB/mo).`,
    impact: 'medium',
    risk: 'medium',
    estimatedSavings: guardSavings(savings),
    suggestedAction: 'replace_with_nat_instance',
    confidence: clampConfidence(confidenceFromUtilization(0.7, r.utilization)),
    filePath,
    currentConfig: { type: 'nat_gateway', throughput_gb_mo: throughputGB },
    suggestedConfig: { type: 'nat_instance_t3_nano' },
    patchContent: '  # Replace aws_nat_gateway with aws_instance (NAT AMI, t3.nano) and update route table',
    implementationSteps: [
      'Review VPC Flow Logs to measure actual NAT traffic volume before implementing changes',
      'Deploy a t3.nano instance with NAT AMI in the public subnet',
      'Update the route table to point 0.0.0.0/0 to the NAT instance',
      'Delete the NAT Gateway once traffic is confirmed routing correctly',
      filePath ? `Update ${filePath}: replace aws_nat_gateway with aws_instance (NAT AMI)` : 'Replace aws_nat_gateway with aws_instance (NAT AMI) in Terraform',
    ],
  };
}

/** NAT-001: NAT Gateway with very low data — VPC endpoint candidate. */
export function checkNAT001(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'nat_gateway') return null;
  if (!r.utilization) return null;
  const rawMB2 = r.utilization.networkInMB + r.utilization.networkOutMB;
  const throughputGB = normalizeToMonth(rawMB2, r.utilization.period) / 1024.0;
  // NET-001 handles the very-low-traffic case (<natLowTrafficGB); NAT-001 targets
  // gateways with moderate traffic where VPC endpoints could reduce data charges.
  if (throughputGB < cfg.natLowTrafficGB) return null;
  if (throughputGB >= cfg.natEndpointTrafficGB) return null;
  const monthlyCost = getMonthlyCost(r);
  const savings = monthlyCost > 0 ? monthlyCost * cfg.natEndpointSavingsMultiplier : NAT_GATEWAY_HOURLY * HOURS_PER_MONTH * cfg.natEndpointSavingsMultiplier;
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'NAT-001',
    resourceId: r.id,
    resourceType: r.type,
    title: `NAT Gateway ${r.name} has low traffic — add VPC endpoints to eliminate S3/DynamoDB charges`,
    description: `NAT Gateway ${r.name} processes only ${throughputGB.toFixed(1)} GB/month. Adding free VPC Gateway Endpoints for S3 and DynamoDB can significantly reduce NAT charges. Savings estimate based on typical traffic patterns; actual savings depend on your workload.`,
    reasoning: `S3 and DynamoDB VPC Gateway Endpoints are free. Traffic routed through a NAT Gateway to these services costs $${NAT_GATEWAY_PER_GB}/GB. At low volumes the fixed hourly NAT charge ($${NAT_GATEWAY_HOURLY}/hr = ~$32/mo) dominates.`,
    impact: 'medium',
    risk: 'low',
    estimatedSavings: guardSavings(savings),
    suggestedAction: 'add_vpc_endpoints',
    confidence: clampConfidence(confidenceFromUtilization(0.7, r.utilization)),
    filePath,
    currentConfig: { type: 'nat_gateway', throughput_gb_mo: throughputGB },
    suggestedConfig: { add_vpc_endpoints: ['s3', 'dynamodb'] },
    patchContent: '  # Add aws_vpc_endpoint for "s3" and "dynamodb" (gateway type, free)\n  # Update route tables to use the endpoints for those services',
    implementationSteps: [
      'Review VPC Flow Logs to measure actual NAT traffic volume before implementing changes',
      'Add a free S3 VPC Gateway Endpoint: aws_vpc_endpoint { service_name = "com.amazonaws.<region>.s3", vpc_endpoint_type = "Gateway" }',
      'Add a free DynamoDB VPC Gateway Endpoint similarly',
      'Update route tables to include the endpoint routes',
      filePath ? `Add aws_vpc_endpoint resources to ${filePath}` : 'Add aws_vpc_endpoint resources in Terraform',
      'Run terraform plan to verify, then terraform apply',
    ],
  };
}

export const natRules = [checkNET001, checkNAT001];
