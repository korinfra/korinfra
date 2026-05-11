/**
 * Network security rules.
 * Ported from Go internal/terraform/scanner.go NET section.
 */

import type { SecurityRule } from './types.js';

export const networkRules: SecurityRule[] = [
  {
    id: 'NET-SEC-001',
    title: 'VPC may not have flow logs enabled',
    description:
      'VPC may not have flow logs enabled — verify manually (aws_flow_log resource not detected in scan)',
    severity: 'low',
    resourceTypes: ['aws_vpc'],
    // Check configuration fields that indicate flow log status. When these fields
    // are absent (Terraform VPC resources rarely include them) we flag
    // conservatively — callers can suppress when an aws_flow_log resource is
    // present in the same scan batch. Severity is kept 'low' because this check
    // requires VPC flow log data that may not be collected.
    evaluate: (res, allResources) => {
      if (res.configuration['flow_log_enabled'] === true) return false;
      if (res.configuration['has_flow_log'] === true) return false;
      // Suppress if an aws_flow_log resource references this VPC in the same scan
      if (allResources) {
        const vpcId = res.address;
        const hasFlowLog = allResources.some(r => {
          if (r.type !== 'aws_flow_log') return false;
          const ref = String((r.configuration['vpc_id'] as string | null | undefined) ?? '');
          // Exact match or reference like "aws_vpc.main.id" / "aws_vpc.main[0].id"
          return ref === vpcId || ref.startsWith(vpcId + '.') || ref.startsWith(vpcId + '[');
        });
        if (hasFlowLog) return false;
      }
      return true;
    },
    recommendation: 'Enable VPC flow logs for network monitoring and security auditing',
  },
  {
    id: 'NET-SEC-002',
    title: 'Subnet with public IP auto-assign enabled',
    description: 'Subnet automatically assigns public IPs to launched instances',
    severity: 'medium',
    resourceTypes: ['aws_subnet'],
    evaluate: (res) => res.configuration['map_public_ip_on_launch'] === true,
    recommendation:
      'Set map_public_ip_on_launch = false unless public subnet is intentional',
  },
];
