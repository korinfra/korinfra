/**
 * EC2 and Security Group security rules.
 * Ported from Go internal/terraform/scanner.go EC2/SG section.
 */

import type { SecurityRule } from './types.js';
import { containsCredentialPatterns } from './helpers.js';

// ---------------------------------------------------------------------------
// CIDR / port helpers (mirrors Go hasOpenCIDR / hasOpenPort)
// ---------------------------------------------------------------------------

function checkCIDRBlocks(m: Record<string, unknown>): boolean {
  const isOpenCIDR = (c: unknown): boolean =>
    c === '0.0.0.0/0' || c === '::/0';

  const cidrs = m['cidr_blocks'];
  if (cidrs !== undefined) {
    if (Array.isArray(cidrs) && cidrs.some(isOpenCIDR)) return true;
    if (typeof cidrs === 'string' && isOpenCIDR(cidrs)) return true;
  }

  // Also check IPv6 CIDR blocks for ::/0.
  const ipv6Cidrs = m['ipv6_cidr_blocks'];
  if (ipv6Cidrs !== undefined) {
    if (Array.isArray(ipv6Cidrs) && ipv6Cidrs.some(isOpenCIDR)) return true;
    if (typeof ipv6Cidrs === 'string' && isOpenCIDR(ipv6Cidrs)) return true;
  }

  return false;
}

function toNum(v: unknown): number {
  if (typeof v === 'number') return v;
  return 0;
}

function checkPortAndCIDR(m: Record<string, unknown>, port: number): boolean {
  if (!checkCIDRBlocks(m)) return false;
  const protocol = m['protocol'];
  if (protocol === '-1' || protocol === 'all') return true;
  const from = toNum(m['from_port']);
  const to = toNum(m['to_port']);
  return from <= port && to >= port;
}

function hasOpenCIDR(config: Record<string, unknown>, direction: string): boolean {
  const rules = config[direction];
  if (rules === undefined) {
    const ruleType = config['type'];
    if (ruleType === direction) return checkCIDRBlocks(config);
    return false;
  }
  if (rules !== null && typeof rules === 'object' && !Array.isArray(rules)) {
    return checkCIDRBlocks(rules as Record<string, unknown>);
  }
  if (Array.isArray(rules)) {
    return rules.some(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        checkCIDRBlocks(item as Record<string, unknown>),
    );
  }
  return false;
}

function hasOpenPort(config: Record<string, unknown>, port: number): boolean {
  const rules = config['ingress'];
  if (rules === undefined) {
    const ruleType = config['type'];
    if (ruleType === 'ingress') return checkPortAndCIDR(config, port);
    return false;
  }
  if (rules !== null && typeof rules === 'object' && !Array.isArray(rules)) {
    return checkPortAndCIDR(rules as Record<string, unknown>, port);
  }
  if (Array.isArray(rules)) {
    return rules.some(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        checkPortAndCIDR(item as Record<string, unknown>, port),
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export const ec2Rules: SecurityRule[] = [
  {
    id: 'EC2-SEC-001',
    title: 'EC2 instance without IMDSv2',
    description: 'EC2 instance does not enforce IMDSv2 (Instance Metadata Service v2)',
    severity: 'high',
    resourceTypes: ['aws_instance'],
    evaluate: (res) => {
      const md = res.configuration['metadata_options'];
      if (md === undefined || md === null) return true;
      // hcl2json represents nested blocks as arrays
      const mdObj: unknown = Array.isArray(md) ? md[0] : md;
      if (mdObj !== null && typeof mdObj === 'object') {
        const mdm = mdObj as Record<string, unknown>;
        return mdm['http_tokens'] !== 'required';
      }
      return true;
    },
    recommendation: 'Add metadata_options { http_tokens = "required" }',
  },
  {
    id: 'EC2-SEC-002',
    title: 'EC2 instance with hardcoded credentials',
    description: 'EC2 user_data or configuration may contain hardcoded credentials',
    severity: 'critical',
    resourceTypes: ['aws_instance', 'aws_launch_template'],
    evaluate: (res) => {
      const userData = res.configuration['user_data'];
      return typeof userData === 'string' && containsCredentialPatterns(userData);
    },
    recommendation:
      'Use IAM roles, AWS Secrets Manager, or SSM Parameter Store instead of hardcoded credentials',
  },
  {
    id: 'SG-SEC-001',
    title: 'Security group allows ingress from 0.0.0.0/0',
    description: 'Security group rule allows unrestricted inbound traffic from the internet',
    severity: 'critical',
    resourceTypes: ['aws_security_group', 'aws_security_group_rule'],
    evaluate: (res) => hasOpenCIDR(res.configuration, 'ingress'),
    recommendation:
      'Restrict ingress CIDR blocks to specific IP ranges instead of 0.0.0.0/0',
  },
  {
    id: 'SG-SEC-002',
    title: 'Security group allows SSH from 0.0.0.0/0',
    description: 'SSH (port 22) is open to the entire internet',
    severity: 'critical',
    resourceTypes: ['aws_security_group', 'aws_security_group_rule'],
    evaluate: (res) => hasOpenPort(res.configuration, 22),
    recommendation: 'Restrict SSH access to specific IP ranges or use a bastion host',
  },
  {
    id: 'SG-SEC-003',
    title: 'Security group allows RDP from 0.0.0.0/0',
    description: 'RDP (port 3389) is open to the entire internet',
    severity: 'critical',
    resourceTypes: ['aws_security_group', 'aws_security_group_rule'],
    evaluate: (res) => hasOpenPort(res.configuration, 3389),
    recommendation: 'Restrict RDP access to specific IP ranges or use a VPN',
  },
  {
    id: 'SG-SEC-004',
    title: 'Security group allows all egress',
    description: 'Security group allows unrestricted outbound traffic',
    severity: 'low',
    resourceTypes: ['aws_security_group', 'aws_security_group_rule'],
    evaluate: (res) => hasOpenCIDR(res.configuration, 'egress'),
    recommendation: 'Restrict egress to only required destinations and ports',
  },
  {
    id: 'SG-SEC-005',
    title: 'Security group exposes database port to internet',
    description:
      'Security group allows inbound traffic from 0.0.0.0/0 on a database port ' +
      '(MySQL 3306, PostgreSQL 5432, Redshift 5439, MSSQL 1433, Oracle 1521, ' +
      'MongoDB 27017, Redis 6379, Elasticsearch 9200/9300)',
    severity: 'critical',
    resourceTypes: ['aws_security_group', 'aws_security_group_rule'],
    evaluate: (res) => {
      const dbPorts = [3306, 5432, 5439, 1433, 1521, 27017, 6379, 9200, 9300];
      return dbPorts.some((port) => hasOpenPort(res.configuration, port));
    },
    recommendation:
      'Remove 0.0.0.0/0 ingress on database ports; restrict to specific application security groups or VPC CIDR',
  },
];
