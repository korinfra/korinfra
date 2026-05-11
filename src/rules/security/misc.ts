/**
 * Miscellaneous security rules: CloudWatch, Load Balancer, EKS, ECS, tagging, general.
 * Ported from Go internal/terraform/scanner.go remaining rules.
 */

import type { SecurityRule } from './types.js';

export const miscRules: SecurityRule[] = [
  {
    id: 'CW-SEC-001',
    title: 'CloudWatch log group without encryption',
    description: 'CloudWatch log group does not have KMS encryption configured',
    severity: 'medium',
    resourceTypes: ['aws_cloudwatch_log_group'],
    evaluate: (res) => !('kms_key_id' in res.configuration),
    recommendation: 'Set kms_key_id to encrypt log data at rest',
  },
  {
    id: 'CW-SEC-002',
    title: 'CloudWatch log group without retention',
    description: 'CloudWatch log group has no retention policy (logs kept forever)',
    severity: 'medium',
    resourceTypes: ['aws_cloudwatch_log_group'],
    evaluate: (res) => {
      const retention = res.configuration['retention_in_days'];
      if (retention === undefined) return true;
      if (typeof retention === 'number') return retention === 0;
      return true;
    },
    recommendation:
      'Set retention_in_days to an appropriate value (e.g., 90 or 365)',
  },
  {
    id: 'LB-SEC-001',
    title: 'Load balancer without access logging',
    description:
      'Application/Network Load Balancer does not have access logging enabled',
    severity: 'medium',
    resourceTypes: ['aws_lb', 'aws_alb'],
    evaluate: (res) => {
      const al = res.configuration['access_logs'];
      if (al === undefined) return true;
      const alObj: unknown = Array.isArray(al) ? al[0] : al;
      if (alObj !== null && typeof alObj === 'object') {
        return (alObj as Record<string, unknown>)['enabled'] !== true;
      }
      return true;
    },
    recommendation:
      'Enable access logs with access_logs { enabled = true, bucket = "..." }',
  },
  {
    id: 'LB-SEC-002',
    title: 'Load balancer listener using HTTP',
    description: 'Load balancer listener is using HTTP instead of HTTPS',
    severity: 'high',
    resourceTypes: ['aws_lb_listener', 'aws_alb_listener'],
    evaluate: (res) => {
      const protocol = res.configuration['protocol'];
      return typeof protocol === 'string' && protocol.toLowerCase() === 'http';
    },
    recommendation: 'Use HTTPS protocol with a valid SSL certificate',
  },
  {
    id: 'EKS-SEC-001',
    title: 'EKS cluster endpoint publicly accessible',
    description: 'EKS cluster API endpoint is accessible from the public internet',
    severity: 'high',
    resourceTypes: ['aws_eks_cluster'],
    evaluate: (res) => {
      const vpc = res.configuration['vpc_config'];
      if (vpc === undefined) return false; // can't determine endpoint status without vpc_config
      const vpcObj: unknown = Array.isArray(vpc) ? vpc[0] : vpc;
      if (vpcObj !== null && typeof vpcObj === 'object') {
        return (vpcObj as Record<string, unknown>)['endpoint_public_access'] === true;
      }
      return true;
    },
    recommendation:
      'Set endpoint_public_access = false or restrict with public_access_cidrs',
  },
  {
    id: 'ECS-SEC-001',
    title: 'ECS task definition without read-only root filesystem',
    description:
      'ECS container definitions do not enforce a read-only root filesystem',
    severity: 'medium',
    resourceTypes: ['aws_ecs_task_definition'],
    evaluate: (res) => {
      const defs = res.configuration['container_definitions'];
      if (typeof defs !== 'string') return true;
      try {
        const parsed: unknown = JSON.parse(defs);
        const containers = Array.isArray(parsed) ? parsed : [parsed];
        return containers.some((c: unknown) => {
          if (c === null || typeof c !== 'object') return true;
          return !(c as Record<string, unknown>)['readonlyRootFilesystem'];
        });
      } catch {
        return true; // can't parse = flag it
      }
    },
    recommendation: 'Set readonlyRootFilesystem = true in container definitions',
  },
  {
    id: 'EC2-SEC-004',
    title: 'EC2 instance uses deprecated instance type',
    description:
      'Instance uses a previous generation type (t1, m1, m2, c1, t2, m3, c3, r3, m4, c4, r4)',
    severity: 'medium',
    resourceTypes: ['aws_instance'],
    evaluate: (res) => {
      const it = res.configuration['instance_type'];
      if (typeof it !== 'string' || !it) return false;
      const prefixes = [
        't1.', 'm1.', 'm2.', 'c1.', 'cc1.', 'cc2.', 'cg1.', 'cr1.', 'hi1.', 'hs1.',
        't2.', 'm3.', 'c3.', 'r3.', 'i2.', 'd2.', 'g2.',
        'm4.', 'c4.', 'r4.',
      ];
      return prefixes.some((p) => it.startsWith(p));
    },
    recommendation:
      'Upgrade to current generation instance type for better price/performance',
  },
  {
    id: 'TAG-SEC-001',
    title: 'Resource missing required tags',
    description: 'Resource is missing required tags (Environment, Team, Project)',
    severity: 'low',
    resourceTypes: ['aws_instance', 'aws_db_instance', 'aws_s3_bucket', 'aws_lb'],
    evaluate: (res) => {
      const tags = res.configuration['tags'];
      if (tags === undefined) return true;
      if (tags === null || typeof tags !== 'object' || Array.isArray(tags)) return true;
      const tagMap = tags as Record<string, unknown>;
      const required = ['Environment', 'Team', 'Project'];
      return required.some((req) => !(req in tagMap));
    },
    recommendation:
      'Add required tags (Environment, Team, Project) for cost allocation and resource identification',
  },
  {
    id: 'SSM-SEC-001',
    title: 'SSM Parameter with sensitive name stored as plaintext',
    description:
      'aws_ssm_parameter name suggests sensitive data (password, secret, key, token, credential) ' +
      'but type is not SecureString — value is stored unencrypted and visible in the AWS console without KMS protection',
    severity: 'high',
    resourceTypes: ['aws_ssm_parameter'],
    evaluate: (res) => {
      const t = res.configuration['type'];
      if (t === 'SecureString') return false;
      const name = String((res.configuration['name'] as string | null | undefined) ?? res.address ?? '').toLowerCase();
      const sensitivePatterns = ['password', 'secret', 'key', 'token', 'credential', 'api_key', 'apikey', 'passwd'];
      return sensitivePatterns.some((p) => name.includes(p));
    },
    recommendation:
      'Change type to "SecureString" and optionally specify key_id for a customer-managed KMS key',
  },
  {
    id: 'GEN-SEC-001',
    title: 'Resource without tags',
    description: 'Resource does not have any tags configured',
    severity: 'low',
    resourceTypes: [
      'aws_instance',
      'aws_db_instance',
      'aws_s3_bucket',
      'aws_lb',
      'aws_lambda_function',
    ],
    evaluate: (res) => !('tags' in res.configuration),
    recommendation:
      'Add tags for cost allocation, ownership tracking, and compliance',
  },
];
